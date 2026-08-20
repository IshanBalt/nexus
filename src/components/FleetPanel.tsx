"use client";

import { useEffect, useState } from "react";
import { NTSB_BRIDGES } from "@/lib/data/ntsb-bridges";
import type { FleetEntry } from "@/lib/fleet";
import type { Brief, SweepArtifact } from "@/lib/sweep-run";

/**
 * What the agent found while nobody was watching.
 *
 * This is the first thing on screen, and that is the point. A map waiting to be
 * clicked puts the work on the reader and shows nothing until they guess right;
 * this arrives with 59 federally-flagged structures already triaged, ranked by
 * what is happening to them today, and says when it ran.
 */

/**
 * Ohio reports six of these by ODOT structure file number, so the federal list
 * calls one of them "LUC-00002-1862" and everyone else calls it the Anthony
 * Wayne Bridge. Lead with the name a human uses and keep the federal reference
 * beside it, because the reference is what makes the claim checkable.
 */
const COMMON = new Map(NTSB_BRIDGES.filter((b) => b.aliases?.length).map((b) => [b.name, b.aliases![0]]));
const isFileNumber = (name: string) => /^[A-Z]{3}-\d/.test(name);

const band = (score: number) =>
  score >= 0.65 ? "var(--severe)" : score >= 0.5 ? "var(--signal)" : "var(--ink-dim)";

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

interface Props {
  onOpen: (entry: FleetEntry) => void;
  onAsk: (entry: FleetEntry, question: string) => void;
}

export default function FleetPanel({ onOpen, onAsk }: Props) {
  const [sweep, setSweep] = useState<SweepArtifact | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showQuiet, setShowQuiet] = useState(false);

  useEffect(() => {
    fetch("/api/fleet")
      .then((r) => r.json())
      .then(setSweep)
      .catch(() => setSweep(null));
  }, []);

  if (!sweep) return null;

  const active = sweep.structures.filter((s) => s.signals.length > 0);
  const quiet = sweep.structures.filter((s) => s.signals.length === 0);
  const shown = showQuiet ? [...active, ...quiet] : active;
  const briefFor = (name: string): Brief | undefined =>
    sweep.briefs.find((b) => b.structure === name && !b.failed);

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--panel)" }}>
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--rule)" }}>
        <div className="flex items-baseline justify-between">
          <span className="label">Standing watch</span>
          <span className="text-[10px]" style={{ color: "var(--ink-faint)" }}>
            swept {ago(sweep.ranAt)}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--ink-dim)" }}>
          {sweep.watched} bridges the NTSB named in MIR-25-10 as needing a vessel-collision
          assessment, checked against live federal weather and river data. Nobody started this run.
        </p>
        <div className="mt-2 flex gap-4">
          <Stat n={active.length} label="with a live signal" color="var(--signal)" />
          <Stat n={sweep.escalated.length} label="over threshold" color="var(--severe)" />
          <Stat n={quiet.length} label="quiet" color="var(--ink-faint)" />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {shown.map((s) => {
          const brief = briefFor(s.name);
          const open = expanded === s.name;
          return (
            <section
              key={`${s.name}-${s.state}`}
              className="border-b px-4 py-2.5"
              style={{ borderColor: "var(--rule)" }}
            >
              <button
                onClick={() => setExpanded(open ? null : s.name)}
                className="flex w-full cursor-pointer items-baseline gap-2.5 text-left"
              >
                <span
                  className="shrink-0 text-[11px] tabular-nums"
                  style={{ color: band(s.score) }}
                >
                  {s.score.toFixed(2)}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[12px]"
                  style={{ color: "var(--ink-bright)" }}
                >
                  {COMMON.get(s.name) ?? s.name}
                  {isFileNumber(s.name) && (
                    <span className="ml-1.5 text-[10px]" style={{ color: "var(--ink-faint)" }}>
                      {s.name}
                    </span>
                  )}
                </span>
                {brief && (
                  <span className="label shrink-0" style={{ color: "var(--calm)" }}>
                    briefed
                  </span>
                )}
                <span className="shrink-0 text-[10px]" style={{ color: "var(--ink-faint)" }}>
                  {s.state}
                </span>
              </button>

              <div className="mt-0.5 pl-[38px] text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
                {s.waterway}
              </div>

              {open && (
                <div className="mt-2 pl-[38px]">
                  {s.signals.map((sig, i) => (
                    <div
                      key={i}
                      className="mb-2 border-l-2 pl-2.5"
                      style={{
                        borderColor: sig.level === "high" ? "var(--severe)" : "var(--signal)",
                      }}
                    >
                      <div className="text-[11px]" style={{ color: "var(--ink)" }}>
                        {sig.headline}{" "}
                        <span style={{ color: "var(--ink-faint)" }}>+{sig.weight.toFixed(2)}</span>
                      </div>
                      <p className="text-[10.5px] leading-snug" style={{ color: "var(--ink-dim)" }}>
                        {sig.detail}
                      </p>
                      <a
                        href={sig.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[10px] underline underline-offset-2"
                        style={{ color: "var(--ink-faint)" }}
                      >
                        {sig.kind === "weather" ? "NWS" : "USGS"} ↗
                      </a>
                    </div>
                  ))}

                  {s.gaps.map((g, i) => (
                    <p
                      key={i}
                      className="mb-1.5 text-[10px] leading-snug"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      {g}
                    </p>
                  ))}

                  {brief && (
                    <div
                      className="mb-2 border-l-2 pl-2.5"
                      style={{ borderColor: "var(--calm)" }}
                    >
                      <div className="label mb-1" style={{ color: "var(--calm)" }}>
                        Written {ago(brief.writtenAt)} without being asked
                      </div>
                      <p className="prose-reasoning text-[11px]" style={{ color: "var(--ink)" }}>
                        {brief.answer}
                      </p>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      onClick={() => onOpen(s)}
                      className="label cursor-pointer transition-colors hover:text-[var(--ink)]"
                      style={{ color: "var(--signal)" }}
                    >
                      Open the graph →
                    </button>
                    <button
                      onClick={() =>
                        onAsk(
                          s,
                          `${s.name} over ${s.waterway}. ${s.verdict} ${s.signals
                            .map((x) => x.detail)
                            .join(" ")} What would be lost if it came down today?`,
                        )
                      }
                      className="label cursor-pointer transition-colors hover:text-[var(--ink)]"
                    >
                      Ask about it →
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}

        <button
          onClick={() => setShowQuiet((v) => !v)}
          className="label w-full cursor-pointer px-4 py-3 text-left transition-colors hover:text-[var(--ink)]"
        >
          {showQuiet ? "Hide" : "Show"} the {quiet.length} with nothing against them today
        </button>

        {sweep.excluded.length > 0 && (
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--rule)" }}>
            <div className="label mb-1.5">Not watched ({sweep.excluded.length})</div>
            {sweep.excluded.map((x) => (
              <p
                key={x.name}
                className="mb-1 text-[10px] leading-snug"
                style={{ color: "var(--ink-faint)" }}
              >
                <span style={{ color: "var(--ink-dim)" }}>{x.name}</span> — {x.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const Stat = ({ n, label, color }: { n: number; label: string; color: string }) => (
  <div>
    <div className="text-[15px] tabular-nums" style={{ color }}>
      {n}
    </div>
    <div className="text-[9.5px] uppercase" style={{ color: "var(--ink-faint)" }}>
      {label}
    </div>
  </div>
);
