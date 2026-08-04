"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import ChatPanel, { type ChatMessage, type Step } from "@/components/ChatPanel";
import EvidencePanel from "@/components/EvidencePanel";
import type { Basemap } from "@/components/MapView";
import { fmtHours, fmtInt } from "@/lib/display";
import type { AnalyzeResult } from "@/lib/analyze";
import type { CascadeResult, GeoNode } from "@/lib/types";

// MapLibre touches `window` at import time, so it can never render on the server.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0" style={{ background: "var(--base)" }} />,
});

/** Named so the progress readout says what is actually in flight. */
const STAGES = [
  "Resolving location",
  "Querying OpenStreetMap infrastructure",
  "Fetching Mireye terrain, utilities and hazards",
  "Constructing knowledge graph",
];

export default function Home() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [basemap, setBasemap] = useState<Basemap>("dark");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [liveSteps, setLiveSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [tracedIds, setTracedIds] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadeResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [timelineHours, setTimelineHours] = useState<number | null>(null);

  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const graph = result?.graph ?? null;
  const selected: GeoNode | null = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  const maxOnset = useMemo(
    () => (cascade?.impacts.length ? Math.max(...cascade.impacts.map((i) => i.onsetHours)) : 0),
    [cascade],
  );

  // -------------------------------------------------------------------------
  const runAnalyze = useCallback(async (body: Record<string, unknown>) => {
    setLoading(true);
    setLoadError(null);
    setStage(0);
    setMessages([]);
    setTracedIds([]);
    setCascade(null);
    setSelectedId(null);
    setTimelineHours(null);

    stageTimer.current = setInterval(
      () => setStage((s) => Math.min(s + 1, STAGES.length - 1)),
      1400,
    );

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Analysis failed (${res.status})`);
      setResult(json as AnalyzeResult);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      if (stageTimer.current) clearInterval(stageTimer.current);
      setLoading(false);
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!result) return;
      const history: ChatMessage[] = [...messages, { role: "user", content: text }];
      setMessages(history);
      setBusy(true);
      setStreaming("");
      setLiveSteps([]);
      setTracedIds([]);

      const steps: Step[] = [];
      let acc = "";
      let error: string | undefined;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lat: result.place.lat,
            lng: result.place.lng,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res.body) throw new Error("No response stream");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // NDJSON: one event per line, so a partial trailing chunk must be held back.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.type === "text") {
              acc += ev.text;
              setStreaming(acc);
            } else if (ev.type === "tool") {
              steps.push({ name: ev.name, input: ev.input });
              setLiveSteps([...steps]);
            } else if (ev.type === "tool_result") {
              const last = steps[steps.length - 1];
              if (last) last.summary = ev.summary;
              setLiveSteps([...steps]);
            } else if (ev.type === "done") {
              setTracedIds(ev.evidence.touchedNodeIds ?? []);
            } else if (ev.type === "error") {
              error = ev.message;
            }
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "Request failed";
      }

      setMessages([...history, { role: "assistant", content: acc, steps, error }]);
      setStreaming("");
      setLiveSteps([]);
      setBusy(false);
    },
    [messages, result],
  );

  const simulate = useCallback(
    async (nodeId: string) => {
      if (!result) return;
      setSimulating(true);
      try {
        const node = result.graph.nodes.find((n) => n.id === nodeId);
        const res = await fetch("/api/simulate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lat: result.place.lat,
            lng: result.place.lng,
            nodeId,
            scenario: node ? `${node.name} offline` : undefined,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Simulation failed");
        setCascade(json as CascadeResult);
        setTimelineHours(null);
      } catch {
        setCascade(null);
      } finally {
        setSimulating(false);
      }
    },
    [result],
  );

  // -------------------------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-12 shrink-0 items-center gap-4 border-b px-4"
        style={{ borderColor: "var(--rule)", background: "var(--panel)" }}
      >
        <div className="flex shrink-0 items-baseline gap-2.5">
          <span
            className="text-[15px] font-semibold tracking-[0.2em]"
            style={{ color: "var(--ink-bright)" }}
          >
            NEXUS
          </span>
          <span className="label hidden lg:inline">Physical World Intelligence</span>
        </div>

        <form
          className="flex min-w-0 flex-1 justify-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim() && !loading) runAnalyze({ query: query.trim() });
          }}
        >
          <div
            className="flex w-full max-w-lg items-center gap-2 border px-3 py-1.5 transition-colors focus-within:border-[var(--signal)]"
            style={{ borderColor: "var(--rule)", background: "var(--base)" }}
          >
            <span style={{ color: "var(--ink-faint)" }}>⌖</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Seattle · Golden Gate Bridge · 47.60,-122.33 · or click the map"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--ink-faint)]"
              style={{ color: "var(--ink-bright)" }}
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="label shrink-0 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-30"
              style={{ color: query.trim() && !loading ? "var(--signal)" : undefined }}
            >
              Analyse
            </button>
          </div>
        </form>

        <div className="flex shrink-0 border" style={{ borderColor: "var(--rule)" }}>
          {(["dark", "satellite", "terrain"] as Basemap[]).map((b) => (
            <button
              key={b}
              onClick={() => setBasemap(b)}
              className="label cursor-pointer px-2.5 py-1 transition-colors"
              style={{
                color: basemap === b ? "var(--base)" : "var(--ink-faint)",
                background: basemap === b ? "var(--signal)" : "transparent",
              }}
            >
              {b === "dark" ? "Vector" : b === "satellite" ? "Satellite" : "Terrain"}
            </button>
          ))}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[340px_1fr_340px]">
        <div className="min-h-0 border-r" style={{ borderColor: "var(--rule)" }}>
          <ChatPanel
            messages={messages}
            streaming={streaming}
            liveSteps={liveSteps}
            busy={busy}
            ready={Boolean(result)}
            placeLabel={result?.place.label ?? null}
            onSend={send}
          />
        </div>

        <div className="relative min-h-0">
          <MapView
            graph={graph}
            center={result ? { lat: result.place.lat, lng: result.place.lng } : null}
            tracedIds={tracedIds}
            cascade={cascade}
            timelineHours={timelineHours}
            selectedId={selectedId}
            basemap={basemap}
            onPick={(lat, lng) => !loading && runAnalyze({ lat, lng })}
            onSelectNode={setSelectedId}
          />

          {graph && !loading && (
            <div
              className="rise pointer-events-none absolute top-3 left-3 border px-3 py-2"
              style={{ borderColor: "var(--rule)", background: "rgba(15,20,26,0.9)" }}
            >
              <div className="label mb-1">Graph</div>
              <div className="text-[11px] tabular-nums" style={{ color: "var(--ink)" }}>
                {fmtInt(graph.nodes.length)} nodes · {fmtInt(graph.edges.length)} edges
              </div>
              <div className="text-[10px] tabular-nums" style={{ color: "var(--ink-faint)" }}>
                built in {((result?.timings.total ?? 0) / 1000).toFixed(1)}s ·{" "}
                {graph.sources.length} sources
              </div>
            </div>
          )}

          {loading && <LoadingOverlay stage={stage} />}

          {loadError && (
            <div
              className="rise absolute top-3 left-1/2 -translate-x-1/2 border px-4 py-2 text-[12px]"
              style={{
                borderColor: "var(--severe)",
                background: "rgba(15,20,26,0.95)",
                color: "var(--severe)",
              }}
            >
              {loadError}
            </div>
          )}

          {!result && !loading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rise max-w-md px-8 text-center">
                <p className="prose-reasoning" style={{ color: "var(--ink-dim)" }}>
                  Nexus builds a dependency graph of the physical world around any point in the
                  United States, then reasons over it — what depends on this, what breaks next, and
                  where the load-bearing failure points are.
                </p>
                <p className="label mt-5">Click anywhere on the map to begin</p>
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 border-l" style={{ borderColor: "var(--rule)" }}>
          <EvidencePanel
            graph={graph}
            mireyeFields={result?.mireyeFields ?? {}}
            selected={selected}
            cascade={cascade}
            simulating={simulating}
            timelineHours={timelineHours}
            onSimulate={simulate}
            onClearCascade={() => {
              setCascade(null);
              setTimelineHours(null);
            }}
          />
        </div>
      </main>

      {cascade && maxOnset > 0 && (
        <footer
          className="rise flex h-14 shrink-0 items-center gap-4 border-t px-4"
          style={{ borderColor: "var(--rule)", background: "var(--panel)" }}
        >
          <div className="shrink-0">
            <div className="label">Timeline</div>
            <div className="text-[11px] tabular-nums" style={{ color: "var(--signal)" }}>
              {timelineHours == null ? "full cascade" : `T + ${fmtHours(timelineHours)}`}
            </div>
          </div>

          <input
            type="range"
            min={0}
            max={Math.ceil(maxOnset)}
            step={1}
            value={timelineHours ?? Math.ceil(maxOnset)}
            onChange={(e) => setTimelineHours(Number(e.target.value))}
            aria-label="Hours after the initiating event"
            className="h-1 flex-1 cursor-pointer"
            style={{ accentColor: "var(--signal)" }}
          />

          <div className="shrink-0 text-right">
            <div className="text-[11px] tabular-nums" style={{ color: "var(--ink)" }}>
              {
                cascade.impacts.filter(
                  (i) => timelineHours == null || i.onsetHours <= timelineHours,
                ).length
              }{" "}
              / {cascade.impacts.length} affected
            </div>
            <div className="text-[10px]" style={{ color: "var(--ink-faint)" }}>
              {cascade.totalPopulationAffected > 0
                ? `~${fmtInt(cascade.totalPopulationAffected)} residents`
                : "no modelled population impact"}
            </div>
          </div>

          <button
            onClick={() => setTimelineHours(null)}
            className="label shrink-0 cursor-pointer transition-colors hover:text-[var(--ink)]"
          >
            Reset
          </button>
        </footer>
      )}
    </div>
  );
}

function LoadingOverlay({ stage }: { stage: number }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ background: "rgba(10,13,17,0.72)" }}
    >
      <div className="w-80 px-6">
        <div className="label mb-3">Building knowledge graph</div>
        <div
          className="sweep relative h-px w-full overflow-hidden"
          style={{ background: "var(--rule-bright)" }}
        />
        <ol className="mt-4 space-y-1.5">
          {STAGES.map((s, i) => (
            <li key={s} className="flex items-baseline gap-2 text-[11px]">
              <span
                className={i === stage ? "blink" : ""}
                style={{
                  color:
                    i < stage ? "var(--calm)" : i === stage ? "var(--signal)" : "var(--ink-faint)",
                }}
              >
                {i < stage ? "▪" : i === stage ? "▸" : "·"}
              </span>
              <span style={{ color: i <= stage ? "var(--ink-dim)" : "var(--ink-faint)" }}>{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
