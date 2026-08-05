"use client";

import { CONFIDENCE_COLOR, KIND_COLOR, KIND_LABEL, fmtHours, fmtInt, severityColor } from "@/lib/display";
import type { VesselTraffic } from "@/lib/sources/ais";
import type { CascadeResult, GeoNode, KnowledgeGraph } from "@/lib/types";

interface Props {
  graph: KnowledgeGraph | null;
  mireyeFields: Record<string, unknown>;
  selected: GeoNode | null;
  cascade: CascadeResult | null;
  simulating: boolean;
  timelineHours: number | null;
  /** The last vessel check, shown only against the structure it was run on. */
  vessels: VesselTraffic | null;
  checkingVessels: boolean;
  onSimulate: (nodeId: string) => void;
  onCheckVessels: (node: GeoNode) => void;
  /** Puts a question to the agent, the same path the chat suggestions use. */
  onAsk: (question: string) => void;
  onClearCascade: () => void;
}

const NTSB_URL = "https://www.ntsb.gov/investigations/AccidentReports/Reports/MIR2510.pdf";

const RULE_LABEL: Record<string, string> = {
  "R1:road_access": "Arterial road access",
  "R2:bridge_carries_road": "Bridge carries road",
  "R2:bridge_crosses_water": "Bridge over watercourse",
  "R3:grid_supply": "Electrical supply",
  "R4:transmission_feed": "Transmission feed",
  "R4:generation_source": "Generation source",
  "R6:potable_water": "Potable water supply",
  "R6:pump_power": "Pump station power",
  "R7:water_crosses_road": "Watercourse crosses road",
  "R8:flood_exposure": "Flood exposure",
  "R9:hospital_serves": "Hospital catchment",
  "R9:lifeline_serves": "Lifeline service area",
  "R10:vessel_strike_exposure": "Vessel-strike exposure (NTSB)",
};

