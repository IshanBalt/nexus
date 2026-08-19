import { bboxAround, haversine } from "../geo";

/**
 * Live vessel traffic from aisstream.io, for the water side of a bridge's
 * exposure.
 *
 * Deliberately not a tool the agent can call. aisstream is a subscription, not a
 * request: there is no "give me what is here now" endpoint, only a socket that
 * pushes positions as they are broadcast, so reading it means holding a
 * collection window open. `TOOL_BUDGET_MS` in agent.ts is 11 seconds for the
 * whole turn and is checked between turns rather than enforced per call, so a
 * six-second window inside `runTool` would spend most of the budget and starve
 * the cascade simulation in the same question — which is precisely the half of
 * the answer that makes this worth building. It is fetched out of band by
 * /api/vessels instead and handed to the model as context, the same treatment
 * `survey_area` already gets.
 */

const STREAM_URL = "wss://stream.aisstream.io/v0/stream";

/**
 * How long to listen. Class A transponders broadcast a position every 2-10
 * seconds under way, every 3 minutes at anchor, so six seconds catches moving
 * traffic — the traffic that can hit a pier — and misses some of the moored.
 * That bias is the right one here and is stated in the summary the model reads.
 */
const WINDOW_MS = Number(process.env.NEXUS_AIS_WINDOW_MS ?? 6_000);

/** Radius of the subscription box. About a minute of steaming for a loaded ship. */
const DEFAULT_RADIUS_M = 1_500;

export const hasAisKey = () => Boolean(process.env.AISSTREAM_API_KEY);

export interface Vessel {
  mmsi: number;
  name: string;
  lat: number;
  lng: number;
  /** Metres from the structure. */
  distanceM: number;
  /** Speed over ground in knots, null where the transponder reported none. */
  speedKn: number | null;
  /** Course over ground in degrees, null where not available. */
  courseDeg: number | null;
  /** Overall length in metres, from the reported AIS dimensions. */
  lengthM?: number;
  draughtM?: number;
  /** Plain-language vessel class from the AIS type code. */
  type?: string;
  destination?: string;
}

export interface VesselTraffic {
  vessels: Vessel[];
  windowSeconds: number;
  fetchedAt: string;
  /** Why the picture may be incomplete. Surfaced, never swallowed. */
  gap?: string;
  /** Structure this window was collected around, echoed back by the route. */
  near?: string;
}

/** AIS type codes are banded by tens; the band is what matters here. */
function shipType(code: number | undefined): string | undefined {
  if (code == null || code <= 0) return undefined;
  if (code >= 80) return "tanker";
  if (code >= 70) return "cargo";
  if (code >= 60) return "passenger";
  if (code >= 50) return "tug or workboat";
  if (code >= 40) return "high-speed craft";
  if (code === 30) return "fishing";
  if (code === 31 || code === 32 || code === 52) return "tug";
  if (code === 36 || code === 37) return "pleasure craft";
  return "other";
}

/** AIS pads text fields to a fixed width with "@". */
const unpad = (s: unknown): string =>
  typeof s === "string" ? s.replace(/@+/g, " ").trim() : "";

interface AisMessage {
  MessageType?: string;
  MetaData?: { MMSI?: number; ShipName?: string; latitude?: number; longitude?: number };
  Message?: {
    PositionReport?: { Sog?: number; Cog?: number };
    ShipStaticData?: {
      Name?: string;
      Type?: number;
      Dimension?: { A?: number; B?: number };
      MaximumStaticDraught?: number;
      Destination?: string;
    };
  };
}

/**
 * Fold one stream message into the running set, keyed by MMSI.
 *
 * A ship's identity arrives on a different message from its position — static
 * data (name, type, size, destination) every six minutes, positions every few
 * seconds — so the two have to be merged rather than chosen between, and either
 * can arrive first. Position comes from `MetaData`, which carries it on both
 * message types; that is what keeps this a merge and not a state machine.
 *
 * Exported for the self-check in ais.test.ts.
 */
