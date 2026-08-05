import Groq from "groq-sdk";
import { dependencies, dependents, simulate, weakestPoints } from "./cascade";
import { rulesUsed } from "./graph";
import * as mireye from "./mireye";
import type { AnalyzeResult } from "./analyze";
import type { VesselTraffic } from "./sources/ais";
import type { GeoNode, KnowledgeGraph } from "./types";

/*
 * Two models, because on Groq's free tier neither one alone is both reliable and
 * fast enough.
 *
 * The tier meters tokens per minute and charges `prompt + max_completion_tokens`
 * up front, used or not. A question costs two or three model calls, and three
 * calls do not fit in 8000 TPM. When the bucket runs dry the SDK backs off and
 * retries, which is invisible from the outside and simply looks like a hang:
 * measured 32s and 53s for a single question, against a platform that kills the
 * request at about 20s. That was the whole reason the chat produced no answer.
 *
 * Measured over the same four questions, with identical prompts:
 *
 *   openai/gpt-oss-20b        8000 TPM   4/4 correct, one call throttled to 41s
 *   llama-3.3-70b-versatile  12000 TPM   2/4 correct, 0.8-5.1s, malformed tool JSON
 *
 * gpt-oss leads because a wrong answer is worse than a slow one. The buckets are
 * metered per model, so when gpt-oss is throttled the same call is retried once
 * against llama's separate allowance rather than waiting for a refill. Tool-call
 * accuracy matters least on exactly the call most likely to be throttled — the
 * last one, which only has to write prose from evidence already gathered.
 */
const MODEL = process.env.NEXUS_MODEL ?? "openai/gpt-oss-20b";
const FALLBACK_MODEL = process.env.NEXUS_FALLBACK_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Wall-clock budget for tool calling. Past it, the model is asked to answer with
 * what it already has instead of gathering more. Serverless platforms kill a
 * long function mid-stream and the user sees the reasoning steps followed by
 * silence, which is the worst possible failure: it looks like a wrong answer
 * rather than a truncated one. Netlify was measured cutting this route off at
 * ~20s, so the default leaves room to write the answer inside that.
 */
const TOOL_BUDGET_MS = Number(process.env.NEXUS_TOOL_BUDGET_MS ?? 11_000);

/** Model turns per question. Each is a round trip, so this bounds latency too. */
const MAX_TURNS = 6;

/**
 * Reserved up front against the per-minute token budget on every call, used or
 * not, so this is a cost paid per round trip rather than per word written. The
 * answers are a few short paragraphs — about 400 tokens — and this leaves room
 * for a long one without spending the budget on headroom nothing will use.
 */
const MAX_COMPLETION_TOKENS = 900;

export const SYSTEM = `You are Nexus, an analyst of physical infrastructure. You reason about how places actually work: what depends on what, where the load-bearing failure points are, and what breaks next when one of them goes down.

You are given a knowledge graph built for one location, and an inventory of it below. Its nodes are real mapped assets; its edges are dependencies inferred by named rules, each carrying a plain-language rationale and a confidence level. Use the tools to traverse it. Never answer infrastructure questions from general knowledge when a tool can tell you what is actually there.

HOW TO ANSWER
Do not list data. Observe, then infer, then explain the consequence.
Weak: "There are two hospitals nearby."
Strong: "Both hospitals reach the arterial network only through the Cedar Street bridge. If it closes, ambulance routing falls back to a 6 km detour, and the effect lands hardest on the 40,000 residents south of the river."
That example is about a place that does not exist. Its names, distances and population are illustrations of the shape of a good answer, never facts about the location you are analysing — reusing any of them is a fabrication.

Lead with the answer. Your first sentence states the finding, not your method. Supporting detail comes after. Keep it tight — a few short paragraphs, not an essay. Write prose, not bullet dumps; reserve lists for genuinely enumerable things. Never describe the tools you called or narrate your process — the interface already shows the user which tools ran.

EVIDENCE AND HONESTY
Every causal claim traces to an edge rationale or a Mireye field. Carry the confidence forward: an edge marked low confidence is a hypothesis, and you must say so in words ("most plausibly", "this is inferred from proximity, not utility records"). Never upgrade a proximity inference into a stated fact.

State what you do not know. If the graph has no mapped substation, say the electrical picture is unavailable here rather than guessing one exists. Missing data is a finding — report it. Do not invent asset names, capacities, populations, or distances; every number you give comes from a tool result.

When a question is about consequences, call simulate_failure rather than reasoning about the cascade in your head — the tool applies severity decay and onset timing you cannot estimate by eye.

USING NODE IDs
A node_id is only ever a literal string copied from a tool result or from the inventory below, such as "osm:way/12345678". Never invent one, never use a placeholder, and never guess. If you do not yet hold the exact ID you need, call find_nodes or weakest_points first, read the id field from what comes back, and only then call the tool that needs it. Do not issue a tool call whose argument depends on the result of another call you are making in the same turn — that result does not exist yet.`;

