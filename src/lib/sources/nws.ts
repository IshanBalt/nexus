import type { Source } from "../types";

/**
 * Active National Weather Service alerts at a point.
 *
 * Federal, real-time, and needs no key — which matters more than it sounds:
 * every other live feed in this project either costs money or, in aisstream's
 * case, authenticates and then sends nothing. This one answers in under a
 * second for any point in the US and carries the government's own severity and
 * urgency fields, so the judgement about how bad something is comes from the
 * issuing office rather than from us.
 */

const BASE = "https://api.weather.gov/alerts/active";
const UA = "NexusAI/0.1 (physical infrastructure analysis; ishanhemanand1@gmail.com)";

export interface WeatherAlert {
  event: string;
  severity: string;
  urgency: string;
  headline: string;
  expires: string | null;
  sender: string;
  url: string;
}

/**
 * Events that bear on a bridge, in the order they bear on it. Everything else
 * the NWS issues is real weather and irrelevant to a structure over water — a
 * heat advisory does not move a pier, so it is not carried into the score and
 * not reported as though it were a threat to the bridge.
 */
const STRUCTURAL = /flood|coastal|storm surge|hurricane|tropical|high wind|wind advisory|gale|marine|tsunami|ice|freeze/i;

export function bearsOnStructure(event: string): boolean {
  return STRUCTURAL.test(event);
}

export const NWS_SOURCE = (lat: number, lng: number): Source => ({
  name: "NWS active alerts",
  url: `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`,
  fetchedAt: new Date().toISOString(),
  confidence: "high", // the issuing office's own words, not an inference
});

/** Never throws: a feed that is down is a gap, and the caller reports gaps. */
export async function fetchAlerts(
  lat: number,
  lng: number,
): Promise<{ alerts: WeatherAlert[]; gap?: string }> {
  try {
    const res = await fetch(`${BASE}?point=${lat.toFixed(4)},${lng.toFixed(4)}`, {
      headers: { "user-agent": UA, accept: "application/geo+json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { alerts: [], gap: `NWS returned ${res.status}` };

    const json = (await res.json()) as {
      features?: { properties?: Record<string, unknown> }[];
    };

    const alerts: WeatherAlert[] = (json.features ?? []).map((f) => {
      const p = f.properties ?? {};
      return {
        event: String(p.event ?? "Alert"),
        severity: String(p.severity ?? "Unknown"),
        urgency: String(p.urgency ?? "Unknown"),
        headline: String(p.headline ?? ""),
        expires: p.expires ? String(p.expires) : null,
        sender: String(p.senderName ?? "National Weather Service"),
        url: String(p["@id"] ?? BASE),
      };
    });

    return { alerts };
  } catch (e) {
    return { alerts: [], gap: `NWS unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
