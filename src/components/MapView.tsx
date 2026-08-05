"use client";

import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";
import { KIND_COLOR, LINEAR, severityColor } from "@/lib/display";
import type { CascadeResult, KnowledgeGraph } from "@/lib/types";

/*
 * MapLibre 6 ships its worker as a separate ES module that imports a sibling,
 * `./maplibre-gl-shared.mjs`, by that literal name. Turbopack emits both files
 * but content-hashes them — `maplibre-gl-shared.<hash>.mjs` — without rewriting
 * the import inside the worker. The worker then 404s on the unhashed name, the
 * dispatcher never initialises, and the symptom is a map that looks broken in a
 * way that points nowhere near the real cause: style.json loads, attribution
 * fills in, `load` never fires, not one tile is requested, and the canvas stays
 * black with no error on the map's own error event.
 *
 * So serve the pair ourselves, under their real names, out of public/ — see the
 * copy:maplibre script in package.json. Both files must sit in the same
 * directory for the relative import to resolve.
 */
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const SATELLITE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const HILLSHADE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}";

export type Basemap = "dark" | "satellite" | "terrain";

interface Props {
  graph: KnowledgeGraph | null;
  center: { lat: number; lng: number } | null;
  /** Nodes the agent touched this turn. */
  tracedIds: string[];
  cascade: CascadeResult | null;
  /** When set, only cascade impacts with onset <= this many hours are lit. */
  timelineHours: number | null;
  selectedId: string | null;
  basemap: Basemap;
  onPick: (lat: number, lng: number) => void;
  onSelectNode: (id: string | null) => void;
}

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: "FeatureCollection", features: [] };

