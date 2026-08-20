import { NTSB_BRIDGES, NTSB_SOURCE_URL, type NtsbBridge } from "./data/ntsb-bridges";
import { bearsOnStructure, fetchAlerts } from "./sources/nws";
import { fetchRiver } from "./sources/usgs";

/**
 * The standing watch over the structures the NTSB named.
 *
 * Nexus can answer a question about one bridge. That is a tool. This is the
 * part that makes it an agent: it goes over the whole list on its own, decides
 * which structures are worth a human's attention today, and spends the
 * expensive reasoning only on those. Nobody clicks anything to start it.
 *
 * Triage is deliberately deterministic. A language model ranking 59 federal
 * structures by risk would be unauditable and would drift between runs; a
 * documented arithmetic on measured readings can be checked by anyone who
 * disagrees with it, which is the whole standard this project holds itself to.
 * The model is asked only to write, and only about what triage already selected.
 */

/**
 * Every structure here is on the NTSB's list with no current vessel-collision
 * assessment on record. That is a standing condition rather than an event, so
 * it is the floor everything else is measured up from, not a score in itself.
 */
const BASE_CONCERN = 0.2;

/**
 * Weather weights follow the issuing office's own severity field rather than a
 * judgement of our own. A warning is a forecaster saying this is happening.
 */
const WEATHER_WEIGHT: Record<string, number> = {
  Extreme: 0.45,
  Severe: 0.35,
  Moderate: 0.15,
  Minor: 0.05,
};

/**
 * Stage change over 24 hours, in feet. Scour is driven by water moving fast
 * around a pier, and a river coming up is the readable proxy for that. These
 * are thresholds for attention, not engineering limits — the number that would
 * matter is the depth of the hole under the footing, which nobody publishes.
 */
const RISING_HIGH = 2.0;
const RISING_ELEVATED = 0.75;
const RISING_NOTABLE = 0.25;

/** A structure at or above this is put in front of a person. */
export const ESCALATION_THRESHOLD = 0.5;

/**
 * Written briefs per sweep. The ceiling is the free Groq tier — a brief costs
 * two or three model calls against 8000 tokens a minute — so the agent writes
 * about the worst few and leaves the rest as readings. Raising the tier raises
 * this number and nothing else.
 */
export const MAX_BRIEFS_PER_SWEEP = 3;

export interface FleetSignal {
  kind: "weather" | "river";
  level: "notable" | "elevated" | "high";
  headline: string;
  detail: string;
  sourceUrl: string;
  at: string;
  /**
   * What this reading contributed to the score. Carried on the signal itself so
   * the total can be recomputed from what is displayed, instead of being a
   * number the reader has to take on trust.
   */
  weight: number;
}

export interface FleetEntry {
  name: string;
  state: string;
  waterway: string;
  lat: number;
  lng: number;
  /** 0-1. BASE_CONCERN plus whatever the live readings add. */
  score: number;
  signals: FleetSignal[];
  /** Datasets with nothing to say here, and why. Never hidden. */
  gaps: string[];
  /** One line, composed from the signals rather than written by a model. */
  verdict: string;
}

export interface FleetSweep {
  ranAt: string;
  durationMs: number;
  watched: number;
  /** Structures on the list that have no verified coordinate, and why. */
  excluded: { name: string; reason: string }[];
  structures: FleetEntry[];
  /** What triage decided was worth a written brief. */
  escalated: string[];
  sources: { name: string; url: string }[];
}

function scoreOf(signals: FleetSignal[]): number {
  const s = signals.reduce((acc, sig) => acc + sig.weight, BASE_CONCERN);
  return Math.min(1, Number(s.toFixed(2)));
}

