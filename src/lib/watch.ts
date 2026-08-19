import type { Vessel } from "./sources/ais";

/**
 * Watch mode: keep looking at one structure and say something when a vessel that
 * could take it down comes past.
 *
 * The loop runs in the browser rather than on the server, and that is a platform
 * fact rather than a preference — this deploys to functions that are killed in
 * about twenty seconds, so there is nowhere server-side for a subscription to
 * live between requests. Each tick is one ordinary /api/vessels call, which is
 * already a bounded collection window, so a watch is a sequence of six-second
 * listens rather than one long one. That is honest about what it can miss and it
 * survives the tab being closed, which a server socket with no supervisor
 * would not.
 *
 * ponytail: polling from the open tab. A watch that has to survive the tab
 * closing needs a worker with its own store, which is a different product.
 */

/** One tick per minute: a ship covers ~300 m in that time at 10 kn. */
export const WATCH_INTERVAL_MS = 60_000;

/**
 * What counts as worth interrupting someone for. The Dali was 300 m and making
 * about 8 knots; a pier absorbs momentum, so length and way through the water
 * are the two things in AIS that bear on it. Below this a strike is a repair
 * bill rather than a collapse.
 */
export const MIN_LENGTH_M = 100;
export const MIN_SPEED_KN = 2;

export const ALERT_RULE = `vessel over ${MIN_LENGTH_M} m making way (${MIN_SPEED_KN} kn or more)`;

export interface VesselAlert {
  /** MMSI plus first-sighting time: a second visit by the same ship is a second alert. */
  id: string;
  mmsi: number;
  name: string;
  type?: string;
  lengthM?: number;
  draughtM?: number;
  destination?: string;
  /** Readings from the most recent tick this vessel appeared in. */
  speedKn: number | null;
  distanceM: number;
  nodeId: string;
  nodeName: string;
  firstSeen: string;
  lastSeen: string;
  /** False once a tick goes by without this vessel. It has passed. */
  open: boolean;
}

/** A vessel large enough and moving fast enough to matter to a pier. */
export const ofConcern = (v: Vessel) =>
  (v.lengthM ?? 0) >= MIN_LENGTH_M && (v.speedKn ?? 0) >= MIN_SPEED_KN;

/**
 * Fold one tick's vessels into the alert log.
 *
 * The rule that matters here is what counts as the same event. A ship under way
 * appears in tick after tick, and one alert per tick would bury the panel in
 * fifteen copies of one passage. So an alert stays open and updates while its
 * vessel keeps appearing, closes when a tick goes by without it, and a
 * reappearance later opens a new one — because a ship that left and came back
 * really is a second approach.
 *
 * Pure, and returns what it opened, so the caller can react to a new alert
 * without diffing the list itself.
 */
export function mergeAlerts(
  existing: VesselAlert[],
  vessels: Vessel[],
  node: { id: string; name: string },
  now: string,
): { alerts: VesselAlert[]; opened: VesselAlert[] } {
  const alerts = existing.map((a) => ({ ...a }));
  const opened: VesselAlert[] = [];
  const seen = new Set<number>();

  for (const v of vessels.filter(ofConcern)) {
    seen.add(v.mmsi);
    const live = alerts.find((a) => a.mmsi === v.mmsi && a.nodeId === node.id && a.open);

    if (live) {
      live.lastSeen = now;
      live.speedKn = v.speedKn;
      live.distanceM = v.distanceM;
      // Static data can arrive on a later tick than the first position report.
      live.lengthM ??= v.lengthM;
      live.draughtM ??= v.draughtM;
      live.type ??= v.type;
      live.destination ??= v.destination;
      continue;
    }

    const alert: VesselAlert = {
      id: `${v.mmsi}@${now}`,
      mmsi: v.mmsi,
      name: v.name,
      type: v.type,
      lengthM: v.lengthM,
      draughtM: v.draughtM,
      destination: v.destination,
      speedKn: v.speedKn,
      distanceM: v.distanceM,
      nodeId: node.id,
      nodeName: node.name,
      firstSeen: now,
      lastSeen: now,
      open: true,
    };
    alerts.unshift(alert);
    opened.push(alert);
  }

  for (const a of alerts) {
    if (a.open && a.nodeId === node.id && !seen.has(a.mmsi)) a.open = false;
  }

  // The log is a demo surface, not a record. Twenty passages is more than
  // anyone reads and keeps a long watch from growing without bound.
  return { alerts: alerts.slice(0, 20), opened };
}
