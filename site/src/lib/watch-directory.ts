import {
  watchDeliveryTypes,
  type WatchDeliveryType,
  type WatchOption,
} from "../data/watch-options";

export type WatchSortKey = "provider" | "area" | "channel" | "delivery";
export type WatchSortDirection = "asc" | "desc";

export interface WatchDirectoryFilters {
  query: string;
  delivery: WatchDeliveryType | "all";
  provider: string;
  area: string;
}

export interface WatchDirectoryState extends WatchDirectoryFilters {
  sort: WatchSortKey;
  direction: WatchSortDirection;
  selectedId: string;
}

export const defaultWatchDirectoryState: WatchDirectoryState = {
  query: "",
  delivery: "all",
  provider: "",
  area: "",
  sort: "provider",
  direction: "asc",
  selectedId: "",
};

const validDeliveryTypes = new Set<WatchDeliveryType>(
  watchDeliveryTypes.map((delivery) => delivery.id),
);
const validSortKeys = new Set<WatchSortKey>(["provider", "area", "channel", "delivery"]);
const deliverySearchText = new Map(
  watchDeliveryTypes.map((delivery) => [
    delivery.id,
    `${delivery.label} ${delivery.abbreviation} ${delivery.description}`,
  ]),
);

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function optionSearchText(option: WatchOption): string {
  return normalize([
    option.provider,
    option.area,
    option.channel,
    option.access,
    option.notes ?? "",
    ...(option.aliases ?? []),
    deliverySearchText.get(option.delivery) ?? option.delivery,
  ].join(" "));
}

export function filterWatchOptions(
  options: readonly WatchOption[],
  filters: WatchDirectoryFilters,
): WatchOption[] {
  const queryTerms = normalize(filters.query).split(" ").filter(Boolean);

  return options.filter((option) => {
    if (filters.delivery !== "all" && option.delivery !== filters.delivery) return false;
    if (filters.provider && option.provider !== filters.provider) return false;
    if (filters.area && option.area !== filters.area) return false;
    const searchText = optionSearchText(option);
    return queryTerms.every((term) => searchText.includes(term));
  });
}

export function sortWatchOptions(
  options: readonly WatchOption[],
  sort: WatchSortKey,
  direction: WatchSortDirection,
): WatchOption[] {
  const multiplier = direction === "asc" ? 1 : -1;
  const deliveryOrder = new Map(watchDeliveryTypes.map((delivery, index) => [delivery.id, index]));

  return [...options].sort((left, right) => {
    let comparison = 0;
    if (sort === "delivery") {
      comparison = (deliveryOrder.get(left.delivery) ?? 0) - (deliveryOrder.get(right.delivery) ?? 0);
    } else {
      comparison = left[sort].localeCompare(right[sort], "en-US", {
        numeric: sort === "channel",
        sensitivity: "base",
      });
    }

    if (comparison === 0) {
      comparison = left.provider.localeCompare(right.provider, "en-US", { sensitivity: "base" });
    }
    if (comparison === 0) comparison = left.id.localeCompare(right.id, "en-US");
    return comparison * multiplier;
  });
}

export function uniqueWatchValues(
  options: readonly WatchOption[],
  field: "provider" | "area",
): string[] {
  return [...new Set(options.map((option) => option[field]))].sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" })
  );
}

export function parseWatchDirectoryState(
  input: string | URLSearchParams,
  options: readonly WatchOption[],
): WatchDirectoryState {
  const params = typeof input === "string"
    ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
    : input;
  const delivery = params.get("watch_delivery") ?? "";
  const sort = params.get("watch_sort") ?? "";
  const direction = params.get("watch_dir") ?? "";
  const provider = params.get("watch_provider") ?? "";
  const area = params.get("watch_area") ?? "";
  const selectedId = params.get("watch_item") ?? "";
  const providers = new Set(options.map((option) => option.provider));
  const areas = new Set(options.map((option) => option.area));
  const ids = new Set(options.map((option) => option.id));

  return {
    query: params.get("watch_q")?.trim() ?? "",
    delivery: validDeliveryTypes.has(delivery as WatchDeliveryType)
      ? delivery as WatchDeliveryType
      : defaultWatchDirectoryState.delivery,
    provider: providers.has(provider) ? provider : "",
    area: areas.has(area) ? area : "",
    sort: validSortKeys.has(sort as WatchSortKey)
      ? sort as WatchSortKey
      : defaultWatchDirectoryState.sort,
    direction: direction === "desc" ? "desc" : "asc",
    selectedId: ids.has(selectedId) ? selectedId : "",
  };
}

export function serializeWatchDirectoryState(
  state: WatchDirectoryState,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(base);
  const values: Record<string, string> = {
    watch_q: state.query.trim(),
    watch_delivery: state.delivery === "all" ? "" : state.delivery,
    watch_provider: state.provider,
    watch_area: state.area,
    watch_sort: state.sort === defaultWatchDirectoryState.sort ? "" : state.sort,
    watch_dir: state.direction === defaultWatchDirectoryState.direction ? "" : state.direction,
    watch_item: state.selectedId,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }

  return params;
}
