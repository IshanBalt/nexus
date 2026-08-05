/** Core domain model for the Nexus knowledge graph. */

export type NodeKind =
  // lifeline facilities
  | "hospital"
  | "school"
  | "fire_station"
  | "police"
  | "shelter"
  // energy
  | "power_plant"
  | "substation"
  | "transmission_line"
  // transport
  | "bridge"
  | "road"
  | "rail"
  | "airport"
  | "port"
  // water
  | "water_treatment"
  | "wastewater"
  | "pump_station"
  | "waterway"
  // comms
  | "cell_tower"
  // environment + hazard
  | "floodplain"
  | "wildfire_zone"
  | "superfund"
  // administrative / abstract
  | "population"
  | "county"
  | "site";

export type Rel =
  | "DEPENDS_ON"
  | "SERVES"
  | "SUPPLIES"
  | "CONNECTED_TO"
  | "CROSSES"
  | "LOCATED_IN"
  | "THREATENS"
  | "PROTECTS"
  | "ADJACENT_TO"
  | "UPSTREAM_OF"
  | "DOWNSTREAM_OF";

export type Confidence = "high" | "medium" | "low" | "unknown";

/** Provenance attached to every node, edge, and claim. Nothing enters the graph uncited. */
export interface Source {
  /** Human-readable dataset name, e.g. "FEMA NFHL" or "OpenStreetMap". */
  name: string;
  /** Verification URL a skeptical judge can actually open. */
  url: string;
  fetchedAt: string;
  confidence: Confidence;
  /** Dataset vintage where the upstream API reports one. */
  vintage?: string;
}

/** A LineString for ways (roads, rivers, transmission lines); undefined for point features. */
export type Line = [number, number][];

export interface GeoNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Representative point. For ways this is the centroid of the geometry. */
  lat: number;
  lng: number;
  geometry?: Line;
  /** Raw upstream attributes (OSM tags, Mireye fields). Kept for agent inspection. */
  tags: Record<string, string | number | boolean>;
  sources: Source[];
  /**
   * How much the surrounding system loses if this node fails, 0-1.
   * Seeded per-kind, then adjusted by attributes (road class, plant capacity).
   */
  criticality: number;
  /** Population directly served, where derivable. */
  servesPopulation?: number;
  /**
   * Set by R10 when this bridge is one of the 68 the NTSB named in MIR-25-10 as
   * needing a vessel-collision vulnerability assessment.
   */
  ntsbListed?: {
    /** Name as the NTSB list gives it, which is often not the local one. */
    matchedName: string;
    state: string;
    waterway: string;
  };
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: Rel;
  /** Dependency strength 0-1. Cascade severity multiplies through this. */
  weight: number;
  /** Why this edge exists, in plain language. Surfaced in the evidence panel. */
  rationale: string;
  confidence: Confidence;
  /** ID of the inference rule that produced this edge, for auditability. */
  rule: string;
}

export interface KnowledgeGraph {
  nodes: GeoNode[];
  edges: GraphEdge[];
  /** Query location that anchored this graph. */
  center: { lat: number; lng: number };
  bbox: BBox;
  /** Every dataset consulted, including ones that returned nothing. */
  sources: Source[];
  /** Datasets that failed or had no coverage here — surfaced, never hidden. */
  gaps: { dataset: string; reason: string }[];
  builtAt: string;
}

/** [west, south, east, north] */
export type BBox = [number, number, number, number];

export interface CascadeImpact {
  nodeId: string;
  name: string;
  kind: NodeKind;
  /** 0-1 share of function lost. */
  severity: number;
  /** Hops from the origin failure. */
  depth: number;
  /** Node IDs from origin to here, for "show your work". */
  path: string[];
  /** Concatenated edge rationales along the path. */
  reasoning: string[];
  populationAffected?: number;
  /** Hours after the initiating event that this impact begins to bite. */
  onsetHours: number;
}

export interface CascadeResult {
  originId: string;
  scenario: string;
  impacts: CascadeImpact[];
  totalPopulationAffected: number;
  /** Impacts grouped into onset bands for the timeline UI. */
  timeline: { band: string; impacts: string[] }[];
  notes: string[];
}
