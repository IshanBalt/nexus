import { centroid } from "../geo";
import type { BBox, GeoNode, Line, NodeKind, Source } from "../types";

/**
 * Mirrors are interchangeable, tried in order. The main instance is first
 * because kumi rate-limits shared cloud IPs hard (observed 429 from a Netlify
 * function while the main instance answered fine).
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/**
 * Public Overpass instances fail independently and unpredictably — in one sample
 * the main instance returned 504 while two mirrors timed out and a fourth
 * answered in 13s.
 *
 * Trying them strictly in sequence does not work inside a serverless time limit.
 * Observed: the first two mirrors each hung until their own timeout, which spent
 * the entire shared budget, so the remaining two were skipped and the request
 * returned an empty graph after 30s. Sequential attempts make the worst case the
 * *sum* of the timeouts, and the worst case is the one that matters.
 *
 * So hedge instead. Start with one mirror; if it has not answered within
 * STAGGER_MS, leave it running and start the next one alongside it. First
 * success wins and the rest are aborted. A healthy mirror answers in five to
 * eight seconds and is never hedged against, which keeps the extra load off
 * volunteer-run infrastructure; a hung one costs a few seconds, not fifteen.
 */
const TOTAL_BUDGET_MS = 15_000;
const PER_ATTEMPT_MS = 13_000;
const STAGGER_MS = 3_500;

/**
 * Overpass rejects anonymous requests with 406 — an identifying User-Agent is
 * required by its usage policy, not optional.
 */
const USER_AGENT = "NexusAI/0.1 (physical infrastructure analysis)";

const OSM_SOURCE = (id: string): Source => ({
  name: "OpenStreetMap",
  url: `https://www.openstreetmap.org/${id}`,
  fetchedAt: new Date().toISOString(),
  confidence: "medium", // community-maintained: excellent coverage, variable completeness
});

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/**
 * Two queries, not one, and not a dozen.
 *
 * Splitting on point-like assets versus the linear network buys two things.
 * Overpass allows two concurrent slots per client, so the halves run at the same
 * time and cost the slower of the two rather than their sum — measured over a
 * dense metro, 13.0s as one query became 4.7s and 2.4s side by side. And each
 * half gets its own element cap: as a single query the cap was reached by the
 * road and rail geometry alone, silently truncating away the hospitals and
 * substations that the dependency rules care about most.
 */
const CAP = 600;

function bboxOf(b: BBox) {
  return `${b[1]},${b[0]},${b[3]},${b[2]}`; // Overpass wants S,W,N,E
}

/** Sited facilities and structures. Small geometries, cheap to evaluate. */
function assetQuery(b: BBox): string {
  const bbox = bboxOf(b);
  return `[out:json][timeout:20];
(
  nw["amenity"~"^(hospital|fire_station|police|school)$"](${bbox});
  nw["power"~"^(plant|substation)$"](${bbox});
  nw["man_made"~"^(water_works|wastewater_plant|pumping_station|communications_tower)$"](${bbox});
  nw["aeroway"="aerodrome"](${bbox});
  way["bridge"]["highway"](${bbox});
);
out geom ${CAP};`;
}

/** The linear network. Long ways, large geometries, the expensive half. */
function networkQuery(b: BBox): string {
  const bbox = bboxOf(b);
  return `[out:json][timeout:20];
(
  way["highway"~"^(motorway|trunk|primary|secondary)$"](${bbox});
  way["railway"="rail"](${bbox});
  way["waterway"~"^(river|stream|canal)$"](${bbox});
  way["power"~"^(line|minor_line)$"](${bbox});
);
out geom ${CAP};`;
}

export async function fetchOsm(
  bbox: BBox,
): Promise<{ nodes: GeoNode[]; gaps: { dataset: string; reason: string }[] }> {
  const halves = await Promise.all([
    hedge(assetQuery(bbox), "sited assets"),
    hedge(networkQuery(bbox), "road, rail and water network"),
  ]);

  const elements = halves.flatMap((h) => h.elements);
  const gaps = halves.flatMap((h) => h.gaps);

  // One half succeeding is a partial answer, not a failure: report the missing
  // half as a gap and build the graph from what did arrive.
  return { nodes: toNodes(elements), gaps };
}

