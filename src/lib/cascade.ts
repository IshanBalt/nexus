import type {
  CascadeImpact,
  CascadeResult,
  GeoNode,
  GraphEdge,
  KnowledgeGraph,
  NodeKind,
} from "./types";

/** Below this share of function lost, an impact is noise rather than signal. */
const SEVERITY_FLOOR = 0.06;
const MAX_DEPTH = 5;

/**
 * Hours between an upstream failure and the point where the downstream node
 * actually degrades. Buffers are what separate a nuisance from an emergency,
 * and they are the main thing a pure graph traversal gets wrong.
 */
function onsetDelay(consumer: GeoNode, provider: GeoNode, edge: GraphEdge): number {
  if (edge.rel === "SERVES") return 24; // population effects lag institutional ones

  switch (provider.kind) {
    case "bridge":
    case "road":
      return 0; // a severed route is severed instantly
    case "substation":
    case "transmission_line":
    case "power_plant":
      // Hospitals hold fuel for standby generation; nothing else here does.
      return consumer.kind === "hospital" ? 72 : 0.5;
    case "water_treatment":
      return 12; // distribution storage drains before taps run dry
    case "pump_station":
      return 6;
    default:
      return 2;
  }
}

const BANDS: { band: string; maxHours: number }[] = [
  { band: "0–6 hours", maxHours: 6 },
  { band: "6–24 hours", maxHours: 24 },
  { band: "1–3 days", maxHours: 72 },
  { band: "3+ days", maxHours: Infinity },
];

/** Relations along which a failure actually propagates outward to a victim. */
const PROPAGATING = new Set<GraphEdge["rel"]>([
  "DEPENDS_ON",
  "SUPPLIES",
  "SERVES",
  "THREATENS",
  "CONNECTED_TO",
]);

interface Adjacency {
  /** provider id -> edges where something leans on that provider. */
  victims: Map<string, GraphEdge[]>;
  byId: Map<string, GeoNode>;
}

function index(g: KnowledgeGraph): Adjacency {
  const victims = new Map<string, GraphEdge[]>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  for (const e of g.edges) {
    if (!PROPAGATING.has(e.rel)) continue;

    // DEPENDS_ON points consumer -> provider, so failure travels backwards
    // along it. SUPPLIES/SERVES/THREATENS already point the way impact flows.
    const [provider, victim] =
      e.rel === "DEPENDS_ON" ? [e.to, e.from] : [e.from, e.to];

    const list = victims.get(provider) ?? [];
    list.push({ ...e, from: victim, to: provider });
    victims.set(provider, list);
  }
  return { victims, byId };
}

export interface SimulateOptions {
  /** Human-readable event description, e.g. "bridge collapse". */
  scenario?: string;
  /** Share of the origin node's function lost, 0-1. Default: total failure. */
  initialSeverity?: number;
}

/**
 * Propagate a failure outward from one node and rank what breaks next.
 *
 * Breadth-first with severity decay: each hop multiplies by the edge weight, so
 * a strong single dependency carries impact far while a redundant one dies out.
 */
