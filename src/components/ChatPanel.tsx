"use client";

import { useEffect, useRef, useState } from "react";

export interface Step {
  name: string;
  input: unknown;
  summary?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: Step[];
  error?: string;
}

const TOOL_LABEL: Record<string, string> = {
  survey_area: "Surveying the area",
  find_nodes: "Locating assets",
  what_depends_on: "Tracing dependents",
  what_this_needs: "Tracing dependencies",
  simulate_failure: "Running cascade simulation",
  weakest_points: "Ranking failure points",
  site_context: "Reading site context",
  ask_mireye: "Querying Mireye",
};

const SUGGESTIONS = [
  "What is the weakest point here?",
  "What depends on the main bridge?",
  "What happens if the substation fails?",
  "What would flooding affect?",
];

interface Props {
  messages: ChatMessage[];
  streaming: string;
  liveSteps: Step[];
  busy: boolean;
  ready: boolean;
  placeLabel: string | null;
  onSend: (text: string) => void;
}

export default function ChatPanel({
  messages,
  streaming,
  liveSteps,
  busy,
  ready,
  placeLabel,
  onSend,
}: Props) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming, liveSteps]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !ready) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--panel)" }}>
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--rule)" }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: ready ? "var(--calm)" : "var(--ink-faint)" }}
          />
          <span className="label">Analysis</span>
        </div>
        {placeLabel && (
          <span
            className="max-w-[58%] truncate text-[10.5px]"
            style={{ color: "var(--ink-dim)" }}
            title={placeLabel}
          >
            {placeLabel}
          </span>
        )}
      </header>

      <div ref={scroller} className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {messages.length === 0 && !busy && (
          <div className="rise space-y-5 pt-2">
            <p className="prose-reasoning" style={{ color: "var(--ink-dim)" }}>
              {ready
                ? "The graph for this location is built. Ask what depends on what, or what breaks next."
                : "Pick a location to begin — click the map, or search a place, address, or coordinate pair."}
            </p>
            {ready && (
              <div className="space-y-1.5">
                <div className="label mb-2">Try</div>
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={s}
                    onClick={() => onSend(s)}
                    className="rise block w-full cursor-pointer border px-3 py-2 text-left text-[12px] transition-colors"
                    style={{
                      borderColor: "var(--rule)",
                      color: "var(--ink-dim)",
                      animationDelay: `${i * 55}ms`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--signal)";
                      e.currentTarget.style.color = "var(--ink-bright)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--rule)";
                      e.currentTarget.style.color = "var(--ink-dim)";
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="rise">
              <div className="label mb-1.5">Question</div>
              <p
                className="border-l-2 pl-3 text-[13px]"
                style={{ borderColor: "var(--signal)", color: "var(--ink-bright)" }}
              >
                {m.content}
              </p>
            </div>
          ) : (
            <div key={i} className="rise space-y-3">
              {m.steps && m.steps.length > 0 && <StepList steps={m.steps} />}
              {m.content && <Prose text={m.content} />}
              {m.error && (
                <p className="text-[12px]" style={{ color: "var(--severe)" }}>
                  {m.error}
                </p>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="space-y-3">
            {liveSteps.length > 0 && <StepList steps={liveSteps} live />}
            {streaming ? (
              <Prose text={streaming} cursor />
            ) : (
              <div className="label blink">Reasoning…</div>
            )}
          </div>
        )}
      </div>

      <div className="border-t p-3" style={{ borderColor: "var(--rule)" }}>
        <div
          className="flex items-end gap-2 border px-3 py-2 transition-colors focus-within:border-[var(--signal)]"
          style={{ borderColor: "var(--rule)", background: "var(--base)" }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={!ready}
            placeholder={ready ? "Ask about this place…" : "Select a location first"}
            className="max-h-28 flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-[var(--ink-faint)] disabled:cursor-not-allowed"
            style={{ color: "var(--ink-bright)" }}
          />
          <button
            onClick={submit}
            disabled={busy || !ready || !draft.trim()}
            className="label shrink-0 cursor-pointer pb-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            style={{ color: draft.trim() && !busy ? "var(--signal)" : undefined }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function StepList({ steps, live }: { steps: Step[]; live?: boolean }) {
  return (
    <ol className="space-y-1">
      {steps.map((s, i) => {
        const pending = live && i === steps.length - 1 && !s.summary;
        return (
          <li key={i} className="flex items-baseline gap-2 text-[11px]">
            <span
              className={pending ? "blink" : ""}
              style={{ color: pending ? "var(--signal)" : "var(--calm)" }}
            >
              {pending ? "▸" : "▪"}
            </span>
            <span style={{ color: "var(--ink-dim)" }}>
              {TOOL_LABEL[s.name] ?? s.name}
              <ToolArgs input={s.input} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ToolArgs({ input }: { input: unknown }) {
  if (!input || typeof input !== "object") return null;
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (!entries.length) return null;
  const text = entries.map(([, v]) => String(v)).join(", ");
  return (
    <span style={{ color: "var(--ink-faint)" }}>
      {" — "}
      {text.length > 52 ? `${text.slice(0, 52)}…` : text}
    </span>
  );
}

/**
 * Minimal inline formatting for the agent's prose. The model writes plain
 * paragraphs with occasional bold, so a full markdown dependency would be
 * dead weight here.
 */
function Prose({ text, cursor }: { text: string; cursor?: boolean }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className="prose-reasoning">
      {paragraphs.map((p, i) => (
        <p key={i}>
          {inline(p)}
          {cursor && i === paragraphs.length - 1 && (
            <span className="blink" style={{ color: "var(--signal)" }}>
              {" ▍"}
            </span>
          )}
        </p>
      ))}
    </div>
  );
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
