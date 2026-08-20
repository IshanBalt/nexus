import { matchNtsbBridge, type NtsbMatch, NTSB_SOURCE_URL } from "./data/ntsb-bridges";
import { distanceToLine, haversine, linesIntersect, metres } from "./geo";
import type {
  BBox,
  Confidence,
  GeoNode,
  GraphEdge,
  KnowledgeGraph,
  NodeKind,
  Source,
} from "./types";

/** Facilities whose loss degrades a lifeline service, not just convenience. */
const LIFELINE: NodeKind[] = [
  "hospital",
  "fire_station",
  "police",
  "water_treatment",
  "wastewater",
  "pump_station",
  "substation",
  "power_plant",
  "airport",
  "school",
];

/**
 * Distance between a node and a linear feature (road, river, transmission line),
 * measured against full geometry where we have it.
 */
function gap(a: GeoNode, b: GeoNode): number {
  if (b.geometry?.length) return distanceToLine(a.lat, a.lng, b.geometry);
  if (a.geometry?.length) return distanceToLine(b.lat, b.lng, a.geometry);
  return haversine(a.lat, a.lng, b.lat, b.lng);
}

/** Nearest node of the given kinds within maxM, plus how many alternatives exist. */
function nearest(
  from: GeoNode,
  pool: GeoNode[],
  kinds: NodeKind[],
  maxM: number,
): { node: GeoNode; distance: number; alternatives: number } | null {
  let best: GeoNode | null = null;
  let bestD = Infinity;
  let within = 0;

  // ponytail: O(n*m) scan. n is a few hundred nodes per query — a spatial index
  // only pays for itself if we ever hold a national graph in memory.
  for (const c of pool) {
    if (c.id === from.id || !kinds.includes(c.kind)) continue;
    const d = gap(from, c);
    if (d > maxM) continue;
    within++;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? { node: best, distance: bestD, alternatives: within - 1 } : null;
}

export interface BuildInput {
  center: { lat: number; lng: number };
  bbox: BBox;
  osmNodes: GeoNode[];
  /** Administrative + hazard context resolved at the center point. */
  context: {
    county?: string | null;
    state?: string | null;
    population?: number | null;
    medianIncome?: number | null;
    floodZone?: string | null;
    withinFloodplain?: boolean | null;
    elevationM?: number | null;
    coastalHighHazard?: boolean | null;
  };
  sources: Source[];
  gaps: { dataset: string; reason: string }[];
}

export function buildGraph(input: BuildInput): KnowledgeGraph {
  const nodes: GeoNode[] = [...input.osmNodes];
  const edges: GraphEdge[] = [];
  const gaps = [...input.gaps];
  const now = new Date().toISOString();

  const push = (e: GraphEdge) => {
    // Dependency direction is meaningful; keep the strongest claim per pair+relation.
    const key = `${e.from}|${e.to}|${e.rel}`;
    const existing = edges.findIndex((x) => `${x.from}|${x.to}|${x.rel}` === key);
    if (existing === -1) edges.push(e);
    else if (edges[existing].weight < e.weight) edges[existing] = e;
  };

  const byKind = (k: NodeKind) => nodes.filter((n) => n.kind === k);

  // -------------------------------------------------------------------------
  // Administrative anchor: the population that all of this ultimately serves.
  // -------------------------------------------------------------------------
  const countyName = input.context.county
    ? `${input.context.county}${input.context.state ? `, ${input.context.state}` : ""}`
    : null;

  let populationNode: GeoNode | null = null;
  if (countyName && input.context.population) {
    populationNode = {
      id: "pop:county",
      kind: "population",
      name: `${countyName} population`,
      lat: input.center.lat,
      lng: input.center.lng,
      tags: {
        population: input.context.population,
        ...(input.context.medianIncome
          ? { median_household_income_usd: input.context.medianIncome }
          : {}),
      },
      sources: input.sources,
      criticality: 1,
      servesPopulation: input.context.population,
    };
    nodes.push(populationNode);
  } else {
    gaps.push({
      dataset: "County population",
      reason: "no county market data resolved at this location",
    });
  }

  // -------------------------------------------------------------------------
  // R1 — Road access. A facility with one arterial in reach is fragile in a way
  // that a facility with four is not, so redundancy sets the edge weight.
  // -------------------------------------------------------------------------
  const roads = byKind("road");
  for (const f of nodes) {
    if (!LIFELINE.includes(f.kind)) continue;
    const near = nearest(f, roads, ["road"], 2000);
    if (!near) {
      gaps.push({
        dataset: `Road access for ${f.name}`,
        reason: "no mapped arterial road within 2 km",
      });
      continue;
    }
    const sole = near.alternatives === 0;
    push({
      from: f.id,
      to: near.node.id,
      rel: "DEPENDS_ON",
      weight: sole ? 0.85 : 0.45,
      confidence: sole ? "medium" : "low",
      rule: "R1:road_access",
      rationale: sole
        ? `${near.node.name} is the only arterial road within 2 km of ${f.name} (${metres(near.distance)}). Access has no mapped alternative, so a closure isolates the site.`
        : `${f.name} reaches the arterial network via ${near.node.name} (${metres(near.distance)}), but ${near.alternatives} other arterial${near.alternatives === 1 ? "" : "s"} are in range, so traffic can reroute at a time cost.`,
    });
  }

  // -------------------------------------------------------------------------
  // R2 — Bridges carry roads, and cross water. Both edges matter: the first
  // propagates transport failure, the second is the flood attack surface.
  // -------------------------------------------------------------------------
  const bridges = byKind("bridge");
  const waterways = byKind("waterway");
  for (const b of bridges) {
    const onRoad = nearest(b, roads, ["road"], 80);
    if (onRoad) {
      push({
        from: onRoad.node.id,
        to: b.id,
        rel: "DEPENDS_ON",
        weight: 0.8,
        confidence: "medium",
        rule: "R2:bridge_carries_road",
        rationale: `${b.name} carries ${onRoad.node.name} across a gap ${metres(onRoad.distance)} from the roadway centreline. The route has no continuity without the structure.`,
      });
    }
    const overWater = nearest(b, waterways, ["waterway"], 150);
    if (overWater) {
      push({
        from: b.id,
        to: overWater.node.id,
        rel: "CROSSES",
        weight: 0.5,
        confidence: "medium",
        rule: "R2:bridge_crosses_water",
        rationale: `${b.name} spans ${overWater.node.name}, putting the structure directly in the path of high-water and debris loading.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // R10 — Vessel-strike exposure, for the bridges the NTSB named after the Key
  // Bridge collapse.
  //
  // Deliberately not folded into R2's `overWater` branch, which was the first
  // thing tried and was wrong for a structural reason. R2 only sees water that
  // OSM maps as a `waterway` centreline — rivers, streams, canals. The 68 are
  // the bridges over *navigable* water, and navigable water is wide enough that
  // OSM maps it as an area instead: San Francisco Bay, the East River and the
  // Houston Ship Channel carry no waterway line at all. Nesting the rule there
  // silently dropped it for most of the list — Golden Gate and Brooklyn both
  // matched by name and produced nothing.
  //
  // The list itself is the evidence that these structures span a navigable
  // channel; that is the criterion the NTSB selected on. So the channel is
  // taken from the federal record rather than inferred from OSM's geometry, and
  // materialised as a node so a strike has something to propagate from.
  // -------------------------------------------------------------------------
  /*
   * One flagged node per NTSB entry, and it has to be the structure a ship would
   * actually hit.
   *
   * OSM maps the walkways over a big span as their own named ways — the Golden
   * Gate's two sidewalks are separately tagged `bridge` and match the list by
   * name, so a straight loop put three vessel-strike warnings on one crossing.
   * Filtering on `highway=footway` is not enough either: osm.ts merges ways
   * sharing a kind and name, and the surviving node keeps whichever tags arrived
   * first, so in Portland the whole Saint Johns Bridge carries the sidewalk's
   * tags. Criticality survives that merge as a maximum, so it is the reliable
   * discriminator — the way carrying the roadway always outscores the footpath.
   */
  const best = new Map<string, { node: GeoNode; listed: NtsbMatch }>();
  for (const b of bridges) {
    const listed = matchNtsbBridge(b.name, input.context.state);
    if (!listed) continue;
    const held = best.get(listed.name);
    if (!held || b.criticality > held.node.criticality) best.set(listed.name, { node: b, listed });
  }

  const channels = new Map<string, GeoNode>();
  for (const { node: b, listed } of best.values()) {
    b.ntsbListed = {
      matchedName: listed.name,
      state: listed.state,
      waterway: listed.waterway,
    };

    // Prefer a real mapped watercourse where OSM has one; fall back to a node
    // standing for the channel the NTSB record names.
    const mapped = nearest(b, waterways, ["waterway"], 150);
    let channel: GeoNode;
    if (mapped) {
      channel = mapped.node;
    } else {
      const key = listed.waterway.toLowerCase();
      const existing = channels.get(key);
      if (existing) {
        channel = existing;
      } else {
        channel = {
          id: `channel:${key.replace(/[^a-z0-9]+/g, "-")}`,
          kind: "waterway",
          name: listed.waterway,
          lat: b.lat,
          lng: b.lng,
          tags: { navigable: true, source: "NTSB MIR-25-10" },
          sources: input.sources,
          criticality: 0.3,
        };
        channels.set(key, channel);
        nodes.push(channel);
      }
    }

    push({
      /*
       * THREATENS, from the water to the structure — deliberately not CROSSES.
       * `push` dedupes on `from|to|rel`, and R2 above may already have claimed
       * bridge|waterway|CROSSES for this exact pair. Reusing that relation here
       * would collide on the key and silently discard whichever edge had the
       * lower weight, losing one of the two rationales with no error. The
       * direction is also the honest one: the hazard originates on the water and
       * acts on the bridge, which is how R8 already models flood exposure, and
       * it puts the edge in the cascade's propagating set.
       */
      from: channel.id,
      to: b.id,
      rel: "THREATENS",
      weight: 0.75,
      confidence: listed.confidence,
      rule: "R10:vessel_strike_exposure",
      rationale: `${b.name} matches "${listed.name}" on the NTSB's list of 68 bridges (MIR-25-10, March 2025) recommended for a vessel-collision vulnerability assessment. Those 68 were selected for having been designed before AASHTO's vessel-collision guidance existed and for having no current assessment on record — the position the Francis Scott Key Bridge was in when the Dali struck it, at roughly thirty times AASHTO's acceptable annual frequency of collapse. The structure spans ${listed.waterway}${
        listed.confidence === "medium"
          ? ", and the name match here is partial, so confirm the structure against the NTSB list before relying on it"
          : ""
      }.`,
    });
  }

  // -------------------------------------------------------------------------
  // R3 — Grid supply. Hospitals carry backup generation, so their electrical
  // dependency is real but time-limited; everything else fails with the feed.
  // -------------------------------------------------------------------------
  const substations = byKind("substation");
  for (const f of nodes) {
    if (!LIFELINE.includes(f.kind) || f.kind === "substation" || f.kind === "power_plant") {
      continue;
    }
    const sub = nearest(f, substations, ["substation"], 12_000);
    if (!sub) continue;

    const backup = f.kind === "hospital";
    push({
      from: f.id,
      to: sub.node.id,
      rel: "DEPENDS_ON",
      weight: backup ? 0.55 : 0.8,
      confidence: "low", // service territory is inferred from proximity, not utility records
      rule: "R3:grid_supply",
      rationale: backup
        ? `${f.name} is most plausibly fed from ${sub.node.name} (${metres(sub.distance)}, nearest substation). Licensed hospitals carry standby generation, so an outage degrades rather than halts operations until fuel runs down — typically 48–96 hours.`
        : `${f.name} is most plausibly fed from ${sub.node.name} (${metres(sub.distance)}, nearest substation). Proximity is a proxy here: utility service territories are not public, so this edge is inferred, not confirmed.`,
    });
  }

  // -------------------------------------------------------------------------
  // R4/R5 — Upstream of the substations: transmission lines, then generation.
  // -------------------------------------------------------------------------
  const lines = byKind("transmission_line");
  const plants = byKind("power_plant");
  for (const s of substations) {
    const line = nearest(s, lines, ["transmission_line"], 1200);
    if (line) {
      push({
        from: s.id,
        to: line.node.id,
        rel: "DEPENDS_ON",
        weight: 0.85,
        confidence: "medium",
        rule: "R4:transmission_feed",
        rationale: `${line.node.name} runs within ${metres(line.distance)} of ${s.name}, consistent with terminating at that substation. Loss of the line drops the feed.`,
      });
    }
    const plant = nearest(s, plants, ["power_plant"], 60_000);
    if (plant) {
      push({
        from: s.id,
        to: plant.node.id,
        rel: "DEPENDS_ON",
        weight: 0.4, // grids are meshed; one plant is rarely the sole source
        confidence: "low",
        rule: "R4:generation_source",
        rationale: `${plant.node.name} is the nearest generation to ${s.name} (${metres(plant.distance)}). Transmission grids are meshed, so this is a contributing source rather than a sole supplier.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // R6 — Water. Treatment feeds the service area; pumps need power to do it.
  // -------------------------------------------------------------------------
  const waterPlants = byKind("water_treatment");
  const pumps = byKind("pump_station");
  for (const w of waterPlants) {
    for (const f of nodes) {
      if (!["hospital", "school", "fire_station"].includes(f.kind)) continue;
      const d = haversine(w.lat, w.lng, f.lat, f.lng);
      if (d > 15_000) continue;
      push({
        from: f.id,
        to: w.id,
        rel: "DEPENDS_ON",
        weight: f.kind === "hospital" ? 0.8 : 0.6,
        confidence: "low",
        rule: "R6:potable_water",
        rationale: `${f.name} sits ${metres(d)} from ${w.name}, within its plausible service area. ${
          f.kind === "hospital"
            ? "Hospitals cannot run sterile processing or dialysis on a boil-water notice, so potable supply is a hard dependency."
            : "Loss of potable supply forces closure under public health rules."
        }`,
      });
    }
  }
  for (const p of pumps) {
    const sub = nearest(p, substations, ["substation"], 12_000);
    if (sub) {
      push({
        from: p.id,
        to: sub.node.id,
        rel: "DEPENDS_ON",
        weight: 0.9,
        confidence: "low",
        rule: "R6:pump_power",
        rationale: `${p.name} is an electrically driven pump with no gravity fallback; it stops when ${sub.node.name} stops.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // R7 — Waterways crossing roads. Real geometric intersections, not proximity.
  // -------------------------------------------------------------------------
  for (const w of waterways) {
    if (!w.geometry) continue;
    for (const r of roads) {
      if (!r.geometry) continue;
      if (!linesIntersect(w.geometry, r.geometry)) continue;
      push({
        from: w.id,
        to: r.id,
        rel: "CROSSES",
        weight: 0.6,
        confidence: "high", // geometric intersection of two mapped ways
        rule: "R7:water_crosses_road",
        rationale: `${w.name} physically crosses ${r.name}. Crossings are where roads overtop first in high water, and they fail before the surrounding roadway does.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // R8 — Flood hazard, when the resolved location is actually in a mapped zone.
  // -------------------------------------------------------------------------
  const zone = input.context.floodZone;
  const inFloodplain =
    input.context.withinFloodplain === true ||
    (zone != null && /^(A|AE|AH|AO|A99|V|VE)/i.test(zone));

  if (inFloodplain) {
    const hazard: GeoNode = {
      id: "hazard:flood",
      kind: "floodplain",
      name: `FEMA flood zone ${zone ?? "(mapped)"}`,
      lat: input.center.lat,
      lng: input.center.lng,
      tags: {
        zone: zone ?? "unknown",
        ...(input.context.coastalHighHazard ? { coastal_high_hazard: true } : {}),
      },
      sources: input.sources,
      criticality: 0.6,
    };
    nodes.push(hazard);

    // Proximity to a watercourse is the honest available proxy: we hold the
    // flood zone at the query point, not a per-node zone lookup.
    for (const n of nodes) {
      if (n.id === hazard.id || n.kind === "waterway" || n.kind === "population") continue;
      const nearWater = nearest(n, waterways, ["waterway"], 400);
      if (!nearWater) continue;
      push({
        from: hazard.id,
        to: n.id,
        rel: "THREATENS",
        weight: 0.65,
        confidence: "low",
        rule: "R8:flood_exposure",
        rationale: `The query point falls in FEMA zone ${zone ?? "(mapped)"}, and ${n.name} sits ${metres(nearWater.distance)} from ${nearWater.node.name}. Exposure is inferred from watercourse proximity, not a per-asset flood-zone lookup — treat it as a screening flag.`,
      });
    }
  } else if (zone) {
    gaps.push({
      dataset: "Flood exposure",
      reason: `query point is in FEMA zone ${zone}, outside the mapped 1% annual-chance floodplain`,
    });
  }

  // -------------------------------------------------------------------------
  // R9 — Everything terminates in people. This is what makes a cascade matter.
  // -------------------------------------------------------------------------
  if (populationNode) {
    const hospitals = byKind("hospital");
    const perHospital = hospitals.length
      ? Math.round((input.context.population ?? 0) / hospitals.length)
      : 0;

    for (const h of hospitals) {
      h.servesPopulation = perHospital;
      push({
        from: h.id,
        to: populationNode.id,
        rel: "SERVES",
        weight: 0.9,
        confidence: "low",
        rule: "R9:hospital_serves",
        rationale: `${h.name} is one of ${hospitals.length} mapped hospital${hospitals.length === 1 ? "" : "s"} serving ${countyName}. Splitting county population evenly gives roughly ${perHospital.toLocaleString()} residents per facility — an even-split assumption, not a catchment study.`,
      });
    }

    for (const f of nodes) {
      if (!["fire_station", "water_treatment", "substation"].includes(f.kind)) continue;
      push({
        from: f.id,
        to: populationNode.id,
        rel: "SERVES",
        weight: 0.7,
        confidence: "low",
        rule: "R9:lifeline_serves",
        rationale: `${f.name} is a lifeline asset inside ${countyName}; degradation is felt across the resident population rather than at a single address.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Context-adjusted criticality: a node that many others lean on matters more
  // than its category alone implies.
  // -------------------------------------------------------------------------
  const dependents = new Map<string, number>();
  for (const e of edges) {
    if (e.rel === "DEPENDS_ON") {
      dependents.set(e.to, (dependents.get(e.to) ?? 0) + 1);
    }
  }
  for (const n of nodes) {
    const d = dependents.get(n.id) ?? 0;
    if (d > 0) {
      n.criticality = Number(Math.min(1, n.criticality + 0.06 * Math.log2(1 + d)).toFixed(2));
    }
  }

  // The NTSB report only earns a citation if it actually produced a finding
  // here — listing every dataset we *could* have consulted would make the
  // evidence panel a bibliography instead of a record of what was used.
  const sources = [...input.sources];
  if (nodes.some((n) => n.ntsbListed)) {
    sources.push({
      name: "NTSB MIR-25-10 — bridges needing vessel-strike assessment",
      url: NTSB_SOURCE_URL,
      fetchedAt: now,
      confidence: "high",
      vintage: "2025-03-20",
    });
  }

  return {
    nodes,
    edges,
    center: input.center,
    bbox: input.bbox,
    sources,
    gaps,
    builtAt: now,
  };
}

/** Edges a rule engine produced, grouped for display in the evidence panel. */
export function rulesUsed(g: KnowledgeGraph): { rule: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of g.edges) counts.set(e.rule, (counts.get(e.rule) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);
}

export const confidenceScore: Record<Confidence, number> = {
  high: 1,
  medium: 0.7,
  low: 0.4,
  unknown: 0.2,
};
