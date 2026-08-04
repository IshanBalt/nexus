import type { NodeKind } from "./types";

/**
 * One colour per asset class, grouped by system so the map reads as systems
 * rather than confetti: red/orange = life safety, amber = energy, blue = water,
 * cyan = structures, grey = surface transport.
 */
export const KIND_COLOR: Record<NodeKind, string> = {
  hospital: "#ff5a52",
  fire_station: "#ff8a4c",
  police: "#6c8ae4",
  shelter: "#c98a5a",

  power_plant: "#ffd166",
  substation: "#ffb020",
  transmission_line: "#a87c2a",

  bridge: "#4dd0e1",
  road: "#7a8794",
  rail: "#9c7bd9",
  airport: "#58c3a0",
  port: "#43a08a",

  water_treatment: "#45b8e0",
  wastewater: "#3e8fa8",
  pump_station: "#56a8c4",
  waterway: "#2e6e8e",

  cell_tower: "#a0a8b4",
  school: "#e0c060",

  floodplain: "#2f6fa8",
  wildfire_zone: "#c25a2a",
  superfund: "#8a6fb0",

  population: "#e8edf2",
  county: "#5c6875",
  site: "#ffffff",
};

export const KIND_LABEL: Record<NodeKind, string> = {
  hospital: "Hospital",
  school: "School",
  fire_station: "Fire station",
  police: "Police",
  shelter: "Shelter",
  power_plant: "Power plant",
  substation: "Substation",
  transmission_line: "Transmission",
  bridge: "Bridge",
  road: "Road",
  rail: "Rail",
  airport: "Airport",
  port: "Port",
  water_treatment: "Water treatment",
  wastewater: "Wastewater",
  pump_station: "Pump station",
  waterway: "Waterway",
  cell_tower: "Comms tower",
  floodplain: "Flood zone",
  wildfire_zone: "Wildfire zone",
  superfund: "Superfund",
  population: "Population",
  county: "County",
  site: "Site",
};

/** Kinds drawn as lines rather than points. */
export const LINEAR: NodeKind[] = ["road", "rail", "waterway", "transmission_line"];

/** Amber through red as a cascade impact gets more severe. */
export function severityColor(severity: number): string {
  if (severity >= 0.7) return "#ff5a52";
  if (severity >= 0.45) return "#ff8a4c";
  if (severity >= 0.25) return "#ffb020";
  return "#c9a15a";
}

export const CONFIDENCE_COLOR: Record<string, string> = {
  high: "#58c3a0",
  medium: "#ffb020",
  low: "#ff8a4c",
  unknown: "#6d7c8c",
};

export const fmtInt = (n: number) => n.toLocaleString("en-US");

export function fmtHours(h: number): string {
  if (h < 1) return "immediate";
  if (h < 24) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(h < 72 ? 1 : 0)} d`;
}