/** Assess one structure from live federal readings. */
export async function assessStructure(b: NtsbBridge): Promise<FleetEntry | null> {
  if (b.lat == null || b.lng == null) return null;

  const [weather, river] = await Promise.all([
    fetchAlerts(b.lat, b.lng),
    fetchRiver(b.lat, b.lng, b.waterway),
  ]);

  const signals: FleetSignal[] = [];
  const gaps: string[] = [];
  if (weather.gap) gaps.push(weather.gap);
  if (river.gap) gaps.push(river.gap);

  for (const a of weather.alerts) {
    // Heat advisories are real weather and do nothing to a pier. Carrying them
    // into a structural score would make every summer look like an emergency.
    if (!bearsOnStructure(a.event)) continue;
    const weight = WEATHER_WEIGHT[a.severity] ?? 0.05;
    signals.push({
      kind: "weather",
      level: weight >= 0.35 ? "high" : weight >= 0.15 ? "elevated" : "notable",
      headline: `${a.event} in force`,
      detail: a.headline || `${a.event} (${a.severity}, ${a.urgency}) — ${a.sender}`,
      sourceUrl: a.url,
      at: new Date().toISOString(),
      weight,
    });
  }

  const r = river.reading;
  if (r?.oscillating) {
    // Reported rather than dropped: "the gauge here is tidal" is a fact about
    // what can and cannot be known at this structure, which is the kind of
    // thing this panel exists to say out loud.
    gaps.push(
      `${r.site}: tidal record, ${
        r.rangeFt != null ? `${r.rangeFt.toFixed(2)} ft range` : "swinging"
      } over 24 h — a daily change here is the tide, not a trend, so no scour signal can be read from it`,
    );
  } else if (r?.stageChange24hFt != null && r.stageChange24hFt >= RISING_NOTABLE) {
    const d = r.stageChange24hFt;
    const raw = d >= RISING_HIGH ? 0.3 : d >= RISING_ELEVATED ? 0.18 : 0.08;
    // A gauge on a tributary is a real reading about the wrong water, so it
    // counts for less and says which it is.
    const weight = r.onNamedWaterway ? raw : raw / 2;
    signals.push({
      kind: "river",
      level: d >= RISING_HIGH ? "high" : d >= RISING_ELEVATED ? "elevated" : "notable",
      headline: `${r.onNamedWaterway ? b.waterway : "Nearby gauge"} rising ${d.toFixed(2)} ft in 24 h`,
      detail: `${r.site}: stage ${r.stageFt?.toFixed(2) ?? "?"} ft${
        r.dischargeCfs != null ? `, discharge ${Math.round(r.dischargeCfs).toLocaleString()} cfs` : ""
      }, ${d >= 0 ? "up" : "down"} ${Math.abs(d).toFixed(2)} ft over 24 h${
        r.onNamedWaterway ? "" : " — this gauge is not on the channel the NTSB record names"
      }.`,
      sourceUrl: r.url,
      at: r.at,
      weight,
    });
  } else if (r) {
    gaps.push(
      `${r.site}: stage steady${r.stageFt != null ? ` at ${r.stageFt.toFixed(2)} ft` : ""} over 24 h`,
    );
  }

  const score = scoreOf(signals);
  const worst = signals.slice().sort((a, b2) => b2.weight - a.weight)[0];

  return {
    name: b.name,
    state: b.state,
    waterway: b.waterway,
    lat: b.lat,
    lng: b.lng,
    score,
    signals,
    gaps,
    verdict: worst
      ? `${worst.headline}. On the NTSB list with no vessel-collision assessment on record.`
      : "Nothing live against it today. On the NTSB list with no vessel-collision assessment on record.",
  };
}

/**
 * Sweep the whole fleet.
 *
 * Concurrency is capped because these are public federal endpoints run for
 * everyone's benefit and a hundred simultaneous requests is not how you treat
 * them. Eight at a time gets the sweep done in well under a minute.
 */
export async function sweepFleet(concurrency = 8): Promise<FleetSweep> {
  const started = Date.now();
  const located = NTSB_BRIDGES.filter((b) => b.lat != null && b.lng != null);
  const excluded = NTSB_BRIDGES.filter((b) => b.lat == null).map((b) => ({
    name: b.name,
    reason: b.locationGap ?? "no verified coordinate",
  }));

  const out: FleetEntry[] = [];
  const queue = [...located];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const b = queue.shift();
        if (!b) return;
        const entry = await assessStructure(b);
        if (entry) out.push(entry);
      }
    }),
  );

  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const escalated = out
    .filter((e) => e.score >= ESCALATION_THRESHOLD)
    .slice(0, MAX_BRIEFS_PER_SWEEP)
    .map((e) => e.name);

  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    watched: out.length,
    excluded,
    structures: out,
    escalated,
    sources: [
      { name: "NTSB MIR-25-10", url: NTSB_SOURCE_URL },
      { name: "NWS active alerts", url: "https://api.weather.gov/alerts/active" },
      { name: "USGS instantaneous values", url: "https://waterservices.usgs.gov/nwis/iv/" },
    ],
  };
}
