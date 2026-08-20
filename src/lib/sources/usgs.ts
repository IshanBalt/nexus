import type { Source } from "../types";

/**
 * Live river stage and discharge from USGS, for the water the structure stands
 * in rather than the water it might be hit by.
 *
 * Scour — the current digging the riverbed out from under a pier during high
 * water — takes down more bridges in this country than vessels do. It is the
 * same failure the NTSB list is about, arriving from underneath: a structure
 * designed before anyone modelled it, with no assessment on record. So the same
 * 68 that need a vessel-collision screening are worth watching when their river
 * comes up, and USGS publishes that every fifteen minutes, free, without a key.
 */

const BASE = "https://waterservices.usgs.gov/nwis/iv/";
const UA = "NexusAI/0.1 (physical infrastructure analysis; ishanhemanand1@gmail.com)";

/** Search radius in degrees. USGS caps a bBox at one degree a side. */
const BOX_DEG = 0.12;

const GAUGE_HEIGHT = "00065"; // feet
const DISCHARGE = "00060"; // cubic feet per second

export interface RiverReading {
  site: string;
  siteId: string;
  /** Feet, where the site reports stage. */
  stageFt: number | null;
  /** Cubic feet per second, where the site reports discharge. */
  dischargeCfs: number | null;
  /** Change in stage over the last 24 hours. Positive is rising. */
  stageChange24hFt: number | null;
  /**
   * True where the record swings back and forth rather than trending — a tidal
   * station. Half the gauges near these bridges are tidal, because the bridges
   * are over navigable water, and on a tidal record the 24-hour difference
   * measures which way the tide happened to be running when the window closed.
   * The Bay reads 1.6 ft "rising" twice a day, every day, forever.
   */
  oscillating: boolean;
  /** Peak-to-trough over the window, which is the honest number for a tidal site. */
  rangeFt: number | null;
  at: string;
  /**
   * Whether the gauge is on the water the NTSB record names for this structure.
   * A reading from a tributary two miles away is real and still not this river.
   */
  onNamedWaterway: boolean;
  url: string;
}

export const USGS_SOURCE = (siteId: string): Source => ({
  name: "USGS instantaneous values",
  url: `https://waterdata.usgs.gov/monitoring-location/${siteId}/`,
  fetchedAt: new Date().toISOString(),
  confidence: "high", // a federal gauge reading, measured, not modelled
});

interface TimeSeries {
  sourceInfo: { siteName: string; siteCode: { value: string }[] };
  variable: { variableCode: { value: string }[] };
  values: { value: { value: string; dateTime: string }[] }[];
}

/** Loose match between a gauge's own name and the channel the NTSB names. */
function matchesWaterway(siteName: string, waterway: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\b(river|bay|canal|strait|channel|creek|the)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(siteName);
  const b = norm(waterway);
  if (!a || !b) return false;
  // "Mississippi River at Baton Rouge" against "Mississippi River".
  return b.split(" ").filter((w) => w.length > 3).some((w) => a.includes(w));
}

/**
 * Nearest useful gauge to a point, preferring one actually on the named water.
 * Never throws — no gauge is the common case inland of a tidal crossing, and
 * that is a coverage fact rather than a failure.
 */
export async function fetchRiver(
  lat: number,
  lng: number,
  waterway: string,
): Promise<{ reading: RiverReading | null; gap?: string }> {
  const bbox = [lng - BOX_DEG, lat - BOX_DEG, lng + BOX_DEG, lat + BOX_DEG]
    .map((n) => n.toFixed(4))
    .join(",");
  // A day of values rather than the latest one: a stage means little without
  // knowing which way it is going, and rising is the whole signal for scour.
  const url = `${BASE}?format=json&bBox=${bbox}&parameterCd=${GAUGE_HEIGHT},${DISCHARGE}&period=P1D&siteStatus=active`;

  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { reading: null, gap: `USGS returned ${res.status}` };

    const json = (await res.json()) as { value?: { timeSeries?: TimeSeries[] } };
    const series = json.value?.timeSeries ?? [];
    if (!series.length) return { reading: null, gap: "no USGS gauge within ~13 km" };

    // Group the two parameters back together per site.
    const bySite = new Map<string, { name: string; stage?: TimeSeries; flow?: TimeSeries }>();
    for (const t of series) {
      const id = t.sourceInfo.siteCode[0]?.value;
      if (!id) continue;
      const entry = bySite.get(id) ?? { name: t.sourceInfo.siteName };
      if (t.variable.variableCode[0]?.value === GAUGE_HEIGHT) entry.stage = t;
      else entry.flow = t;
      bySite.set(id, entry);
    }

    const candidates = [...bySite.entries()].map(([id, e]) => ({
      id,
      ...e,
      onNamed: matchesWaterway(e.name, waterway),
    }));
    // The named channel wins; otherwise take whatever gauge is here and label it.
    const pick = candidates.find((c) => c.onNamed && c.stage) ?? candidates.find((c) => c.onNamed) ??
      candidates.find((c) => c.stage) ?? candidates[0];
    if (!pick) return { reading: null, gap: "no USGS gauge within ~13 km" };

    const last = (t?: TimeSeries) => {
      const v = t?.values?.[0]?.value ?? [];
      return v.length ? v[v.length - 1] : null;
    };
    const first = (t?: TimeSeries) => t?.values?.[0]?.value?.[0] ?? null;

    const stageNow = last(pick.stage);
    const stageThen = first(pick.stage);
    const flowNow = last(pick.flow);
    const num = (s?: string | null) => {
      const n = s == null ? NaN : Number(s);
      // USGS writes -999999 for a sensor that is offline.
      return Number.isFinite(n) && n > -999_000 ? n : null;
    };

    const nowFt = num(stageNow?.value);
    const thenFt = num(stageThen?.value);

    /*
     * Net movement against total movement. A river coming up spends the whole
     * window going one way, so nearly all of its travel is net; a tide covers
     * the same ground several times and nets out near zero. Below a third, the
     * 24-hour difference is not a trend and must not be reported as one.
     */
    const stageSeries = (pick.stage?.values?.[0]?.value ?? [])
      .map((v) => num(v.value))
      .filter((n): n is number => n != null);
    let travelled = 0;
    for (let i = 1; i < stageSeries.length; i++) {
      travelled += Math.abs(stageSeries[i] - stageSeries[i - 1]);
    }
    const net = nowFt != null && thenFt != null ? nowFt - thenFt : 0;
    const oscillating = travelled > 0.1 && Math.abs(net) / travelled < 0.35;
    const rangeFt = stageSeries.length
      ? Number((Math.max(...stageSeries) - Math.min(...stageSeries)).toFixed(2))
      : null;

    return {
      reading: {
        site: pick.name,
        siteId: pick.id,
        stageFt: nowFt,
        dischargeCfs: num(flowNow?.value),
        stageChange24hFt: nowFt != null && thenFt != null ? Number((nowFt - thenFt).toFixed(2)) : null,
        oscillating,
        rangeFt,
        at: stageNow?.dateTime ?? flowNow?.dateTime ?? new Date().toISOString(),
        onNamedWaterway: pick.onNamed,
        url: `https://waterdata.usgs.gov/monitoring-location/${pick.id}/`,
      },
    };
  } catch (e) {
    return { reading: null, gap: `USGS unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
