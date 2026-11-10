"use strict";

const { fetchAnalyticsJson } = require("./lib/analytics-http");
const CAMPAIGN_LIMIT = 20;
const DAY_MS = 86400000;
const REPORT_FIELDS =
  "id,campaign_title,list_id,emails_sent,send_time,unsubscribed,bounces.hard_bounces,bounces.soft_bounces,opens.unique_opens,clicks.unique_subscriber_clicks";

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid Mailchimp count");
  return value;
}
function boundedText(value) {
  if (typeof value !== "string") throw new Error("Invalid Mailchimp label");
  return value.slice(0, 256);
}
function mailchimpClient(config, fetchFn) {
  const match = /^([a-f0-9]{32})-(us[0-9]{1,3})$/.exec(config.apiKey);
  if (!match || !/^[a-f0-9]{10}$/.test(config.audienceId))
    throw new Error("Invalid Mailchimp configuration");
  const origin = `https://${match[2]}.api.mailchimp.com/3.0`;
  const authorization = `Basic ${Buffer.from(`analytics:${config.apiKey}`).toString("base64")}`;
  return (path, params = {}) =>
    fetchAnalyticsJson(
      `${origin}${path}?${new URLSearchParams(params)}`,
      { method: "GET", headers: { Authorization: authorization } },
      fetchFn,
    );
}
function campaignReport(report, campaign, audienceId, start, end) {
  const sentAt = Date.parse(report.send_time);
  if (
    report.id !== campaign.id ||
    report.list_id !== audienceId ||
    !Number.isFinite(sentAt) ||
    sentAt < start ||
    sentAt >= end
  )
    throw new Error("Mailchimp campaign scope mismatch");
  const sent = count(report.emails_sent);
  const bounces =
    count(report.bounces?.hard_bounces) + count(report.bounces?.soft_bounces);
  if (bounces > sent) throw new Error("Invalid Mailchimp deliveries");
  const delivered = sent - bounces;
  const uniqueClicks = count(report.clicks?.unique_subscriber_clicks);
  const uniqueOpens = count(report.opens?.unique_opens);
  return {
    id: report.id,
    title: boundedText(report.campaign_title),
    sentAt: new Date(sentAt).toISOString(),
    sent,
    delivered,
    bounces,
    uniqueClicks,
    clickRate: delivered ? uniqueClicks / delivered : 0,
    uniqueOpens,
    openRate: delivered ? uniqueOpens / delivered : 0,
    unsubscribes: count(report.unsubscribed),
  };
}

