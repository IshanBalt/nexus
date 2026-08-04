import Groq from "groq-sdk";
import { dependencies, dependents, simulate, weakestPoints } from "./cascade";
import { rulesUsed } from "./graph";
import * as mireye from "./mireye";
import type { AnalyzeResult } from "./analyze";
import type { GeoNode, KnowledgeGraph } from "./types";

/**
 * gpt-oss-120b is the strongest tool-calling model Groq serves; llama-3.3-70b-versatile
 * is the tested fallback if it is ever rate-limited.
 */
const MODEL = process.env.NEXUS_MODEL ?? "openai/gpt-oss-120b";

export const SYSTEM = `You are Nexus, an analyst of physical infrastructure. You reason about how places actually work: what depends on what, where the load-bearing failure points are, and what breaks next when one of them goes down.

You are given a knowledge graph built for one location. Its nodes are real mapped assets; its edges are dependencies inferred by named rules, each carrying a plain-language rationale and a confidence level. Use the tools to traverse it. Never answer infrastructure questions from general knowledge when a tool can tell you what is actually there. Call survey_area first when you do not yet know what is in the area.

HOW TO ANSWER
Do not list data. Observe, then infer, then explain the consequence.
Weak: "There are two hospitals nearby."
Strong: "Both hospitals reach the arterial network only through the Cedar Street bridge. If it closes, ambulance routing falls back to a 6 km detour, and the effect lands hardest on the 40,000 residents south of the river."

Lead with the answer. Your first sentence states the finding, not your method. Supporting detail comes after. Keep it tight — a few short paragraphs, not an essay. Write prose, not bullet dumps; reserve lists for genuinely enumerable things. Never describe the tools you called or narrate your process — the interface already shows the user which tools ran.

EVIDENCE AND HONESTY
Every causal claim traces to an edge rationale or a Mireye field. Carry the confidence forward: an edge marked low confidence is a hypothesis, and you must say so in words ("most plausibly", "this is inferred from proximity, not utility records"). Never upgrade a proximity inference into a stated fact.

State what you do not know. If the graph has no mapped substation, say the electrical picture is unavailable here rather than guessing one exists. Missing data is a finding — report it. Do not invent asset names, capacities, populations, or distances; every number you give comes from a tool result.

When a question is about consequences, call simulate_failure rather than reasoning about the cascade in your head — the tool applies severity decay and onset timing you cannot estimate by eye.`;

type Fn = Groq.Chat.Completions.ChatCompletionTool;