/**
 * Run one query against the mirrors, hedging as described above, and report the
 * failure rather than throwing — a half that fails is a data gap.
 */
async function hedge(
  body: string,
  label: string,
): Promise<{ elements: OverpassElement[]; gaps: { dataset: string; reason: string }[] }> {
  // Every mirror's failure is recorded — reporting only the last one hides
  // which mirror actually rate-limited us.
  const failures: string[] = [];
  // Aborts the losers the moment one mirror answers, so we never hold open
  // connections to three Overpass instances whose results we will discard.
  const done = new AbortController();
  const started = Date.now();

  const attempt = async (url: string): Promise<OverpassElement[]> => {
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(body)}`,
        signal: AbortSignal.any([
          done.signal,
          AbortSignal.timeout(Math.min(PER_ATTEMPT_MS, TOTAL_BUDGET_MS - (Date.now() - started))),
        ]),
      });
      if (!res.ok) throw new Error(`returned ${res.status}`);
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return json.elements ?? [];
    } catch (e) {
      const reason = `${host}: ${e instanceof Error ? e.message : String(e)}`;
      failures.push(reason);
      throw new Error(reason);
    }
  };

  const hedged = ENDPOINTS.map(async (url, i) => {
    if (i > 0) {
      await sleep(Math.min(i * STAGGER_MS, TOTAL_BUDGET_MS), done.signal);
      // A mirror that already won means this one was never needed.
      if (done.signal.aborted) throw new Error("not needed");
    }
    return attempt(url);
  });

  try {
    return { elements: await Promise.any(hedged), gaps: [] };
  } catch {
    return {
      elements: [],
      gaps: [
        {
          dataset: `OpenStreetMap (Overpass) — ${label}`,
          reason: failures.length ? failures.join("; ") : "all mirrors unreachable",
        },
      ],
    };
  } finally {
    done.abort();
  }
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function toNodes(elements: OverpassElement[]): GeoNode[] {
  const out: GeoNode[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;

    let geometry: Line | undefined;
    let lat: number | undefined;
    let lng: number | undefined;

    if (el.geometry?.length) {
      geometry = el.geometry.map((p) => [p.lon, p.lat] as [number, number]);
      const c = centroid(geometry);
      lat = c.lat;
      lng = c.lng;
    } else if (el.lat != null && el.lon != null) {
      lat = el.lat;
      lng = el.lon;
    } else if (el.center) {
      lat = el.center.lat;
      lng = el.center.lon;
    }
    if (lat == null || lng == null) continue;

    out.push({
      id: `osm:${el.type}/${el.id}`,
      kind,
      name: displayName(tags, kind),
      lat,
      lng,
      geometry,
      tags,
      sources: [OSM_SOURCE(`${el.type}/${el.id}`)],
      criticality: criticality(kind, tags),
    });
  }

  return dedupe(out);
}

/**
 * A bridge tag wins over the highway class that carries it: the structure is
 * the failure point, and the road is modelled separately as its own node.
 */
function classify(t: Record<string, string>): NodeKind | null {
  if (t.bridge && t.bridge !== "no" && t.highway) return "bridge";

  switch (t.amenity) {
    case "hospital":
      return "hospital";
    case "fire_station":
      return "fire_station";
    case "police":
      return "police";
    case "school":
      return "school";
  }

  if (t.power === "plant") return "power_plant";
  if (t.power === "substation") return "substation";
  if (t.power === "line" || t.power === "minor_line") return "transmission_line";

  if (t.man_made === "water_works") return "water_treatment";
  if (t.man_made === "wastewater_plant") return "wastewater";
  if (t.man_made === "pumping_station") return "pump_station";
  if (t.man_made === "communications_tower") return "cell_tower";

  if (t.aeroway === "aerodrome") return "airport";
  if (t.railway === "rail") return "rail";
  if (t.waterway) return "waterway";
  if (t.highway) return "road";

  return null;
}

const KIND_LABEL: Record<string, string> = {
  hospital: "Hospital",
  school: "School",
  fire_station: "Fire station",
  police: "Police station",
  power_plant: "Power plant",
  substation: "Substation",
  transmission_line: "Transmission line",
  bridge: "Bridge",
  road: "Road",
  rail: "Rail line",
  airport: "Airport",
  water_treatment: "Water treatment plant",
  wastewater: "Wastewater plant",
  pump_station: "Pump station",
  cell_tower: "Communications tower",
  waterway: "Waterway",
};

function displayName(t: Record<string, string>, kind: NodeKind): string {
  const named = t.name || t.operator || t.ref;
  if (named) return named;
  // An unnamed motorway segment is still identifiable by its class.
  if (kind === "road" && t.highway) return `Unnamed ${t.highway} road`;
  return `Unnamed ${(KIND_LABEL[kind] ?? kind).toLowerCase()}`;
}

/** Baseline loss-if-this-fails, before graph context adjusts it. */
const BASE: Record<NodeKind, number> = {
  hospital: 1.0,
  water_treatment: 0.92,
  power_plant: 0.9,
  substation: 0.85,
  fire_station: 0.8,
  airport: 0.75,
  bridge: 0.7,
  wastewater: 0.7,
  pump_station: 0.65,
  transmission_line: 0.8,
  rail: 0.6,
  police: 0.6,
  school: 0.55,
  cell_tower: 0.5,
  port: 0.75,
  road: 0.5,
  waterway: 0.3,
  shelter: 0.5,
  floodplain: 0.4,
  wildfire_zone: 0.4,
  superfund: 0.3,
  population: 0.2,
  county: 0.2,
  site: 0.5,
};

/** Road class drives how much traffic a link carries, so it drives criticality. */
const ROAD_CLASS: Record<string, number> = {
  motorway: 0.9,
  trunk: 0.8,
  primary: 0.68,
  secondary: 0.52,
  tertiary: 0.4,
};

function criticality(kind: NodeKind, t: Record<string, string>): number {
  let c = BASE[kind] ?? 0.4;

  if (kind === "road" && t.highway) c = ROAD_CLASS[t.highway] ?? c;

  // A bridge inherits the importance of what it carries.
  if (kind === "bridge" && t.highway) {
    c = Math.max(0.55, (ROAD_CLASS[t.highway] ?? 0.5) + 0.12);
  }

  // Bigger hospitals matter more; beds is the only size signal OSM reliably carries.
  if (kind === "hospital" && t.beds) {
    const beds = Number(t.beds);
    if (Number.isFinite(beds) && beds > 200) c = Math.min(1, c + 0.05);
  }

  // Transmission voltage is a direct proxy for how much load a line carries.
  const volts = Number(t.voltage);
  if (Number.isFinite(volts) && volts > 0) {
    if (volts >= 230_000) c = Math.min(1, c + 0.1);
    else if (volts < 50_000) c = Math.max(0.3, c - 0.15);
  }

  return Number(c.toFixed(2));
}

/**
 * OSM frequently splits one real-world feature across many ways (a highway
 * broken at every junction). Collapsing same-name same-kind features keeps the
 * graph readable and stops one road dominating the node count.
 */
function dedupe(nodes: GeoNode[]): GeoNode[] {
  const byKey = new Map<string, GeoNode>();

  for (const n of nodes) {
    const key = `${n.kind}:${n.name}`;
    const existing = byKey.get(key);

    if (!existing || n.name.startsWith("Unnamed")) {
      // Unnamed features are not safely mergeable — keep each one distinct.
      byKey.set(n.name.startsWith("Unnamed") ? n.id : key, n);
      continue;
    }
    // Merge geometry so distance tests see the whole road, not one fragment.
    if (n.geometry && existing.geometry) {
      existing.geometry = [...existing.geometry, ...n.geometry];
      const c = centroid(existing.geometry);
      existing.lat = c.lat;
      existing.lng = c.lng;
    }
    existing.criticality = Math.max(existing.criticality, n.criticality);
  }

  return [...byKey.values()];
}