export function simulate(
  g: KnowledgeGraph,
  originId: string,
  opts: SimulateOptions = {},
): CascadeResult {
  const { victims, byId } = index(g);
  const origin = byId.get(originId);
  if (!origin) {
    return {
      originId,
      scenario: opts.scenario ?? "failure",
      impacts: [],
      totalPopulationAffected: 0,
      timeline: [],
      notes: [`Node ${originId} is not present in the current graph.`],
    };
  }

  const scenario = opts.scenario ?? `${origin.name} failure`;
  const best = new Map<string, CascadeImpact>();
  const notes: string[] = [];

  type Frame = {
    id: string;
    severity: number;
    depth: number;
    path: string[];
    reasoning: string[];
    hours: number;
  };

  const queue: Frame[] = [
    {
      id: originId,
      severity: opts.initialSeverity ?? 1,
      depth: 0,
      path: [originId],
      reasoning: [],
      hours: 0,
    },
  ];

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= MAX_DEPTH) continue;

    for (const edge of victims.get(cur.id) ?? []) {
      const victim = byId.get(edge.from);
      const provider = byId.get(edge.to);
      if (!victim || !provider) continue;
      if (cur.path.includes(victim.id)) continue; // no revisiting: kills cycles

      const severity = cur.severity * edge.weight;
      if (severity < SEVERITY_FLOOR) continue;

      const hours = cur.hours + onsetDelay(victim, provider, edge);
      const impact: CascadeImpact = {
        nodeId: victim.id,
        name: victim.name,
        kind: victim.kind,
        severity: Number(severity.toFixed(3)),
        depth: cur.depth + 1,
        path: [...cur.path, victim.id],
        reasoning: [...cur.reasoning, edge.rationale],
        onsetHours: hours,
        populationAffected: victim.servesPopulation,
      };

      // Several routes can reach the same victim; keep the worst-case one.
      const prior = best.get(victim.id);
      if (prior && prior.severity >= impact.severity) continue;
      best.set(victim.id, impact);

      queue.push({
        id: victim.id,
        severity,
        depth: cur.depth + 1,
        path: impact.path,
        reasoning: impact.reasoning,
        hours,
      });
    }
  }

  const impacts = [...best.values()].sort(
    (a, b) => b.severity * criticalityOf(byId, b) - a.severity * criticalityOf(byId, a),
  );

  // Population comes from the county node when the cascade actually reaches it.
  const popImpact = impacts.find((i) => i.kind === "population");
  const popNode = g.nodes.find((n) => n.kind === "population");
  const totalPopulationAffected =
    popImpact && popNode?.servesPopulation
      ? Math.round(popNode.servesPopulation * popImpact.severity)
      : 0;

  if (!popImpact) {
    notes.push(
      "No modelled path from this failure reaches the resident population — the effects stay inside the infrastructure layer at the depth searched.",
    );
  }
  if (impacts.length === 0) {
    notes.push(
      `Nothing in the current graph is modelled as depending on ${origin.name}. That is a statement about the mapped data, not proof of true isolation.`,
    );
  }
  const hospitals = impacts.filter((i) => i.kind === "hospital");
  if (hospitals.length) {
    notes.push(
      `${hospitals.length} hospital${hospitals.length === 1 ? "" : "s"} appear downstream; the earliest degradation begins around ${Math.round(Math.min(...hospitals.map((h) => h.onsetHours)))} hours in.`,
    );
  }

  const timeline = BANDS.map(({ band, maxHours }, i) => {
    const lower = i === 0 ? -1 : BANDS[i - 1].maxHours;
    return {
      band,
      impacts: impacts
        .filter((x) => x.onsetHours > lower && x.onsetHours <= maxHours)
        .map((x) => x.name),
    };
  }).filter((t) => t.impacts.length > 0);

  return { originId, scenario, impacts, totalPopulationAffected, timeline, notes };
}

const criticalityOf = (byId: Map<string, GeoNode>, i: CascadeImpact) =>
  byId.get(i.nodeId)?.criticality ?? 0.5;

/**
 * Everything that leans on this node, directly or transitively.
 * Answers "what depends on this?" without assuming a failure has occurred.
 */
export function dependents(
  g: KnowledgeGraph,
  nodeId: string,
  maxDepth = 3,
): { node: GeoNode; depth: number; via: string }[] {
  const { victims, byId } = index(g);
  const seen = new Set([nodeId]);
  const out: { node: GeoNode; depth: number; via: string }[] = [];
  let frontier = [nodeId];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of victims.get(id) ?? []) {
        if (seen.has(edge.from)) continue;
        const node = byId.get(edge.from);
        if (!node) continue;
        seen.add(edge.from);
        out.push({ node, depth, via: edge.rationale });
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return out;
}

/** What this node itself needs in order to function. */
export function dependencies(
  g: KnowledgeGraph,
  nodeId: string,
  maxDepth = 3,
): { node: GeoNode; depth: number; via: string }[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: { node: GeoNode; depth: number; via: string }[] = [];
  const seen = new Set([nodeId]);
  let frontier = [nodeId];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of g.edges) {
        if (e.from !== id || e.rel !== "DEPENDS_ON" || seen.has(e.to)) continue;
        const node = byId.get(e.to);
        if (!node) continue;
        seen.add(e.to);
        out.push({ node, depth, via: e.rationale });
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Rank nodes by how much of the local system fails with them.
 * This is the "what is the weakest point here?" answer: not the most fragile
 * asset, but the one whose loss propagates furthest.
 */
export function weakestPoints(
  g: KnowledgeGraph,
  limit = 8,
): { node: GeoNode; reachCount: number; populationAtRisk: number; score: number }[] {
  const candidates = g.nodes.filter(
    (n) => n.kind !== "population" && n.kind !== "floodplain",
  );

  const scored = candidates.map((n) => {
    const result = simulate(g, n.id, { scenario: `${n.name} offline` });
    const reachCount = result.impacts.length;
    const severitySum = result.impacts.reduce((s, i) => s + i.severity, 0);
    return {
      node: n,
      reachCount,
      populationAtRisk: result.totalPopulationAffected,
      // Weight by the node's own criticality so a chain of trivia can't outrank
      // a single hospital feed.
      score: Number((severitySum * n.criticality).toFixed(3)),
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export const KIND_ORDER: NodeKind[] = [
  "hospital",
  "water_treatment",
  "power_plant",
  "substation",
  "fire_station",
  "bridge",
  "road",
  "school",
];