type Fn = Groq.Chat.Completions.ChatCompletionTool;

/*
 * survey_area is deliberately absent: its result is handed to the model in the
 * opening messages instead. Leaving the schema in place had every model spend a
 * round trip re-fetching what it had already been told, and each round trip is
 * both a second of latency and a full prompt charged against a per-minute token
 * budget. It stays implemented in runTool because that is what produces the
 * pre-injected inventory.
 */
const TOOLS: Fn[] = [
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

/**
 * Live vessel traffic, written for the model rather than for the panel.
 *
 * Handed over as context instead of behind a tool, for the same reason
 * `survey_area` is: the user has already asked for this data by pressing the
 * button, so a tool would only add a round trip and a schema in every prompt to
 * fetch something already in hand. The honesty caveats ride along with the data
 * because that is where they cannot be forgotten — a zero-vessel window means
 * "nothing heard", never "nothing there".
 */
function vesselBriefing(v: VesselTraffic): string {
  const where = v.near ? ` around ${v.near}` : "";
  const head = `Live vessel traffic was checked${where} at ${v.fetchedAt}, listening for ${v.windowSeconds} seconds.`;

  const body = v.vessels.length
    ? `${v.vessels.length} vessel${v.vessels.length === 1 ? "" : "s"} broadcasting:\n${v.vessels
        .map((s) =>
          [
            s.name,
            s.type,
            s.lengthM ? `${s.lengthM} m LOA` : null,
            s.draughtM ? `draught ${s.draughtM} m` : null,
            s.speedKn == null ? null : `${s.speedKn.toFixed(1)} kn`,
            s.destination ? `bound ${s.destination}` : null,
            `${s.distanceM} m from the structure`,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n")}`
    : "No vessel broadcast during the window.";

  return `${head}
${body}
${v.gap ? `${v.gap}\n` : ""}
How to use this: it is a snapshot of one short window from crowd-sourced shore receivers, not a census and not a traffic study — a moored ship broadcasts only every few minutes and may be missing. It applies only to the structure named above; say so plainly if asked about any other. A large vessel under way near a bridge with no current AASHTO assessment is the exposure worth naming: displacement and speed are what a pier has to absorb. Draught is depth below the waterline and says nothing about clearance under the deck, which is not in this data at all. Do not turn a single window into a rate, a frequency, or an annual figure.`;
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

/** Groq's raw errors are JSON blobs; the panel needs a sentence a human can act on. */
function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/rate_limit|tokens per minute|TPM/i.test(raw)) {
    return "Groq's free tier allows 8,000 tokens a minute, and this question needed more. Wait about a minute and ask again — the graph stays loaded, so nothing is recomputed.";
  }
  if (/401|invalid_api_key|Unauthorized/i.test(raw)) {
    return "Groq rejected the API key. Check GROQ_API_KEY.";
  }
  if (/tool_use_failed|Failed to call a function/i.test(raw)) {
    return "The model emitted a malformed tool call and the request was rejected. Ask again — this is usually transient.";
  }
  return raw;
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

  /*
   * If asset retrieval failed, every graph tool would otherwise return an empty
   * string — and an empty tool result is exactly what invites a model to invent
   * an answer. Say so explicitly instead. site_context and ask_mireye still work
   * without a graph, so they are exempt.
   */
  const assets = g.nodes.filter((n) => n.kind !== "population" && n.kind !== "county");
  if (assets.length === 0 && name !== "site_context" && name !== "ask_mireye") {
    const why = g.gaps.map((x) => `${x.dataset}: ${x.reason}`).join("; ");
    return `The infrastructure graph for this location is EMPTY — no assets were retrieved, so no dependency question can be answered from it. Cause: ${why || "unknown"}. Tell the user the infrastructure data failed to load and that this is a retrieval failure, not a finding about the place. Do not describe, name, or characterise any asset.`;
  }

  switch (name) {
    case "survey_area": {
      const counts = new Map<string, number>();
      for (const n of g.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
      const top = [...g.nodes]
        .filter((n) => n.kind !== "population")
        .sort((a, b) => b.criticality - a.criticality)
        // Kept short on purpose: tool results ride in the prompt on every
        // subsequent turn, and the token budget is per minute.
        .slice(0, 8);
      for (const r of rulesUsed(g)) evidence.rules.push(r.rule);

      return JSON.stringify(
        {
          location: result.place.label,
          county: g.nodes.find((n) => n.kind === "population")?.name ?? null,
          radius: `${(result.radiusM / 1000).toFixed(1)} km around the query point`,
          node_count: g.nodes.length,
          edge_count: g.edges.length,
          counts_by_kind: Object.fromEntries(counts),
          most_critical_assets: top.map(brief),
          inference_rules_applied: rulesUsed(g),
          data_gaps: g.gaps.slice(0, 6),
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
      return hits.slice(0, 25).map(brief).join("\n");
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
          impacts: res.impacts.slice(0, 12).map((i) => ({
            asset: i.name,
            kind: i.kind,
            severity: i.severity,
            onset_hours: i.onsetHours,
            hops: i.depth,
            // Only the final hop's rationale: the full chain repeats the
            // upstream text on every impact and dominates the payload.
            why: i.reasoning[i.reasoning.length - 1] ?? null,
          })),
        },
        null,
        1,
      );
    }

    case "weakest_points": {
      const ranked = weakestPoints(g, Number(input.limit) || 8);
      touch(ranked.map((r) => r.node.id));
      if (!ranked.length) {
        return "No asset in this graph has any modelled downstream dependents, so no weakest point can be ranked. Report that, rather than describing one.";
      }
      // JSON, not prose: node_id has to be copyable verbatim into the next
      // call, and models misread IDs embedded in a formatted sentence.
      return JSON.stringify(
        {
          ranked_by: "blast radius — how much of the local system fails with this asset",
          results: ranked.map((r, i) => ({
            rank: i + 1,
            node_id: r.node.id,
            name: r.node.name,
            kind: r.node.kind,
            score: r.score,
            downstream_assets: r.reachCount,
            population_at_risk: r.populationAtRisk,
          })),
        },
        null,
        1,
      );
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
  /** Out-of-band vessel check the user already ran, if any. See vesselBriefing. */
  vesselTraffic?: VesselTraffic | null,
): AsyncGenerator<AgentEvent> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    yield { type: "error", message: "GROQ_API_KEY is not set." };
    return;
  }

  /*
   * No SDK-level retrying. Its backoff for a 429 is a silent sleep of tens of
   * seconds, which outlives the serverless request and turns a recoverable rate
   * limit into a blank answer. Rate limits are handled below instead, by moving
   * the call to a model with its own token allowance.
   */
  const client = new Groq({ apiKey, maxRetries: 0 });
  const rateLimited = (e: unknown) => /rate.?limit|429|tokens per minute|TPM/i.test(String(e));
  const evidence: TurnEvidence = {
    touchedNodeIds: [],
    citations: result.graph.sources.map((s) => ({
      name: s.name,
      url: s.url,
      confidence: s.confidence,
    })),
    rules: [],
  };

  /*
   * The inventory is handed over up front rather than left for the model to
   * fetch. survey_area was the model's first call on essentially every question,
   * and a round trip that always has the same answer is a round trip worth
   * deleting — it cost a second or more of the budget and taught the model
   * nothing it could not be told.
   */
  const convo: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    {
      role: "system",
      content: `Inventory of the graph you are working with:\n${await runTool("survey_area", {}, result, evidence)}`,
    },
    ...(vesselTraffic ? [{ role: "system" as const, content: vesselBriefing(vesselTraffic) }] : []),
    ...messages,
  ];

  const deadline = Date.now() + TOOL_BUDGET_MS;
  let sawText = false;

  // Each iteration is one model turn; the loop ends when the model stops calling tools.
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    /*
     * Out of time, or out of turns: keep the tools visible so the transcript
     * stays coherent, but forbid calling them. The model then has to write its
     * answer from what it already gathered, which is always better than being
     * cut off mid-investigation with nothing to show.
     */
    const mustAnswer = turn === MAX_TURNS - 1 || Date.now() > deadline;

    const messagesFor = (): Groq.Chat.Completions.ChatCompletionMessageParam[] =>
      mustAnswer
        ? [
            ...convo,
            {
              role: "system",
              content:
                "You are out of time for gathering data. Write your answer now, using only what the tool results above already contain. Do not call any more tools. If the evidence is not enough to answer fully, say plainly what you could not establish.",
            },
          ]
        : convo;

    const call = (model: string, withTools: boolean) =>
      client.chat.completions.create({
        model,
        messages: messagesFor(),
        ...(withTools ? { tools: TOOLS, tool_choice: mustAnswer ? "none" : "auto" } : {}),
        stream: true,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      });

    let stream;
    try {
      stream = await call(MODEL, true);
    } catch (e) {
      /*
       * Retry only on the wrap-up turn, and only there. That turn writes prose
       * from evidence already gathered, so it is the one place the weaker
       * fallback model is a fair substitute — putting it on a tool-calling turn
       * was measured trading a clear "rate limited, wait a minute" message for a
       * confusing malformed-tool-call one, which is a worse answer, not a better.
       *
       * Two rejections are worth retrying there:
       *
       * Rate limit — the per-minute allowance is metered per model, so the same
       * call against the fallback model has a full budget of its own.
       *
       * tool_use_failed — Groq rejects the entire request when the model tries
       * to call a tool that tool_choice forbade. This is exactly where that
       * happens, because most of the system prompt is instructions to use tools.
       * Dropping the schemas removes the temptation and shortens the prompt.
       */
      const recoverable =
        mustAnswer && (rateLimited(e) || /tool_use_failed|Tool choice is none/i.test(String(e)));
      if (!recoverable) {
        yield { type: "error", message: friendlyError(e) };
        return;
      }
      try {
        stream = await call(rateLimited(e) ? FALLBACK_MODEL : MODEL, false);
      } catch (retry) {
        yield { type: "error", message: friendlyError(retry) };
        return;
      }
    }

    let content = "";
    const partials: PartialCall[] = [];

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          sawText = true;
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
      yield { type: "error", message: friendlyError(e) };
      return;
    }

    const calls = partials.filter((c): c is PartialCall => Boolean(c?.name));
    if (calls.length === 0) {
      // No tools and no prose means the turn produced nothing usable — usually
      // the completion budget went entirely on reasoning tokens. Saying so beats
      // rendering an empty answer bubble.
      if (!sawText) {
        yield {
          type: "error",
          message:
            "The model returned an empty response. Ask again, or rephrase the question more narrowly.",
        };
      }
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
