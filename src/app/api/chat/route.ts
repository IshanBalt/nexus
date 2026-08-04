import { NextResponse } from "next/server";
import { type AnalyzeResult, DEFAULT_RADIUS, getOrAnalyze, resolvePlace } from "@/lib/analyze";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Body {
  lat: number;
  lng: number;
  radius?: number;
  messages: { role: "user" | "assistant"; content: string }[];
  /** The analysis the client is already displaying. See `usable` below. */
  analysis?: AnalyzeResult;
}

/**
 * The in-process analysis cache only helps a warm instance, and chat is exactly
 * where a cold one hurts: rebuilding the graph costs an Overpass round trip plus
 * three Mireye calls — eight to eleven seconds — before the model gets its first
 * token, on a platform that kills the function about twenty seconds in.
 *
 * The client already holds the graph the map is drawing, so it sends it back and
 * the agent answers about exactly what the user is looking at. This is trusted
 * input, so keep it to what it is: public infrastructure data the client just
 * received from us, read-only, never persisted. A shape check is enough to stop
 * a malformed body from throwing deep inside a tool.
 */
function usable(a: unknown): a is AnalyzeResult {
  const r = a as AnalyzeResult | undefined;
  return Boolean(
    r &&
      Array.isArray(r.graph?.nodes) &&
      Array.isArray(r.graph?.edges) &&
      Array.isArray(r.graph?.sources) &&
      Array.isArray(r.graph?.gaps) &&
      typeof r.place?.lat === "number" &&
      typeof r.place?.lng === "number",
  );
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 });
  }

  let result: AnalyzeResult;
  if (usable(body.analysis)) {
    result = body.analysis;
    result.radiusM ??= body.radius ?? DEFAULT_RADIUS;
  } else {
    const place = await resolvePlace(`${body.lat},${body.lng}`);
    place.lat = body.lat;
    place.lng = body.lng;
    result = await getOrAnalyze(place, body.radius ?? DEFAULT_RADIUS);
  }

  const messages = body.messages
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  // Newline-delimited JSON: one event per line, so the client can render
  // reasoning steps and text as they arrive without a framing library.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        for await (const event of runAgent(messages, result)) send(event);
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
