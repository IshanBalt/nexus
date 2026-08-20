import { NextResponse } from "next/server";
import fleet from "@/data/fleet-latest.json";

export const runtime = "nodejs";

/**
 * The last unattended sweep, served from the artifact it wrote.
 *
 * Deliberately not computed on request. A sweep is 118 calls to two federal
 * APIs and takes about fifteen seconds, which is most of a serverless request's
 * life and is rude to endpoints run for everyone's benefit — and it would mean
 * the page a reader lands on is only as good as this second's luck with
 * Overpass. The sweep runs on its own schedule, commits what it found, and this
 * hands over that file: instant, and identical for everyone looking at it.
 */
export function GET() {
  return NextResponse.json(fleet, {
    headers: { "cache-control": "public, max-age=60, stale-while-revalidate=600" },
  });
}