async function fetchMailchimp(days, now, config, fetchFn = fetch) {
  const get = mailchimpClient(config, fetchFn);
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const start = end - days * DAY_MS;
  const listPath = `/lists/${config.audienceId}`;
  const [audience, listing, history] = await Promise.all([
    get(listPath, {
      fields:
        "id,name,stats.member_count,stats.unsubscribe_count,stats.cleaned_count",
    }),
    get("/campaigns", {
      list_id: config.audienceId,
      status: "sent",
      since_send_time: new Date(start).toISOString(),
      before_send_time: new Date(end - 1).toISOString(),
      sort_field: "send_time",
      sort_dir: "DESC",
      count: CAMPAIGN_LIMIT,
      offset: 0,
      fields:
        "campaigns.id,campaigns.recipients.list_id,campaigns.send_time,total_items",
    }),
    get(`${listPath}/growth-history`, {
      count: 12,
      offset: 0,
      sort_field: "month",
      sort_dir: "DESC",
      fields:
        "history.list_id,history.month,history.subscribed,history.unsubscribed,total_items",
    }),
  ]);
  if (
    audience.id !== config.audienceId ||
    !Array.isArray(listing.campaigns) ||
    listing.campaigns.length > CAMPAIGN_LIMIT ||
    !Array.isArray(history.history) ||
    history.history.length > 12
  )
    throw new Error("Invalid Mailchimp response");
  const totalCampaigns = count(listing.total_items);
  if (listing.campaigns.length !== Math.min(CAMPAIGN_LIMIT, totalCampaigns))
    throw new Error("Incomplete Mailchimp campaign listing");
  const ids = new Set();
  for (const campaign of listing.campaigns) {
    const time = Date.parse(campaign.send_time);
    if (
      !/^[a-f0-9]{10}$/.test(campaign.id) ||
      ids.has(campaign.id) ||
      campaign.recipients?.list_id !== config.audienceId ||
      !Number.isFinite(time) ||
      time < start ||
      time >= end
    )
      throw new Error("Mailchimp campaign scope mismatch");
    ids.add(campaign.id);
  }
  const campaigns = [];
  const deadline = Date.now() + 50000;
  // At most five concurrent requests, below Mailchimp's ten-connection limit.
  for (let offset = 0; offset < listing.campaigns.length; offset += 5) {
    if (Date.now() > deadline) throw new Error("Mailchimp analytics timeout");
    const batch = await Promise.all(
      listing.campaigns
        .slice(offset, offset + 5)
        .map(async (campaign) =>
          campaignReport(
            await get(`/reports/${campaign.id}`, { fields: REPORT_FIELDS }),
            campaign,
            config.audienceId,
            start,
            end,
          ),
        ),
    );
    campaigns.push(...batch);
  }
  const totals = {
    sent: 0,
    delivered: 0,
    uniqueClicks: 0,
    clickRate: 0,
    uniqueOpens: 0,
    openRate: 0,
    unsubscribes: 0,
    bounces: 0,
  };
  for (const campaign of campaigns)
    for (const key of [
      "sent",
      "delivered",
      "uniqueClicks",
      "uniqueOpens",
      "unsubscribes",
      "bounces",
    ])
      totals[key] += campaign[key];
  if (totals.delivered) {
    totals.clickRate = totals.uniqueClicks / totals.delivered;
    totals.openRate = totals.uniqueOpens / totals.delivered;
  }
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  const growth = history.history
    .map((row) => {
      if (
        row.list_id !== config.audienceId ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ||
        row.month > currentMonth
      )
        throw new Error("Invalid Mailchimp growth history");
      return {
        month: row.month,
        subscribed: count(row.subscribed),
        unsubscribed: count(row.unsubscribed),
      };
    })
    .filter((row) => row.month < currentMonth)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(growth.map((row) => row.month)).size !== growth.length)
    throw new Error("Duplicate Mailchimp history month");
  return {
    audienceName: boundedText(audience.name),
    period: {
      start: new Date(start).toISOString().slice(0, 10),
      end: new Date(end - DAY_MS).toISOString().slice(0, 10),
      timezone: "UTC",
    },
    audience: {
      subscribed: count(audience.stats?.member_count),
      unsubscribed: count(audience.stats?.unsubscribe_count),
      cleaned: count(audience.stats?.cleaned_count),
    },
    campaigns,
    totalCampaigns,
    truncated: totalCampaigns > campaigns.length,
    totals,
    growth,
    growthPeriod: {
      startMonth: growth[0]?.month || null,
      endMonth: growth.at(-1)?.month || null,
    },
    notes: [
      "Audience totals are current, not a historical snapshot. Archived and pending contacts are not included.",
      "Campaigns were sent during the selected UTC dates. Their results include activity through the latest provider update, not only activity within those dates.",
      "Delivery is sent minus hard and soft bounces. Click and open rates use delivered messages. Clicks count subscribers once per campaign; totals do not deduplicate people across campaigns.",
      "Opens can be inflated by mail privacy features and are not a reliable measure of reading. Automated security scans can also inflate clicks.",
      "Growth shows available completed calendar months from the latest 12 monthly records. Subscribed is the month-end total; unsubscribed counts departures during that month. Missing months are not zero-filled.",
      ...(totalCampaigns > campaigns.length
        ? [
            `Only the latest ${CAMPAIGN_LIMIT} of ${totalCampaigns} sent campaigns are shown. Campaign totals cover these displayed campaigns only.`,
          ]
        : []),
    ],
  };
}
module.exports = { fetchMailchimp };
