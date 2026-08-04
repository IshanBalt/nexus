import { NextResponse } from "next/server";
import { DEFAULT_RADIUS, getOrAnalyze, resolvePlace } from "@/lib/analyze";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Body {
  lat: number;
  lng: number;
  radius?: number;
  messages: { role: "user" | "assistant"; content: string }[];
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

  const place = await resolvePlace(`${body.lat},${body.lng}`);
  place.lat = body.lat;
  place.lng = body.lng;
  const result = await getOrAnalyze(place, body.radius ?? DEFAULT_RADIUS);

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
