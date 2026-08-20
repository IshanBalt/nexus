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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgent } from "./agent";
import { DEFAULT_RADIUS, getOrAnalyze, resolvePlace } from "./analyze";
import { ESCALATION_THRESHOLD, sweepFleet, type FleetEntry, type FleetSweep } from "./fleet";
import { hasMireyeKey } from "./mireye";

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
  /**
   * Set when the sweep ran but could not write about what it found. Absent
   * briefs and no briefs worth writing are different outcomes and the page
   * should not show them the same way.
   */
  briefGap?: string;
}

/**
 * Triage needs nothing but the NWS and USGS, which are public and keyless.
 * Writing needs Groq to write and Mireye to know what the structure carries.
 *
 * So the watch is built to run at two depths rather than to fail at one. With
 * no credentials at all it still sweeps all 59 structures every half hour and
 * publishes a dated, checkable record of the readings — the part that decides
 * is the part that runs free. Credentials add the written brief on top. A
 * scheduled run that skips the prose is a real run; a scheduled run that dies
 * on a missing key is an outage, and an agent that stops the moment its
 * expensive dependency is unavailable is not a watch anyone should trust.
 */
function briefingAvailable(): string | null {
  const missing = [
    process.env.GROQ_API_KEY ? null : "GROQ_API_KEY",
    hasMireyeKey() ? null : "MIREYE_API_TOKEN",
  ].filter(Boolean);
  return missing.length ? missing.join(" and ") : null;
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
 * The graph node for this structure, if R10 actually found it.
 *
 * Asking whether the graph has *anything* in it is the wrong question, and the
 * first version of this asked it: Philadelphia returns a floodplain and a
 * turnpike, passes that test, and the agent then writes a careful paragraph
 * explaining that it cannot find the Benjamin Franklin Bridge. R10 already
 * answers the question that matters — a node carrying this structure's NTSB
 * match is the structure, found and identified — so use that, and hand the id
 * over rather than making the model spend a turn searching for what we already
 * hold.
 */
async function locate(entry: FleetEntry): Promise<string | null> {
  try {
    const place = await resolvePlace(`${entry.lat},${entry.lng}`);
    place.lat = entry.lat;
    place.lng = entry.lng;
    const { graph } = await getOrAnalyze(place, DEFAULT_RADIUS);
    return graph.nodes.find((n) => n.ntsbListed?.matchedName === entry.name)?.id ?? null;
  } catch {
    return null;
  }
}

async function writeBrief(entry: FleetEntry, nodeId: string): Promise<Brief> {
  const question = [
    `${entry.name} carries the NTSB's MIR-25-10 listing: designed before AASHTO's vessel-collision guidance, spanning ${entry.waterway}, no current vulnerability assessment on record.`,
    `Live right now: ${entry.signals.map((s) => s.detail).join(" ")}`,
    `The structure is node "${nodeId}". Call simulate_failure on it once, then write — every extra tool call spends a minute of the token budget. What does this structure carry, who loses what if it comes down today, and does today's condition change the case for assessing it? Under 200 words. Do not restate the tool calls.`,
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

/** Briefs from the artifact already on disk, for structures still escalated. */
function carriedBriefs(outPath: string, stillEscalated: Set<string>): Brief[] {
  try {
    const prev = JSON.parse(readFileSync(outPath, "utf8")) as SweepArtifact;
    return prev.briefs.filter((b) => !b.failed && stillEscalated.has(b.structure));
  } catch {
    return [];
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

  const missingKeys = briefingAvailable();
  if (missingKeys) console.log(`  no ${missingKeys} — publishing readings without writing`);

  for (const entry of missingKeys ? [] : candidates) {
    if (briefs.filter((b) => !b.failed).length >= MAX_BRIEFS) break;
    const nodeId = await locate(entry);
    if (!nodeId) {
      console.log(`  skipping ${entry.name} — not present in the graph built for its coordinates`);
      continue;
    }
    if (briefs.length > 0) await sleep(BRIEF_SPACING_MS);
    console.log(`  briefing ${entry.name} (${nodeId})…`);
    const b = await writeBrief(entry, nodeId);
    console.log(b.failed ? `    failed: ${b.failed.slice(0, 80)}` : `    ${b.answer.length} chars via ${b.toolsUsed.join(", ") || "no tools"}`);
    briefs.push(b);
  }

  // Keep what an earlier run wrote about anything still over the threshold that
  // this run did not get to — whether that was a missing key, a token budget
  // spent on higher-ranked structures, or Overpass declining to return the
  // bridge this time. A brief carries the moment it was written and the panel
  // prints its age, so an older brief on a structure still escalated is worth
  // more than a blank. Briefs for structures that have gone quiet are dropped:
  // those describe weather that is over.
  const written = new Set(briefs.filter((b) => !b.failed).map((b) => b.structure));
  const held = carriedBriefs(
    outPath,
    new Set(candidates.map((c) => c.name).filter((n) => !written.has(n))),
  );
  if (held.length) console.log(`  carrying ${held.length} earlier brief(s) still on the board`);
  briefs.push(...held);

  const briefGap = missingKeys
    ? `${candidates.length} structure${candidates.length === 1 ? "" : "s"} met the escalation threshold on readings alone, and this run wrote about none of them: it had no ${missingKeys}. ` +
      (held.length
        ? `The ${held.length} brief${held.length === 1 ? "" : "s"} below ${held.length === 1 ? "is" : "are"} carried from an earlier run and dated accordingly — the readings are current, that prose is not.`
        : `The readings are the whole of what it produced.`) +
      ` They were still measured, timestamped and published on schedule.`
    : undefined;

  const artifact: SweepArtifact = { ...sweep, briefs, briefGap };
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
