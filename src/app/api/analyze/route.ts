import { NextResponse } from "next/server";
import { DEFAULT_RADIUS, getOrAnalyze, resolvePlace, type ResolvedPlace } from "@/lib/analyze";

export const runtime = "nodejs";
// Overpass alone can take 30s on a dense metro.
export const maxDuration = 120;

interface Body {
  /** Free text, address, or "lat,lng". Ignored when lat/lng are given. */
  query?: string;
  lat?: number;
  lng?: number;
  radius?: number;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const radius = clampRadius(body.radius);

  let place: ResolvedPlace;
  try {
    if (typeof body.lat === "number" && typeof body.lng === "number") {
      if (!Number.isFinite(body.lat) || Math.abs(body.lat) > 90) {
        return NextResponse.json({ error: "lat out of range" }, { status: 400 });
      }
      if (!Number.isFinite(body.lng) || Math.abs(body.lng) > 180) {
        return NextResponse.json({ error: "lng out of range" }, { status: 400 });
      }
      // Resolve the coordinate so the answer carries a place name, not just numbers.
      place = await resolvePlace(`${body.lat},${body.lng}`);
      place.lat = body.lat;
      place.lng = body.lng;
    } else if (body.query?.trim()) {
      place = await resolvePlace(body.query.trim());
    } else {
      return NextResponse.json({ error: "Provide either query or lat/lng" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not resolve location" },
      { status: 422 },
    );
  }

  try {
    const result = await getOrAnalyze(place, radius);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 500 },
    );
  }
}

function clampRadius(r: unknown): number {
  const n = typeof r === "number" && Number.isFinite(r) ? r : DEFAULT_RADIUS;
  // Below 1 km the graph is too sparse to reason over; above 8 km a dense metro
  // blows past Overpass's element cap and the serverless time budget.
  return Math.min(8000, Math.max(1000, n));
}
