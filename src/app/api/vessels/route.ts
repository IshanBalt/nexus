import { NextResponse } from "next/server";
import { fetchVesselTraffic } from "@/lib/sources/ais";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  lat: number;
  lng: number;
  /** Metres. Defaults to the subscription radius in ais.ts. */
  radius?: number;
  /** Structure being checked, echoed back so the answer can name it. */
  near?: string;
}

/**
 * A buffered JSON route, on purpose: it is deliberately outside the agent's tool
 * budget (see the header of lib/sources/ais.ts), so the collection window costs
 * the chat turn nothing.
 *
 * Always 200. A missing key, a refused socket and an empty channel all come back
 * as a result carrying a `gap`, because each of those is something the evidence
 * panel should say out loud rather than something the button should fail on.
 */
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

  const traffic = await fetchVesselTraffic(body.lat, body.lng, body.radius);
  return NextResponse.json({
    ...traffic,
    near: typeof body.near === "string" ? body.near : undefined,
  });
}
