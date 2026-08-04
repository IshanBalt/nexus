import { NextResponse } from "next/server";
import { DEFAULT_RADIUS, getOrAnalyze, resolvePlace } from "@/lib/analyze";
import { simulate, weakestPoints } from "@/lib/cascade";

export const runtime = "nodejs";
export const maxDuration = 120;

interface Body {
  lat: number;
  lng: number;
  radius?: number;
  /** Omit to get the ranked weakest points instead of a single cascade. */
  nodeId?: string;
  scenario?: string;
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

  const place = await resolvePlace(`${body.lat},${body.lng}`);
  place.lat = body.lat;
  place.lng = body.lng;
  const { graph } = await getOrAnalyze(place, body.radius ?? DEFAULT_RADIUS);

  if (!body.nodeId) {
    return NextResponse.json({
      weakest: weakestPoints(graph, 8).map((w) => ({
        nodeId: w.node.id,
        name: w.node.name,
        kind: w.node.kind,
        score: w.score,
        reachCount: w.reachCount,
        populationAtRisk: w.populationAtRisk,
      })),
    });
  }

  if (!graph.nodes.some((n) => n.id === body.nodeId)) {
    return NextResponse.json({ error: `Unknown node ${body.nodeId}` }, { status: 404 });
  }

  return NextResponse.json(
    simulate(graph, body.nodeId, { scenario: body.scenario }),
  );
}
