import { bboxAround } from "./geo";
import { buildGraph } from "./graph";
import * as mireye from "./mireye";
import { fetchOsm } from "./sources/osm";
import type { KnowledgeGraph, Source } from "./types";

export interface ResolvedPlace {
  lat: number;
  lng: number;
  label: string;
  county?: string | null;
  state?: string | null;
  /** Candidate list when the input was ambiguous. */
  candidates?: { label: string; lat: number; lng: number }[];
}

const COORD = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Resolve free text, an address, or "lat,lng" to a point.
 *
 * Mireye's /v1/lookup is authoritative for US addresses and parcels; Nominatim
 * covers place names and landmarks it does not index ("Yellowstone", "the Port
 * of Tacoma"), so we try Mireye first and fall through on a no-match.
 */
export async function resolvePlace(input: string): Promise<ResolvedPlace> {
  const coord = input.match(COORD);
  if (coord) {
    return { lat: Number(coord[1]), lng: Number(coord[2]), label: input.trim() };
  }

  if (mireye.hasMireyeKey()) {
    try {
      const res = await mireye.lookup(input, false);
      if (res.disposition === "resolved" && res.lat != null && res.lng != null) {
        return {
          lat: res.lat,
          lng: res.lng,
          label: res.resolved_address ?? input,
          county: res.county,
          state: res.state,
        };
      }
      if (res.disposition === "clarify" && res.candidates?.length) {
        const top = res.candidates[0];
        return {
          lat: top.lat,
          lng: top.lng,
          label: top.resolved_address,
          candidates: res.candidates.map((c) => ({
            label: c.resolved_address,
            lat: c.lat,
            lng: c.lng,
          })),
        };
      }
    } catch {
      // Fall through to Nominatim rather than failing the whole request.
    }
  }

  return nominatim(input);
}

async function nominatim(input: string): Promise<ResolvedPlace> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", input);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "3");
  url.searchParams.set("countrycodes", "us");

  const res = await fetch(url, {
    // Nominatim's usage policy requires an identifying User-Agent.
    headers: { "user-agent": "NexusAI/0.1 (physical-world reasoning demo)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Could not resolve "${input}" (geocoder ${res.status})`);

  const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!hits.length) throw new Error(`No location found for "${input}"`);

  return {
    lat: Number(hits[0].lat),
    lng: Number(hits[0].lon),
    label: hits[0].display_name,
    candidates: hits.map((h) => ({
      label: h.display_name,
      lat: Number(h.lat),
      lng: Number(h.lon),
    })),
  };
}

export interface AnalyzeResult {
  place: ResolvedPlace;
  graph: KnowledgeGraph;
  /** Raw Mireye field values, surfaced verbatim in the evidence panel. */
  mireyeFields: Record<string, unknown>;
  timings: Record<string, number>;
}

/** Radius in metres of the analysis window around the query point. */
const DEFAULT_RADIUS = 5000;

export async function analyze(
  place: ResolvedPlace,
  radiusM = DEFAULT_RADIUS,
): Promise<AnalyzeResult> {
  const bbox = bboxAround(place.lat, place.lng, radiusM);
  const started = Date.now();
  const timings: Record<string, number> = {};

  const time = async <T>(name: string, p: Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await p;
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  const keyed = mireye.hasMireyeKey();

  // Every source is independent; run them together so total latency is the
  // slowest one rather than their sum.
  const [osm, lookup, utilities, hazards] = await Promise.allSettled([
    time("osm", fetchOsm(bbox)),
    keyed
      ? time("mireye.lookup", mireye.lookup(`${place.lat},${place.lng}`))
      : Promise.reject(new Error("MIREYE_API_TOKEN not set")),
    keyed
      ? time(
          "mireye.utilities",
          mireye.fetchFields({ lat: place.lat, lng: place.lng, preset: "utilities" }),
        )
      : Promise.reject(new Error("MIREYE_API_TOKEN not set")),
    keyed
      ? time(
          "mireye.hazards",
          mireye.fetchFields({ lat: place.lat, lng: place.lng, preset: "natural_hazard" }),
        )
      : Promise.reject(new Error("MIREYE_API_TOKEN not set")),
  ]);

  const sources: Source[] = [];
  const gaps: { dataset: string; reason: string }[] = [];
  const mireyeFields: Record<string, unknown> = {};

  const osmNodes = osm.status === "fulfilled" ? osm.value.nodes : [];
  if (osm.status === "fulfilled") {
    gaps.push(...osm.value.gaps);
    if (osmNodes.length) {
      sources.push({
        name: "OpenStreetMap (Overpass API)",
        url: `https://www.openstreetmap.org/#map=13/${place.lat.toFixed(4)}/${place.lng.toFixed(4)}`,
        fetchedAt: new Date().toISOString(),
        confidence: "medium",
      });
    }
  } else {
    gaps.push({ dataset: "OpenStreetMap", reason: reasonOf(osm.reason) });
  }

  // Administrative + hazard context from Mireye's lookup.
  const ctx: Parameters<typeof buildGraph>[0]["context"] = {
    county: place.county,
    state: place.state,
  };

  if (lookup.status === "fulfilled" && lookup.value.disposition === "resolved") {
    const l = lookup.value;
    ctx.county = l.county ?? ctx.county;
    ctx.state = l.state ?? ctx.state;
    ctx.population = l.county_market?.population ?? null;
    ctx.medianIncome = l.county_market?.median_household_income_usd ?? null;
    ctx.floodZone = l.fema_flood_zone ?? null;
    ctx.withinFloodplain = l.within_floodplain ?? null;
    ctx.elevationM = l.elevation_m ?? null;
    ctx.coastalHighHazard = l.coastal_high_hazard ?? null;

    Object.assign(mireyeFields, {
      county: l.county,
      state: l.state,
      tract_geoid: l.tract_geoid,
      cbsa: l.cbsa_name,
      elevation_m: l.elevation_m,
      fema_flood_zone: l.fema_flood_zone,
      within_floodplain: l.within_floodplain,
      timezone: l.timezone,
      ...(l.county_market ?? {}),
      ...(l.parcel
        ? {
            parcel_apn: l.parcel.apn,
            parcel_zoning: l.parcel.zoning,
            parcel_land_use: l.parcel.land_use,
            parcel_owner: l.parcel.owner,
            parcel_area_m2: l.parcel.area_m2,
          }
        : {}),
    });

    sources.push({
      name: "Mireye /v1/lookup",
      url: "https://docs.mireye.ai/api-reference/lookup",
      fetchedAt: new Date().toISOString(),
      confidence: l.confidence != null && l.confidence > 0.8 ? "high" : "medium",
    });

    if (l.parcel_unavailable) {
      gaps.push({
        dataset: "Parcel record",
        reason: l.parcel_unavailable_reason ?? "no parcel coverage at this location",
      });
    }
  } else {
    gaps.push({
      dataset: "Mireye /v1/lookup",
      reason: lookup.status === "rejected" ? reasonOf(lookup.reason) : "location not resolved",
    });
  }

  for (const [label, settled] of [
    ["utilities", utilities],
    ["natural hazards", hazards],
  ] as const) {
    if (settled.status === "fulfilled") {
      Object.assign(mireyeFields, mireye.valuesFromFetch(settled.value));
      sources.push(...mireye.sourcesFromFetch(settled.value));
      gaps.push(...mireye.gapsFromFetch(settled.value));
    } else {
      gaps.push({ dataset: `Mireye ${label}`, reason: reasonOf(settled.reason) });
    }
  }

  const graph = buildGraph({
    center: { lat: place.lat, lng: place.lng },
    bbox,
    osmNodes,
    context: ctx,
    sources: dedupeSources(sources),
    gaps,
  });

  timings.total = Date.now() - started;
  return { place, graph, mireyeFields, timings };
}

/**
 * Analyses are expensive (Overpass plus three Mireye calls) and the chat route
 * needs the same graph the map is showing. Keying on the rounded point means a
 * follow-up question reuses the graph instead of rebuilding it.
 *
 * ponytail: per-process Map capped at 24 entries. A shared cache only matters
 * once this runs on more than one instance.
 */
const analyses = new Map<string, AnalyzeResult>();

const cacheKey = (lat: number, lng: number, radiusM: number) =>
  `${lat.toFixed(4)},${lng.toFixed(4)}@${radiusM}`;

export async function getOrAnalyze(
  place: ResolvedPlace,
  radiusM = DEFAULT_RADIUS,
): Promise<AnalyzeResult> {
  const key = cacheKey(place.lat, place.lng, radiusM);
  const hit = analyses.get(key);
  if (hit) return hit;

  const result = await analyze(place, radiusM);
  analyses.set(key, result);
  if (analyses.size > 24) analyses.delete(analyses.keys().next().value!);
  return result;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Map<string, Source>();
  for (const s of sources) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
}
