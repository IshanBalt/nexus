import type { Confidence, Source } from "./types";

const BASE = process.env.MIREYE_BASE_URL ?? "https://api.mireye.com";

export class MireyeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MireyeError";
  }
}

export const hasMireyeKey = () => Boolean(process.env.MIREYE_API_TOKEN);

// ---------------------------------------------------------------------------
// Response shapes (from docs.mireye.ai/api-reference)
// ---------------------------------------------------------------------------

export interface MireyeField {
  value: unknown;
  unit: string | null;
  source: string;
  source_url: string;
  confidence: Confidence;
  fetched_at: string;
  dataset_vintage: string | null;
  ttl_seconds: number;
  notes: string | null;
  status: "ok" | "absent" | "failed";
  error?: string;
  retryable?: boolean;
}

export interface MireyeFetchResponse {
  lat: number;
  lng: number;
  fetched_at: string;
  fields: Record<string, MireyeField>;
  partial_failures?: { field: string; source: string; error: string; retryable: boolean }[];
  resolved_location?: { lat: number; lng: number; source: "coordinate" | "address" };
}

export interface MireyeLookupResponse {
  disposition: "resolved" | "clarify" | "no_match";
  lat?: number | null;
  lng?: number | null;
  resolved_address?: string | null;
  county?: string | null;
  county_fips?: string | null;
  state?: string | null;
  tract_geoid?: string | null;
  cbsa_name?: string | null;
  elevation_m?: number | null;
  fema_flood_zone?: string | null;
  within_floodplain?: boolean | null;
  coastal_high_hazard?: boolean | null;
  timezone?: string | null;
  in_opportunity_zone?: boolean | null;
  county_market?: {
    population: number;
    population_growth_1yr_pct: number;
    net_domestic_migration: number;
    building_permits_total_annual: number;
    building_permits_sf_annual: number;
    building_permits_yoy_pct: number;
    hpi_yoy_pct: number;
    employment_total: number;
    employment_yoy_pct: number;
    median_household_income_usd: number;
  } | null;
  parcel?: {
    parcel_id: string;
    apn: string;
    address: string;
    area_m2: number;
    geometry_wkt?: string;
    owner: string | null;
    zoning: string | null;
    land_use: string | null;
    assessed_value_usd: number | null;
  } | null;
  parcel_unavailable?: boolean;
  parcel_unavailable_reason?: string | null;
  candidates?: { resolved_address: string; lat: number; lng: number; confidence: number }[];
  reason?: string;
  hint?: string | null;
  confidence?: number | null;
}

export interface MireyeAskResponse {
  lat: number;
  lng: number;
  question: string;
  answered_at: string;
  answer: string;
  confidence: Confidence;
  citations: {
    source: string;
    source_url: string;
    fields: string[];
    fetched_at: string;
    confidence: Confidence;
  }[];
  fields_used: string[];
  data_gaps?: { field: string; reason: string }[];
}

export type Preset =
  | "terrain"
  | "flood_risk"
  | "wildfire_underwrite"
  | "land_cover"
  | "site_selection"
  | "building_lookup"
  | "points_of_interest"
  | "utilities"
  | "boundaries"
  | "solar_siting"
  | "wind_siting"
  | "storage_siting"
  | "data_center_siting"
  | "grid_interconnect"
  | "natural_hazard";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Mireye bills per credit and its data changes on dataset-vintage timescales,
 * so an in-process cache keyed on the request body is worth far more than it
 * costs. TTL comes from the response's own ttl_seconds where present.
 *
 * ponytail: per-process Map, so it resets on redeploy and isn't shared across
 * instances. Swap for Redis only if credit burn actually shows up on the bill.
 */
const cache = new Map<string, { at: number; ttlMs: number; body: unknown }>();

async function post<T>(path: string, body: unknown, defaultTtlMs = 3_600_000): Promise<T> {
  const token = process.env.MIREYE_API_TOKEN;
  if (!token) {
    throw new MireyeError("MIREYE_API_TOKEN is not set", 401, false);
  }

  const key = `${path}:${JSON.stringify(body)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.body as T;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    // Mireye is the critical path for a user-facing request; fail fast rather
    // than letting a hung upstream stall the whole analysis.
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MireyeError(
      `Mireye ${path} failed: ${res.status} ${text.slice(0, 300)}`,
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }

  const json = (await res.json()) as T;

  // Honour the shortest per-field TTL the response advertises.
  let ttlMs = defaultTtlMs;
  const fields = (json as { fields?: Record<string, MireyeField> }).fields;
  if (fields) {
    const ttls = Object.values(fields)
      .map((f) => f.ttl_seconds)
      .filter((t): t is number => typeof t === "number" && t > 0);
    if (ttls.length) ttlMs = Math.min(...ttls) * 1000;
  }
  cache.set(key, { at: Date.now(), ttlMs, body: json });
  return json;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Resolve an address, coordinate string, or APN to a fully-enriched place. */
export const lookup = (input: string, includeParcel = true) =>
  post<MireyeLookupResponse>("/v1/lookup", { input, include_parcel: includeParcel });

/** Cited typed values at a point. Pass a preset, explicit fields, or both. */
export function fetchFields(args: {
  lat: number;
  lng: number;
  preset?: Preset;
  fields?: string[];
}): Promise<MireyeFetchResponse> {
  const { lat, lng, preset, fields } = args;
  return post<MireyeFetchResponse>("/v1/fetch", {
    lat,
    lng,
    ...(preset ? { preset } : {}),
    ...(fields?.length ? { fields } : {}),
  });
}

/** Natural-language question answered against Mireye's own data, with citations. */
export const ask = (lat: number, lng: number, question: string) =>
  post<MireyeAskResponse>("/v1/ask", { lat, lng, question });

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Collapse a fetch response's per-field provenance into deduplicated Sources. */
export function sourcesFromFetch(res: MireyeFetchResponse): Source[] {
  const seen = new Map<string, Source>();
  for (const [, f] of Object.entries(res.fields ?? {})) {
    if (f.status === "failed" || !f.source) continue;
    if (seen.has(f.source)) continue;
    seen.set(f.source, {
      name: f.source,
      url: f.source_url,
      fetchedAt: f.fetched_at ?? res.fetched_at,
      confidence: f.confidence ?? "unknown",
      vintage: f.dataset_vintage ?? undefined,
    });
  }
  return [...seen.values()];
}

/** Fields the upstream could not answer, so the UI can show gaps instead of silence. */
export function gapsFromFetch(
  res: MireyeFetchResponse,
): { dataset: string; reason: string }[] {
  const gaps: { dataset: string; reason: string }[] = [];
  for (const [name, f] of Object.entries(res.fields ?? {})) {
    if (f.status === "absent") {
      gaps.push({ dataset: `Mireye: ${name}`, reason: f.notes ?? "no data at this location" });
    } else if (f.status === "failed") {
      gaps.push({ dataset: `Mireye: ${name}`, reason: f.error ?? "fetch failed" });
    }
  }
  for (const pf of res.partial_failures ?? []) {
    gaps.push({ dataset: `Mireye: ${pf.field}`, reason: pf.error });
  }
  return gaps;
}

/** Plain `{ field: value }` view for prompting, dropping absent and failed fields. */
export function valuesFromFetch(res: MireyeFetchResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(res.fields ?? {})) {
    if (f.status === "ok") out[name] = f.unit ? `${f.value} ${f.unit}` : f.value;
  }
  return out;
}