export default function MapView({
  graph,
  center,
  tracedIds,
  cascade,
  timelineHours,
  selectedId,
  basemap,
  onPick,
  onSelectNode,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const marker = useRef<Marker | null>(null);

  // Callbacks live in refs so the map is built once and never torn down on
  // re-render — recreating a GL context per keystroke is the classic MapLibre
  // performance trap.
  const onPickRef = useRef(onPick);
  const onSelectRef = useRef(onSelectNode);
  onPickRef.current = onPick;
  onSelectRef.current = onSelectNode;

  // -------------------------------------------------------------------------
  // Derived GeoJSON
  // -------------------------------------------------------------------------
  const severityById = useMemo(() => {
    const m = new Map<string, number>();
    if (!cascade) return m;
    for (const i of cascade.impacts) {
      if (timelineHours != null && i.onsetHours > timelineHours) continue;
      m.set(i.nodeId, i.severity);
    }
    if (timelineHours == null || timelineHours >= 0) m.set(cascade.originId, 1);
    return m;
  }, [cascade, timelineHours]);

  const { points, ways, edges } = useMemo(() => {
    if (!graph) return { points: EMPTY, ways: EMPTY, edges: EMPTY };
    const traced = new Set(tracedIds);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    const pointFeatures: GeoJSON.Feature[] = [];
    const wayFeatures: GeoJSON.Feature[] = [];

    for (const n of graph.nodes) {
      if (n.kind === "population" || n.kind === "county") continue; // abstract, not placeable
      const sev = severityById.get(n.id) ?? 0;
      const props = {
        id: n.id,
        name: n.name,
        kind: n.kind,
        criticality: n.criticality,
        color: sev > 0 ? severityColor(sev) : KIND_COLOR[n.kind],
        sev,
        traced: traced.has(n.id) ? 1 : 0,
        selected: n.id === selectedId ? 1 : 0,
        // An amber ring on the bridges the NTSB flagged, so a listed structure
        // is visible before anything is clicked.
        ntsb: n.ntsbListed ? 1 : 0,
      };

      if (n.geometry && n.geometry.length > 1 && LINEAR.includes(n.kind)) {
        wayFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: n.geometry },
          properties: props,
        });
        // Linear features still get a clickable handle at their centroid.
        if (n.kind !== "waterway") {
          pointFeatures.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [n.lng, n.lat] },
            properties: { ...props, handle: 1 },
          });
        }
      } else if (n.kind !== "waterway") {
        // Waterways are never drawn as dots, with or without a centreline. The
        // channel R10 materialises for a navigable strait OSM maps as an area
        // sits on its bridge's own coordinates, so a point for it would render
        // on top of the structure and take the click meant for it.
        pointFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [n.lng, n.lat] },
          properties: { ...props, handle: 0 },
        });
      }
    }

    // Dependency edges as straight connectors between asset centroids. They
    // encode topology, not routing, so a straight line is the honest drawing.
    const edgeFeatures: GeoJSON.Feature[] = [];
    for (const e of graph.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      if (a.kind === "population" || b.kind === "population") continue;
      const lit = traced.has(a.id) && traced.has(b.id);
      const inCascade = severityById.has(a.id) && severityById.has(b.id);
      edgeFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [a.lng, a.lat],
            [b.lng, b.lat],
          ],
        },
        properties: {
          rel: e.rel,
          weight: e.weight,
          lit: lit || inCascade ? 1 : 0,
          color: inCascade ? "#ff5a52" : lit ? "#4dd0e1" : "#3a4854",
        },
      });
    }

    return {
      points: { type: "FeatureCollection", features: pointFeatures } as FC,
      ways: { type: "FeatureCollection", features: wayFeatures } as FC,
      edges: { type: "FeatureCollection", features: edgeFeatures } as FC,
    };
  }, [graph, tracedIds, severityById, selectedId]);

  // -------------------------------------------------------------------------
  // Map construction (once)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new MapLibreMap({
      container: container.current,
      style: BASEMAP,
      center: [-98.6, 39.8],
      zoom: 3.4,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

    // Without this, a rejected style, a bad expression, or a failed tile fetch
    // is swallowed and the map simply renders nothing with no explanation.
    m.on("error", (e) => {
      console.error("[nexus/map]", (e as { error?: Error }).error?.message ?? e);
    });

    m.on("load", () => {
      m.addSource("sat", { type: "raster", tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 19 });
      m.addLayer({
        id: "sat",
        type: "raster",
        source: "sat",
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0.85 },
      });
      m.addSource("hill", {
        type: "raster",
        tiles: [HILLSHADE_TILES],
        tileSize: 256,
        maxzoom: 16,
      });
      m.addLayer({
        id: "hill",
        type: "raster",
        source: "hill",
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0.5 },
      });

      m.addSource("edges", { type: "geojson", data: EMPTY });
      m.addSource("ways", { type: "geojson", data: EMPTY });
      m.addSource("points", { type: "geojson", data: EMPTY });

      m.addLayer({
        id: "edges",
        type: "line",
        source: "edges",
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["==", ["get", "lit"], 1], 1.6, 0.5],
          "line-opacity": ["case", ["==", ["get", "lit"], 1], 0.85, 0.22],
        },
      });

      m.addLayer({
        id: "ways",
        type: "line",
        source: "ways",
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 4.5],
          "line-opacity": ["case", [">", ["to-number", ["get", "sev"]], 0], 0.95, 0.55],
        },
      });

      // Soft halo underneath so bright asset dots separate from the basemap.
      m.addLayer({
        id: "points-halo",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": ["get", "color"],
          // to-number is required: interpolate's input must be typed number,
          // and a bare `get` is type `value`, which throws at addLayer.
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["to-number", ["get", "criticality"]],
            0.3,
            7,
            1,
            17,
          ],
          "circle-opacity": [
            "case",
            [
              "any",
              ["==", ["get", "traced"], 1],
              [">", ["to-number", ["get", "sev"]], 0],
            ],
            0.28,
            0.07,
          ],
          "circle-blur": 0.55,
        },
      });

      m.addLayer({
        id: "points",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["to-number", ["get", "criticality"]],
            0.3,
            3,
            1,
            8.5,
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "selected"], 1],
            2.2,
            ["==", ["get", "ntsb"], 1],
            2,
            ["==", ["get", "traced"], 1],
            1.4,
            0.5,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "selected"], 1],
            "#ffffff",
            ["==", ["get", "ntsb"], 1],
            "#ffb020",
            ["==", ["get", "traced"], 1],
            "#4dd0e1",
            "#0a0d11",
          ],
          "circle-opacity": 0.95,
        },
      });

      m.addLayer({
        id: "point-labels",
        type: "symbol",
        source: "points",
        minzoom: 12.5,
        filter: [
          "any",
          [">", ["to-number", ["get", "criticality"]], 0.74],
          ["==", ["get", "traced"], 1],
          ["==", ["get", "ntsb"], 1],
          [">", ["to-number", ["get", "sev"]], 0],
        ],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Regular"],
          "text-size": 10.5,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-max-width": 13,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#dbe3ec",
          "text-halo-color": "#0a0d11",
          "text-halo-width": 1.6,
        },
      });

      ready.current = true;
      m.getCanvas().style.cursor = "crosshair";
    });

    // A click on an asset selects it; a click on open map picks a new location.
    m.on("click", (ev) => {
      if (!ready.current) return;
      const hits = m.queryRenderedFeatures(ev.point, { layers: ["points", "ways"] });
      const id = hits[0]?.properties?.id as string | undefined;
      if (id) {
        onSelectRef.current(id);
        return;
      }
      onSelectRef.current(null);
      onPickRef.current(ev.lngLat.lat, ev.lngLat.lng);
    });

    m.on("mousemove", (ev) => {
      if (!ready.current) return;
      const hits = m.queryRenderedFeatures(ev.point, { layers: ["points", "ways"] });
      m.getCanvas().style.cursor = hits.length ? "pointer" : "crosshair";
    });

    /*
     * MapLibre measures its container once, at construction. This component is
     * loaded via next/dynamic, so on first paint the grid cell frequently has
     * no layout yet — the map then latches its 400x300 fallback, requests no
     * tiles, and renders nothing forever, because nothing tells it otherwise.
     * Observing the container covers that race and every later resize (window,
     * panel, devtools) for free.
     */
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Data + view sync
  // -------------------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      (m.getSource("points") as GeoJSONSource | undefined)?.setData(points);
      (m.getSource("ways") as GeoJSONSource | undefined)?.setData(ways);
      (m.getSource("edges") as GeoJSONSource | undefined)?.setData(edges);
    };
    if (ready.current) apply();
    else m.once("load", apply);
  }, [points, ways, edges]);

  useEffect(() => {
    const m = map.current;
    if (!m || !center) return;
    m.flyTo({ center: [center.lng, center.lat], zoom: 13.2, speed: 1.1, curve: 1.5 });

    marker.current?.remove();
    const el = document.createElement("div");
    el.style.cssText =
      "width:13px;height:13px;border-radius:50%;background:#ffb020;border:2px solid #0a0d11;box-shadow:0 0 0 1px #ffb020";
    el.className = "pulse";
    marker.current = new Marker({ element: el })
      .setLngLat([center.lng, center.lat])
      .addTo(m);
  }, [center]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      m.setLayoutProperty("sat", "visibility", basemap === "satellite" ? "visible" : "none");
      m.setLayoutProperty("hill", "visibility", basemap === "terrain" ? "visible" : "none");
    };
    if (ready.current) apply();
    else m.once("load", apply);
  }, [basemap]);

  /*
   * Sized with h-full/w-full rather than `absolute inset-0`: MapLibre's own
   * stylesheet applies `.maplibregl-map { position: relative }` to this very
   * element, which beats the utility class. The element then stops being
   * positioned, `inset-0` no longer sizes it, and its height collapses to zero
   * — MapLibre reads clientHeight 0, falls back to a 300px canvas, and never
   * requests a single tile. Explicit sizing is immune to that override.
   */
  return <div ref={container} className="h-full w-full" />;
}