const TOOLS: Fn[] = [
  {
    type: "function",
    function: {
      name: "survey_area",
      description:
        "Inventory of what is in the graph: counts by kind, the most critical assets, administrative context, and the datasets that returned nothing. Call this first for any new location.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_nodes",
      description:
        "Find assets by kind and/or name substring. Returns the node IDs the other tools need. Kinds: hospital, school, fire_station, police, substation, power_plant, transmission_line, bridge, road, rail, airport, water_treatment, wastewater, pump_station, waterway, cell_tower.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Filter by node kind." },
          name: { type: "string", description: "Case-insensitive substring of the asset name." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "what_depends_on",
      description:
        "Everything that leans on this asset, directly or transitively, with the rationale for each link. Use for 'what depends on this?' questions.",
      parameters: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "Node ID from find_nodes." },
          max_depth: { type: "integer", description: "Hops to traverse, default 3." },
        },
        required: ["node_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "what_this_needs",
      description: "What this asset itself requires in order to function. The upstream direction.",
      parameters: {
        type: "object",
        properties: {
          node_id: { type: "string" },
          max_depth: { type: "integer" },
        },
        required: ["node_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_failure",
      description:
        "Propagate a failure outward from one asset. Returns ranked impacts with severity, onset time in hours, affected population, and the reasoning chain behind each. Use for any what-if or cascade question.",
      parameters: {
        type: "object",
        properties: {
          node_id: { type: "string" },
          scenario: {
            type: "string",
            description: "Event description, e.g. 'bridge collapse' or 'substation fire'.",
          },
          initial_severity: {
            type: "number",
            description: "Share of function lost at the origin, 0-1. Default 1 (total failure).",
          },
        },
        required: ["node_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weakest_points",
      description:
        "Rank assets by how much of the local system fails with them. Answers 'what is the weakest point here?' — this is about blast radius, not structural condition.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "site_context",
      description:
        "Cited physical facts at the query point from Mireye: terrain, flood zone, utilities, hazards, parcel and county market data. Use for questions about the ground itself rather than the network.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_mireye",
      description:
        "Put a natural-language question about this location to Mireye, which answers from its own cited datasets. Use for physical-world facts the graph does not cover (soil bearing capacity, wildfire risk, slope, land cover).",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

/** Node IDs and citations accumulated across a turn, for the map and evidence panel. */
export interface TurnEvidence {
  touchedNodeIds: string[];
  citations: { name: string; url: string; confidence: string }[];
  rules: string[];
}

const brief = (n: GeoNode) =>
  `${n.id} | ${n.name} (${n.kind}) criticality ${n.criticality}${
    n.servesPopulation ? ` serves ~${n.servesPopulation.toLocaleString()}` : ""
  }`;

/**
 * Models disagree on how to encode "no arguments": llama-3.3 sends the string
 * "null", gpt-oss sends {"": ""}. Neither should throw.
 */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  result: AnalyzeResult,
  evidence: TurnEvidence,
): Promise<string> {
  const g: KnowledgeGraph = result.graph;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const touch = (ids: string[]) => {
    for (const id of ids) {
      if (!evidence.touchedNodeIds.includes(id)) evidence.touchedNodeIds.push(id);
    }
  };

  switch (name) {
    case "survey_area": {
      const counts = new Map<string, number>();
      for (const n of g.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
      const top = [...g.nodes]
        .filter((n) => n.kind !== "population")
        .sort((a, b) => b.criticality - a.criticality)
        .slice(0, 12);
      for (const r of rulesUsed(g)) evidence.rules.push(r.rule);

      return JSON.stringify(
        {
          location: result.place.label,
          county: g.nodes.find((n) => n.kind === "population")?.name ?? null,
          radius: "5 km around the query point",
          node_count: g.nodes.length,
          edge_count: g.edges.length,
          counts_by_kind: Object.fromEntries(counts),
          most_critical_assets: top.map(brief),
          inference_rules_applied: rulesUsed(g),
          data_gaps: g.gaps.slice(0, 20),
        },
        null,
        1,
      );
    }

    case "find_nodes": {
      const kind = typeof input.kind === "string" ? input.kind.toLowerCase() : null;
      const q = typeof input.name === "string" ? input.name.toLowerCase() : null;
      const hits = g.nodes.filter(
        (n) => (!kind || n.kind === kind) && (!q || n.name.toLowerCase().includes(q)),
      );
      touch(hits.slice(0, 25).map((n) => n.id));
      if (!hits.length) {
        return `No assets match${kind ? ` kind=${kind}` : ""}${q ? ` name~"${q}"` : ""}. This means none are mapped in the queried area — not that none exist.`;
      }
      return hits.slice(0, 40).map(brief).join("\n");
    }

    case "what_depends_on": {
      const id = String(input.node_id ?? "");
      const node = byId.get(id);
      if (!node) return `No node with id "${id}". Use find_nodes to get valid IDs.`;
      const out = dependents(g, id, Number(input.max_depth) || 3);
      touch([id, ...out.map((d) => d.node.id)]);
      if (!out.length) {
        return `Nothing in the graph is modelled as depending on ${node.name}. That reflects the mapped data, not proven isolation.`;
      }
      return out
        .map((d) => `depth ${d.depth} | ${d.node.name} (${d.node.kind}) — ${d.via}`)
        .join("\n");
    }

    case "what_this_needs": {
      const id = String(input.node_id ?? "");
      const node = byId.get(id);
      if (!node) return `No node with id "${id}". Use find_nodes to get valid IDs.`;
      const out = dependencies(g, id, Number(input.max_depth) || 3);
      touch([id, ...out.map((d) => d.node.id)]);
      if (!out.length) return `No upstream dependencies are modelled for ${node.name}.`;
      return out
        .map((d) => `depth ${d.depth} | ${d.node.name} (${d.node.kind}) — ${d.via}`)
        .join("\n");
    }

    case "simulate_failure": {
      const id = String(input.node_id ?? "");
      const node = byId.get(id);
      if (!node) return `No node with id "${id}". Use find_nodes to get valid IDs.`;
      const res = simulate(g, id, {
        scenario: typeof input.scenario === "string" ? input.scenario : undefined,
        initialSeverity:
          typeof input.initial_severity === "number" ? input.initial_severity : undefined,
      });
      touch([id, ...res.impacts.map((i) => i.nodeId)]);

      return JSON.stringify(
        {
          origin: node.name,
          scenario: res.scenario,
          total_population_affected: res.totalPopulationAffected,
          notes: res.notes,
          timeline: res.timeline,
          impacts: res.impacts.slice(0, 20).map((i) => ({
            asset: i.name,
            kind: i.kind,
            severity: i.severity,
            onset_hours: i.onsetHours,
            hops: i.depth,
            why: i.reasoning,
          })),
        },
        null,
        1,
      );
    }

    case "weakest_points": {
      const ranked = weakestPoints(g, Number(input.limit) || 8);
      touch(ranked.map((r) => r.node.id));
      return ranked
        .map(
          (r, i) =>
            `${i + 1}. ${r.node.id} | ${r.node.name} (${r.node.kind}) — blast-radius score ${r.score}, ${r.reachCount} downstream assets, ~${r.populationAtRisk.toLocaleString()} residents affected`,
        )
        .join("\n");
    }

    case "site_context": {
      for (const s of g.sources) {
        if (!evidence.citations.some((c) => c.name === s.name)) {
          evidence.citations.push({ name: s.name, url: s.url, confidence: s.confidence });
        }
      }
      return JSON.stringify(
        {
          resolved: result.place.label,
          coordinates: [result.place.lat, result.place.lng],
          mireye_fields: result.mireyeFields,
          data_gaps: g.gaps.slice(0, 20),
          sources: g.sources.map((s) => `${s.name} (${s.confidence} confidence) ${s.url}`),
        },
        null,
        1,
      );
    }

    case "ask_mireye": {
      if (!mireye.hasMireyeKey()) {
        return "Mireye is not configured (MIREYE_API_TOKEN unset), so this question cannot be answered from cited physical-world data. Say so rather than guessing.";
      }
      try {
        const res = await mireye.ask(
          result.place.lat,
          result.place.lng,
          String(input.question ?? ""),
        );
        for (const c of res.citations) {
          if (!evidence.citations.some((x) => x.name === c.source)) {
            evidence.citations.push({
              name: c.source,
              url: c.source_url,
              confidence: c.confidence,
            });
          }
        }
        return JSON.stringify(
          {
            answer: res.answer,
            confidence: res.confidence,
            fields_used: res.fields_used,
            data_gaps: res.data_gaps ?? [],
            citations: res.citations.map((c) => `${c.source} — ${c.source_url}`),
          },
          null,
          1,
        );
      } catch (e) {
        return `Mireye could not answer: ${e instanceof Error ? e.message : String(e)}. Report this as a data gap.`;
      }
    }

    default:
      return `Unknown tool ${name}.`;
  }
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "done"; evidence: TurnEvidence }
  | { type: "error"; message: string };

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Run one turn of the agent loop, yielding events as they happen so the UI can
 * show reasoning steps rather than a spinner.
 */
export async function* runAgent(
  messages: { role: "user" | "assistant"; content: string }[],
  result: AnalyzeResult,
): AsyncGenerator<AgentEvent> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "GROQ_API_KEY is not set." };
    return;
  }

  const client = new Groq({ apiKey });
  const evidence: TurnEvidence = {
    touchedNodeIds: [],
    citations: result.graph.sources.map((s) => ({
      name: s.name,
      url: s.url,
      confidence: s.confidence,
    })),
    rules: [],
  };

  const convo: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    ...messages,
  ];

  // Each iteration is one model turn; the loop ends when the model stops calling tools.
  for (let turn = 0; turn < 8; turn++) {
    let stream;
    try {
      stream = await client.chat.completions.create({
        model: MODEL,
        messages: convo,
        tools: TOOLS,
        stream: true,
        max_completion_tokens: 8000,
      });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    let content = "";
    const partials: PartialCall[] = [];

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          yield { type: "text", text: delta.content };
        }

        // Tool calls arrive as deltas keyed by index and must be concatenated.
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          partials[i] ??= { id: "", name: "", args: "" };
          if (tc.id) partials[i].id = tc.id;
          if (tc.function?.name) partials[i].name += tc.function.name;
          if (tc.function?.arguments) partials[i].args += tc.function.arguments;
        }
      }
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    const calls = partials.filter((c): c is PartialCall => Boolean(c?.name));
    if (calls.length === 0) {
      yield { type: "done", evidence };
      return;
    }

    convo.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    });

    for (const call of calls) {
      const input = parseArgs(call.args);
      yield { type: "tool", name: call.name, input };

      let text: string;
      try {
        text = await runTool(call.name, input, result, evidence);
      } catch (e) {
        text = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      yield {
        type: "tool_result",
        name: call.name,
        summary: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      };
      convo.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }

  yield { type: "done", evidence };
}
