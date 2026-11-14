export default {
  async email(message, env) {
    let recipients;
    try {
      recipients = JSON.parse(env.MEDIA_FANOUT_RECIPIENTS_JSON);
    } catch {
      throw new Error("Media forwarding configuration is invalid.");
    }
    const address = env.MEDIA_FANOUT_ADDRESS;
    if (
      typeof address !== "string" || !address.includes("@") ||
      !Array.isArray(recipients) || recipients.length === 0 ||
      !recipients.every((value) => typeof value === "string" && value.includes("@"))
    ) {
      throw new Error("Media forwarding configuration is invalid.");
    }

    if (message.to.toLowerCase() !== address) {
      message.setReject(`This handler accepts ${address} only.`);
      return;
    }

    let failures = 0;
    for (const recipient of recipients) {
      try {
        await message.forward(recipient);
      } catch {
        failures += 1;
      }
    }
    // Attempt every destination before reporting a failure. Never log message
    // content, sender, headers, or the provider's potentially sensitive error.
    if (failures > 0) {
      throw new Error(`Media forwarding failed for ${failures} destination(s).`);
    }
  },
};
