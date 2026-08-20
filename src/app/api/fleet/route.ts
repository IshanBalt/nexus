import { NextResponse } from "next/server";
import bundled from "@/data/fleet-latest.json";

export const runtime = "nodejs";

/**
 * The last unattended sweep.
 *
 * Deliberately not computed on request. A sweep is 118 calls to two federal
 * APIs and takes about fifteen seconds, which is most of a serverless request's
 * life and is rude to endpoints run for everyone's benefit — and it would mean
 * the page a reader lands on is only as good as this second's luck with
 * Overpass. The sweep runs on its own schedule and commits what it found.
 *
 * That artifact is read from the repository rather than from this deployment's
 * bundle, because otherwise the two are chained together: the watch runs every
 * half hour, each run commits, and each commit would rebuild the whole site to
 * change one JSON file. Reading the committed file directly means the schedule
 * and the deployment are independent — the watch stays current between deploys,
 * and forty-eight builds a day are not spent republishing a page that did not
 * change. The bundled copy is the fallback, so the panel still has something
 * true to show if GitHub is unreachable.
 */
const RAW =
  "https://raw.githubusercontent.com/IshanBalt/nexus/main/src/data/fleet-latest.json";

export async function GET() {
  try {
    const res = await fetch(RAW, {
      // Long enough that a burst of readers is one fetch, short enough that a
      // sweep landing is visible within a minute.
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const live = await res.json();
      return NextResponse.json(live, {
        headers: { "cache-control": "public, max-age=60, stale-while-revalidate=600" },
      });
    }
  } catch {
    // Fall through to the copy that shipped with this build.
  }

  return NextResponse.json(
    { ...bundled, servedFrom: "the copy bundled at deploy time — the live artifact was unreachable" },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}
