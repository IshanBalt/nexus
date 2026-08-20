import type { BBox, Line } from "./types";

const R = 6_371_000; // Earth radius, metres

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Square bbox of the given radius around a point.
 * Longitude degrees shrink with latitude, so scale them by cos(lat).
 */
export function bboxAround(lat: number, lng: number, radiusM: number): BBox {
  const dLat = (radiusM / R) * (180 / Math.PI);
  const dLng = dLat / Math.max(Math.cos(rad(lat)), 0.01);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export function bboxContains(b: BBox, lat: number, lng: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

export function centroid(line: Line): { lat: number; lng: number } {
  if (line.length === 0) return { lat: 0, lng: 0 };
  let lat = 0;
  let lng = 0;
  for (const [ln, lt] of line) {
    lng += ln;
    lat += lt;
  }
  return { lat: lat / line.length, lng: lng / line.length };
}

/**
 * Distance in metres from a point to a polyline.
 *
 * Projects to a local equirectangular plane before doing the segment math —
 * accurate to well under a metre at the neighbourhood scales we query, and far
 * cheaper than a proper geodesic solve.
 */
export function distanceToLine(
  lat: number,
  lng: number,
  line: Line,
): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversine(lat, lng, line[0][1], line[0][0]);

  const kx = (Math.PI / 180) * R * Math.cos(rad(lat));
  const ky = (Math.PI / 180) * R;
  const px = lng * kx;
  const py = lat * ky;

  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = line[i][0] * kx;
    const ay = line[i][1] * ky;
    const bx = line[i + 1][0] * kx;
    const by = line[i + 1][1] * ky;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    // Clamp the projection to the segment so we measure to the segment, not the infinite line.
    const t =
      lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

/** Whether two polylines intersect, used to detect roads crossing rivers or rail. */
export function linesIntersect(a: Line, b: Line): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

type P = [number, number];

function segmentsIntersect(p1: P, p2: P, p3: P, p4: P): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

const cross = (a: P, b: P, c: P) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
export const metres = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : km(m);