export default function EvidencePanel({
  graph,
  mireyeFields,
  selected,
  cascade,
  simulating,
  timelineHours,
  vessels,
  checkingVessels,
  onSimulate,
  onCheckVessels,
  onAsk,
  onClearCascade,
}: Props) {
  return (
    <div className="flex h-full flex-col" style={{ background: "var(--panel)" }}>
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--rule)" }}>
        <span className="label">Evidence</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        {!graph && (
          <p className="px-4 py-6 text-[12px]" style={{ color: "var(--ink-faint)" }}>
            Sources, confidence levels, and reasoning steps appear here once a location is
            analysed.
          </p>
        )}

        {graph && (
          <>
            {selected && (
              <Section title="Selected asset">
                <div className="mb-2 flex items-start gap-2">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: KIND_COLOR[selected.kind] }}
                  />
                  <div className="min-w-0">
                    <div
                      className="truncate text-[12.5px]"
                      style={{ color: "var(--ink-bright)" }}
                      title={selected.name}
                    >
                      {selected.name}
                    </div>
                    <div className="text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
                      {KIND_LABEL[selected.kind]} · criticality {selected.criticality.toFixed(2)}
                      {selected.servesPopulation
                        ? ` · serves ~${fmtInt(selected.servesPopulation)}`
                        : ""}
                    </div>
                  </div>
                </div>
                {selected.ntsbListed && (
                  <div
                    className="mb-2.5 border-l-2 pl-2.5"
                    style={{ borderColor: "var(--signal)" }}
                  >
                    <div className="text-[11px]" style={{ color: "var(--signal)" }}>
                      NTSB vessel-strike list
                    </div>
                    <p className="text-[10.5px] leading-snug" style={{ color: "var(--ink-dim)" }}>
                      Listed as “{selected.ntsbListed.matchedName}” ({selected.ntsbListed.state}),
                      spanning {selected.ntsbListed.waterway}. One of the 68 spans recommended for
                      an AASHTO Method II vulnerability assessment after the Key Bridge collapse,
                      with none on record.
                    </p>
                    <a
                      href={NTSB_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 block truncate text-[10px] underline underline-offset-2"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      NTSB MIR-25-10, 20 March 2025 ↗
                    </a>
                  </div>
                )}

                <button
                  onClick={() => onSimulate(selected.id)}
                  disabled={simulating}
                  className="w-full cursor-pointer border py-1.5 text-[11px] tracking-wide uppercase transition-colors disabled:cursor-wait disabled:opacity-50"
                  style={{ borderColor: "var(--severe)", color: "var(--severe)" }}
                >
                  {simulating ? "Simulating…" : "Simulate failure"}
                </button>

                {/* Offered on any bridge, not only a listed one: a judge clicking
                    somewhere unplanned should still see the water side work. */}
                {selected.kind === "bridge" && (
                  <button
                    onClick={() => onCheckVessels(selected)}
                    disabled={checkingVessels}
                    className="mt-1.5 w-full cursor-pointer border py-1.5 text-[11px] tracking-wide uppercase transition-colors disabled:cursor-wait disabled:opacity-50"
                    style={{ borderColor: "var(--trace)", color: "var(--trace)" }}
                  >
                    {checkingVessels ? "Listening…" : "Check live vessel traffic"}
                  </button>
                )}

                {selected.ntsbListed && (
                  <button
                    onClick={() =>
                      onAsk(
                        // The node id is handed over rather than left to be
                        // looked up: a find_nodes turn the panel can save is a
                        // whole round trip against an 8000-token minute.
                        `Write a vessel-strike exposure brief for ${selected.name} (node id "${selected.id}"). Call simulate_failure on it once, then write — the NTSB finding and the water are already in front of you, and every extra tool call spends a minute of the token budget. Set the land-side cascade against what the NTSB found and whatever is on the water right now, then say who carries the exposure and what they should do about it. State the NTSB finding only as the edge rationale states it — it is a listing, not an investigation of this structure. Under 250 words.`,
                      )
                    }
                    className="mt-1.5 w-full cursor-pointer border py-1.5 text-[11px] tracking-wide uppercase transition-colors"
                    style={{ borderColor: "var(--signal)", color: "var(--signal)" }}
                  >
                    Generate exposure brief
                  </button>
                )}
                {selected.sources[0] && (
                  <a
                    href={selected.sources[0].url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-2 block truncate text-[10px] underline underline-offset-2"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    {selected.sources[0].name} ↗
                  </a>
                )}
              </Section>
            )}

            {vessels && (
              <Section title="Live vessel traffic">
                <div className="mb-2 text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
                  {vessels.windowSeconds > 0
                    ? `${vessels.windowSeconds}s window · ${new Date(vessels.fetchedAt).toLocaleTimeString()}`
                    : "not collected"}
                </div>

                <ul className="space-y-2">
                  {vessels.vessels.map((v) => (
                    <li
                      key={v.mmsi}
                      className="border-l-2 pl-2.5"
                      style={{ borderColor: "var(--trace)" }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className="truncate text-[11.5px]"
                          style={{ color: "var(--ink-bright)" }}
                        >
                          {v.name}
                        </span>
                        <span
                          className="shrink-0 text-[10px] tabular-nums"
                          style={{ color: "var(--ink-dim)" }}
                        >
                          {v.distanceM} m
                        </span>
                      </div>
                      <div className="text-[10px]" style={{ color: "var(--ink-faint)" }}>
                        {[
                          v.type,
                          v.lengthM ? `${v.lengthM} m` : null,
                          v.draughtM ? `draught ${v.draughtM} m` : null,
                          v.speedKn == null ? null : `${v.speedKn.toFixed(1)} kn`,
                          v.destination ? `→ ${v.destination}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </li>
                  ))}
                </ul>

                {vessels.gap && (
                  <p
                    className="mt-2 border-l-2 pl-2.5 text-[10.5px] leading-snug"
                    style={{ borderColor: "var(--rule-bright)", color: "var(--ink-dim)" }}
                  >
                    {vessels.gap}
                  </p>
                )}

                <a
                  href="https://aisstream.io"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 block text-[10px] underline underline-offset-2"
                  style={{ color: "var(--ink-faint)" }}
                >
                  aisstream.io — live AIS ↗
                </a>
              </Section>
            )}

            {cascade && (
              <Section
                title="Cascade"
                action={
                  <button
                    onClick={onClearCascade}
                    className="label cursor-pointer transition-colors hover:text-[var(--ink)]"
                  >
                    Clear
                  </button>
                }
              >
                <div className="mb-3">
                  <div className="text-[12px]" style={{ color: "var(--ink-bright)" }}>
                    {cascade.scenario}
                  </div>
                  <div className="text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
                    {cascade.impacts.length} downstream asset
                    {cascade.impacts.length === 1 ? "" : "s"}
                    {cascade.totalPopulationAffected > 0 &&
                      ` · ~${fmtInt(cascade.totalPopulationAffected)} residents affected`}
                  </div>
                </div>

                <ol className="space-y-2">
                  {cascade.impacts.slice(0, 14).map((im) => {
                    const dimmed = timelineHours != null && im.onsetHours > timelineHours;
                    return (
                      <li
                        key={im.nodeId}
                        className="border-l-2 pl-2.5 transition-opacity"
                        style={{
                          borderColor: severityColor(im.severity),
                          opacity: dimmed ? 0.24 : 1,
                          marginLeft: `${(im.depth - 1) * 10}px`,
                        }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className="truncate text-[11.5px]"
                            style={{ color: "var(--ink-bright)" }}
                          >
                            {im.name}
                          </span>
                          <span
                            className="shrink-0 text-[10px] tabular-nums"
                            style={{ color: severityColor(im.severity) }}
                          >
                            {Math.round(im.severity * 100)}%
                          </span>
                        </div>
                        <div className="text-[10px]" style={{ color: "var(--ink-faint)" }}>
                          {KIND_LABEL[im.kind]} · onset {fmtHours(im.onsetHours)} · {im.depth} hop
                          {im.depth === 1 ? "" : "s"}
                        </div>
                        {im.reasoning.length > 0 && (
                          <p
                            className="mt-1 text-[10.5px] leading-snug"
                            style={{ color: "var(--ink-dim)" }}
                          >
                            {im.reasoning[im.reasoning.length - 1]}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>

                {cascade.notes.map((n, i) => (
                  <p
                    key={i}
                    className="mt-3 border-l-2 pl-2.5 text-[10.5px] leading-snug"
                    style={{ borderColor: "var(--rule-bright)", color: "var(--ink-dim)" }}
                  >
                    {n}
                  </p>
                ))}
              </Section>
            )}

            <Section title={`Sources (${graph.sources.length})`}>
              {graph.sources.length === 0 && <Empty>No datasets returned data here.</Empty>}
              <ul className="space-y-1.5">
                {graph.sources.map((s) => (
                  <li key={s.name} className="flex items-baseline gap-2">
                    <span
                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: CONFIDENCE_COLOR[s.confidence] }}
                      title={`${s.confidence} confidence`}
                    />
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-w-0 flex-1 truncate text-[11px] underline decoration-transparent underline-offset-2 transition-colors hover:decoration-inherit"
                      style={{ color: "var(--ink-dim)" }}
                      title={s.url}
                    >
                      {s.name}
                    </a>
                    <span
                      className="shrink-0 text-[9.5px] uppercase"
                      style={{ color: CONFIDENCE_COLOR[s.confidence] }}
                    >
                      {s.confidence}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            {Object.keys(mireyeFields).length > 0 && (
              <Section title="Site context">
                <dl className="space-y-1">
                  {Object.entries(mireyeFields)
                    .filter(([, v]) => v !== null && v !== undefined && v !== "")
                    .map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3">
                        <dt className="truncate text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
                          {k.replace(/_/g, " ")}
                        </dt>
                        <dd
                          className="shrink-0 text-right text-[11px] tabular-nums"
                          style={{ color: "var(--ink)" }}
                        >
                          {typeof v === "number" ? fmtInt(Number(v.toFixed?.(2) ?? v)) : String(v)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </Section>
            )}

            <Section title="Inference rules applied">
              <ul className="space-y-1">
                {rulesOf(graph).map((r) => (
                  <li key={r.rule} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[10.5px]" style={{ color: "var(--ink-dim)" }}>
                      {RULE_LABEL[r.rule] ?? r.rule}
                    </span>
                    <span
                      className="shrink-0 text-[10.5px] tabular-nums"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      {r.count}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            {graph.gaps.length > 0 && (
              <Section title={`Data gaps (${graph.gaps.length})`}>
                <ul className="space-y-1.5">
                  {graph.gaps.slice(0, 30).map((g, i) => (
                    <li key={i} className="text-[10.5px] leading-snug">
                      <span style={{ color: "var(--ink-dim)" }}>{g.dataset}</span>
                      <span style={{ color: "var(--ink-faint)" }}> — {g.reason}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function rulesOf(g: KnowledgeGraph) {
  const counts = new Map<string, number>();
  for (const e of g.edges) counts.set(e.rule, (counts.get(e.rule) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rise border-b px-4 py-3.5" style={{ borderColor: "var(--rule)" }}>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="label">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[10.5px]" style={{ color: "var(--ink-faint)" }}>
    {children}
  </p>
);