export function mergeAisMessage(
  seen: Map<number, Vessel>,
  msg: AisMessage,
  lat: number,
  lng: number,
): void {
  const meta = msg.MetaData;
  const mmsi = meta?.MMSI;
  if (typeof mmsi !== "number" || typeof meta?.latitude !== "number" || typeof meta?.longitude !== "number") {
    return;
  }

  const v: Vessel = seen.get(mmsi) ?? {
    mmsi,
    name: unpad(meta.ShipName) || `MMSI ${mmsi}`,
    lat: meta.latitude,
    lng: meta.longitude,
    distanceM: 0,
    speedKn: null,
    courseDeg: null,
  };

  v.lat = meta.latitude;
  v.lng = meta.longitude;
  v.distanceM = Math.round(haversine(lat, lng, v.lat, v.lng));

  const pos = msg.Message?.PositionReport;
  if (pos) {
    // 102.3 kn and 360° are the AIS codes for "not available", not readings.
    if (typeof pos.Sog === "number" && pos.Sog < 102.3) v.speedKn = pos.Sog;
    if (typeof pos.Cog === "number" && pos.Cog < 360) v.courseDeg = pos.Cog;
  }

  const stat = msg.Message?.ShipStaticData;
  if (stat) {
    const name = unpad(stat.Name);
    if (name) v.name = name;
    v.type = shipType(stat.Type) ?? v.type;
    // Dimensions are metres from the transponder to bow (A) and stern (B).
    const len = (stat.Dimension?.A ?? 0) + (stat.Dimension?.B ?? 0);
    if (len > 0) v.lengthM = len;
    if (stat.MaximumStaticDraught) v.draughtM = stat.MaximumStaticDraught;
    const dest = unpad(stat.Destination);
    if (dest) v.destination = dest;
  }

  seen.set(mmsi, v);
}

/**
 * Listen for `WINDOW_MS` around a point and return what was broadcasting.
 *
 * Never throws past this boundary: a missing key, a refused socket and an empty
 * channel are all findings the panel and the model should see stated, and the
 * caller has no better handling for them than reporting them. Follows the same
 * contract as fetchOsm.
 */
export async function fetchVesselTraffic(
  lat: number,
  lng: number,
  radiusM: number = DEFAULT_RADIUS_M,
): Promise<VesselTraffic> {
  const fetchedAt = new Date().toISOString();
  const empty = (gap: string): VesselTraffic => ({
    vessels: [],
    windowSeconds: 0,
    fetchedAt,
    gap,
  });

  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) {
    return empty(
      "Live vessel traffic is not configured (AISSTREAM_API_KEY unset), so nothing can be said about what is on the water right now.",
    );
  }
  if (typeof WebSocket === "undefined") {
    // ponytail: Node 22 or newer has a global WebSocket. Add `ws` if a deploy
    // target ever runs older than that.
    return empty("This runtime has no WebSocket, so live vessel traffic could not be fetched.");
  }

  const [w, s, e, n] = bboxAround(lat, lng, radiusM);
  const seen = new Map<number, Vessel>();

  return new Promise<VesselTraffic>((resolve) => {
    let settled = false;
    let gap: string | undefined;
    const started = Date.now();
    const ws = new WebSocket(STREAM_URL);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closing; the result is unaffected.
      }
      const vessels = [...seen.values()].sort((a, b) => a.distanceM - b.distanceM).slice(0, 20);
      resolve({
        vessels,
        // Elapsed, not intended: a window cut short by a dropped connection
        // heard less than it planned to, and the reader needs to know that.
        windowSeconds: Math.round((Date.now() - started) / 1000),
        fetchedAt,
        gap:
          gap ??
          (vessels.length
            ? undefined
            : "No vessel broadcast in this window. Three things look identical from here and none can be ruled out: no traffic, no shore receiver in VHF range (aisstream relays crowd-sourced receivers, not satellites), or an accepted key whose account is not yet streaming — a subscription that authenticates but delivers nothing is silent in exactly this way. Do not read this as an empty channel."),
      });
    };

    const timer = setTimeout(finish, WINDOW_MS);

    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          // Two opposite corners, each [lat, lng].
          BoundingBoxes: [[[n, w], [s, e]]],
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }),
      );

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as AisMessage & { error?: string };
        // A rejected key comes back as a normal message, not a socket error.
        if (msg.error) {
          gap = `aisstream rejected the subscription: ${msg.error}`;
          finish();
          return;
        }
        mergeAisMessage(seen, msg, lat, lng);
      } catch {
        // One malformed frame is not worth losing the rest of the window over.
      }
    };

    ws.onerror = () => {
      gap ??= "The connection to aisstream failed, so live vessel traffic is unavailable here.";
      finish();
    };

    ws.onclose = (ev: CloseEvent) => {
      if (!settled && ev.code !== 1000) {
        gap ??= `aisstream closed the connection (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}).`;
      }
      finish();
    };
  });
}
