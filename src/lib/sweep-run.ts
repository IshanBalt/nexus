/**
 * The unattended run. `npm run sweep`, or the schedule in
 * .github/workflows/sweep.yml, and nobody clicks anything.
 *
 * Triage every located structure on the NTSB list, decide which ones a person
 * should hear about today, and have the agent write about those — then leave
 * the result on disk as a dated artifact. The site serves that file, so a
 * reader arrives to work already done rather than to an empty map, and the
 * findings are committed to git, which makes the claim "this ran at 14:02 and
 * saw a flood watch over the Delaware" checkable by anyone.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runAgent } from "./agent";
import { DEFAULT_RADIUS, getOrAnalyze, resolvePlace } from "./analyze";
import { ESCALATION_THRESHOLD, sweepFleet, type FleetEntry, type FleetSweep } from "./fleet";

export interface Brief {
  structure: string;
  question: string;
  answer: string;
  toolsUsed: string[];
  writtenAt: string;
  /** Set instead of an answer when the model could not be reached. */
  failed?: string;
}

export interface SweepArtifact extends FleetSweep {
  briefs: Brief[];
}

/**
 * Groq's free tier meters tokens per minute, and a brief costs two or three
 * calls. Spacing them is the difference between two briefs and two rate-limit
 * errors — see the note at the top of agent.ts.
 */
const BRIEF_SPACING_MS = 70_000;
const MAX_BRIEFS = Number(process.env.NEXUS_SWEEP_BRIEFS ?? 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether there is anything here to reason about.
 *
 * Overpass fails often enough that a sweep will sometimes reach a structure
 * with an empty graph, and an agent asked to brief on nothing writes a
 * paragraph explaining that it cannot — which is honest and worthless. Checking
 * first costs one cached analysis and saves a model call against a per-minute
 * budget, so the agent moves to the next structure on the list instead.
 */
async function hasGraph(entry: FleetEntry): Promise<boolean> {
  try {
    const place = await resolvePlace(`${entry.lat},${entry.lng}`);
    place.lat = entry.lat;
    place.lng = entry.lng;
    const { graph } = await getOrAnalyze(place, DEFAULT_RADIUS);
    return graph.nodes.some((n) => n.kind !== "population" && n.kind !== "county");
  } catch {
    return false;
  }
}

async function writeBrief(entry: FleetEntry): Promise<Brief> {
  const question = [
    `${entry.name} carries the NTSB's MIR-25-10 listing: designed before AASHTO's vessel-collision guidance, spanning ${entry.waterway}, no current vulnerability assessment on record.`,
    `Live right now: ${entry.signals.map((s) => s.detail).join(" ")}`,
    `Find the bridge with find_nodes, call simulate_failure on it once, then write. What does this structure carry, who loses what if it comes down today, and does today's condition change the case for assessing it? Under 200 words. Do not restate the tool calls.`,
  ].join("\n\n");

  const written = new Date().toISOString();
  try {
    const place = await resolvePlace(`${entry.lat},${entry.lng}`);
    place.lat = entry.lat;
    place.lng = entry.lng;
    const result = await getOrAnalyze(place, DEFAULT_RADIUS);

    let answer = "";
    const toolsUsed: string[] = [];
    let failed: string | undefined;
    for await (const ev of runAgent([{ role: "user", content: question }], result)) {
      if (ev.type === "text") answer += ev.text;
      else if (ev.type === "tool") toolsUsed.push(ev.name);
      else if (ev.type === "error") failed = ev.message;
    }
    return answer
      ? { structure: entry.name, question, answer, toolsUsed, writtenAt: written }
      : { structure: entry.name, question, answer: "", toolsUsed, writtenAt: written, failed: failed ?? "the model returned nothing" };
  } catch (e) {
    return {
      structure: entry.name,
      question,
      answer: "",
      toolsUsed: [],
      writtenAt: written,
      failed: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runSweep(outPath: string): Promise<SweepArtifact> {
  const sweep = await sweepFleet(8);
  console.log(
    `swept ${sweep.watched} structures in ${(sweep.durationMs / 1000).toFixed(1)}s — ` +
      `${sweep.structures.filter((s) => s.signals.length).length} with a live signal, ` +
      `${sweep.structures.filter((s) => s.score >= ESCALATION_THRESHOLD).length} over the escalation threshold`,
  );

  const briefs: Brief[] = [];
  // Work down the ranking rather than taking a fixed slice: a structure whose
  // infrastructure data did not load is skipped and the next one gets the turn.
  const candidates = sweep.structures.filter((s) => s.score >= ESCALATION_THRESHOLD);

  for (const entry of candidates) {
    if (briefs.filter((b) => !b.failed).length >= MAX_BRIEFS) break;
    if (!(await hasGraph(entry))) {
      console.log(`  skipping ${entry.name} — no infrastructure data loaded for it`);
      continue;
    }
    if (briefs.length > 0) await sleep(BRIEF_SPACING_MS);
    console.log(`  briefing ${entry.name}…`);
    const b = await writeBrief(entry);
    console.log(b.failed ? `    failed: ${b.failed.slice(0, 80)}` : `    ${b.answer.length} chars via ${b.toolsUsed.join(", ") || "no tools"}`);
    briefs.push(b);
  }

  const artifact: SweepArtifact = { ...sweep, briefs };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
  console.log(`wrote ${outPath}`);
  return artifact;
}

// Run directly: tsx src/lib/sweep-run.ts
if (process.argv[1]?.includes("sweep-run")) {
  // Not top-level await: tsx transpiles this file to CommonJS, where that is a
  // syntax error rather than a slow path.
  runSweep(path.join(__dirname, "..", "data", "fleet-latest.json")).catch((e) => {
    console.error("sweep failed:", e);
    process.exit(1);
  });
}
