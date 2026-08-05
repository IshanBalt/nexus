import type { Confidence } from "../types";

/**
 * Bridges the NTSB named in Marine Investigation Report MIR-25-10 (20 March
 * 2025) as needing a vessel-collision vulnerability assessment.
 *
 * The report followed the Francis Scott Key Bridge collapse in Baltimore on
 * 26 March 2024, when the containership Dali lost power and struck a pier. The
 * NTSB found the Key Bridge had been running at roughly thirty times AASHTO's
 * acceptable annual frequency of collapse — a number its owner could have
 * calculated at any point in the preceding decades and never had. It then went
 * looking for every other bridge in the same position: designed before AASHTO's
 * 1991 vessel-collision guidance existed, spanning a navigable channel, with no
 * current vulnerability assessment on record. Thirty owners across nineteen
 * states were told to run AASHTO Method II and, where it comes back over
 * threshold, to build a risk-reduction plan.
 *
 * The NTSB counts 68 *spans*: where a crossing carries separate eastbound and
 * westbound structures, each is assessed on its own. This table is keyed by
 * structure instead, because that is what OpenStreetMap gives us to match
 * against — the twin spans of the Verrazzano are one named feature in OSM, and
 * splitting them here would only produce two identical matches on the same node.
 *
 * Source: https://www.ntsb.gov/investigations/AccidentReports/Reports/MIR2510.pdf
 */
export interface NtsbBridge {
  /** Name as the NTSB list gives it. */
  name: string;
  /**
   * Other names the same structure goes by. OSM overwhelmingly tags the local
   * name, which is often not the one in a federal report — the Crescent City
   * Connection is officially the Greater New Orleans Bridge and is tagged
   * neither way consistently.
   */
  aliases?: string[];
  /** USPS state code. */
  state: string;
  /**
   * Navigable water the structure spans. Named rather than measured: USACE
   * publishes tonnage by waterway only as scanned tables, and the secondary
   * aggregators that republish it disagree with each other by enough to matter
   * (one 2023 figure for the same port appears as both 248.1 and 135.8 million
   * short tons). Live AIS is the better evidence anyway — actual vessels under
   * the structure now, rather than an annual average.
   */
  waterway: string;
}

export const NTSB_BRIDGES: NtsbBridge[] = [
  // California
  { name: "Richmond-San Rafael", state: "CA", waterway: "San Francisco Bay" },
  { name: "Carquinez", state: "CA", waterway: "Carquinez Strait" },
  { name: "Benicia-Martinez", state: "CA", waterway: "Carquinez Strait" },
  { name: "Antioch", state: "CA", waterway: "San Joaquin River" },
  { name: "San Mateo-Hayward", state: "CA", waterway: "San Francisco Bay" },
  { name: "Coronado", aliases: ["San Diego-Coronado"], state: "CA", waterway: "San Diego Bay" },
  { name: "Golden Gate", state: "CA", waterway: "San Francisco Bay" },

  // Delaware
  { name: "Summit", state: "DE", waterway: "Chesapeake and Delaware Canal" },
  { name: "Saint Georges", aliases: ["St Georges"], state: "DE", waterway: "Chesapeake and Delaware Canal" },
  { name: "Reedy Point", state: "DE", waterway: "Chesapeake and Delaware Canal" },

  // Florida
  { name: "Sunshine Skyway", state: "FL", waterway: "Tampa Bay" },
  {
    name: "Napoleon Bonaparte Broward",
    aliases: ["Dames Point"],
    state: "FL",
    waterway: "St. Johns River",
  },

  // Georgia
  {
    name: "Talmadge",
    aliases: ["Talmadge Memorial"],
    state: "GA",
    waterway: "Savannah River",
  },

  // Illinois
  {
    name: "Chicago Skyway Calumet River",
    aliases: ["Chicago Skyway"],
    state: "IL",
    waterway: "Calumet River",
  },

  // Louisiana
  { name: "Huey P. Long", state: "LA", waterway: "Mississippi River" },
  {
    // One structure, two official names. OSM uses the local one.
    name: "Greater New Orleans",
    aliases: ["Crescent City Connection"],
    state: "LA",
    waterway: "Mississippi River",
  },
  { name: "Israel LaFleur", state: "LA", waterway: "Calcasieu River" },
  { name: "Hale Boggs", aliases: ["Luling"], state: "LA", waterway: "Mississippi River" },
  { name: "Horace Wilkinson", state: "LA", waterway: "Mississippi River" },
  {
    name: "Gramercy",
    aliases: ["Veterans Memorial"],
    state: "LA",
    waterway: "Mississippi River",
  },
  { name: "Sunshine", state: "LA", waterway: "Mississippi River" },

  // Maryland
  {
    name: "William Preston Lane Jr.",
    aliases: ["Chesapeake Bay", "Bay"],
    state: "MD",
    waterway: "Chesapeake Bay",
  },
  { name: "Chesapeake City", state: "MD", waterway: "Chesapeake and Delaware Canal" },

  // Massachusetts
  {
    name: "Tobin",
    aliases: ["Maurice J. Tobin Memorial"],
    state: "MA",
    waterway: "Mystic River",
  },
  { name: "Bourne", state: "MA", waterway: "Cape Cod Canal" },
  { name: "Sagamore", state: "MA", waterway: "Cape Cod Canal" },

  // Michigan
  { name: "Mackinac", state: "MI", waterway: "Straits of Mackinac" },

  // New Hampshire
  { name: "Memorial", state: "NH", waterway: "Piscataqua River" },

  // New Jersey
  { name: "Commodore Barry", state: "NJ", waterway: "Delaware River" },
  {
    name: "Vincent R. Casciano",
    aliases: ["Newark Bay"],
    state: "NJ",
    waterway: "Newark Bay",
  },

  // New York
  {
    name: "Verrazano Narrows",
    aliases: ["Verrazzano-Narrows", "Verrazzano Narrows"],
    state: "NY",
    waterway: "The Narrows",
  },
  { name: "Brooklyn", state: "NY", waterway: "East River" },
  { name: "Manhattan", state: "NY", waterway: "East River" },
  { name: "Williamsburg", state: "NY", waterway: "East River" },
  { name: "Newburgh-Beacon", state: "NY", waterway: "Hudson River" },
  { name: "Rip Van Winkle", state: "NY", waterway: "Hudson River" },
  {
    name: "Ogdensburg-Prescott International",
    aliases: ["Ogdensburg-Prescott"],
    state: "NY",
    waterway: "St. Lawrence River",
  },
  { name: "George Washington", state: "NY", waterway: "Hudson River" },
  { name: "Outerbridge Crossing", state: "NY", waterway: "Arthur Kill" },
  { name: "Seaway International", state: "NY", waterway: "St. Lawrence River" },
  { name: "Thousand Islands", state: "NY", waterway: "St. Lawrence River" },

  // Ohio — the NTSB lists these by ODOT structure file number. The parenthetical
  // is the name anyone, including OSM, actually uses.
  { name: "CUY-00490-0010", aliases: ["I-490"], state: "OH", waterway: "Cuyahoga River" },
  { name: "CUY-00002-1441", aliases: ["Main Avenue"], state: "OH", waterway: "Cuyahoga River" },
  { name: "CUY-00006-1456", aliases: ["Detroit Avenue"], state: "OH", waterway: "Cuyahoga River" },
  { name: "CUY-00010-1613", aliases: ["Carnegie Avenue"], state: "OH", waterway: "Cuyahoga River" },
  {
    name: "LUC-01W02-0002",
    aliases: ["Dr. Martin Luther King Jr. Memorial"],
    state: "OH",
    waterway: "Maumee River",
  },
  { name: "LUC-00002-1862", aliases: ["Anthony Wayne"], state: "OH", waterway: "Maumee River" },

  // Oregon
  { name: "Astoria-Megler", state: "OR", waterway: "Columbia River" },
  { name: "St. Johns", state: "OR", waterway: "Willamette River" },

  // Pennsylvania
  { name: "Walt Whitman", state: "PA", waterway: "Delaware River" },
  { name: "Benjamin Franklin", state: "PA", waterway: "Delaware River" },
  { name: "Betsy Ross", state: "PA", waterway: "Delaware River" },
  { name: "Delaware River Turnpike", state: "PA", waterway: "Delaware River" },

  // Rhode Island
  {
    name: "Claiborne Pell Newport",
    aliases: ["Newport", "Pell"],
    state: "RI",
    waterway: "Narragansett Bay",
  },

  // Texas
  { name: "Buffalo Bayou Toll", state: "TX", waterway: "Houston Ship Channel" },
  {
    name: "Sidney Sherman",
    aliases: ["Beltway 8"],
    state: "TX",
    waterway: "Houston Ship Channel",
  },
  { name: "Rainbow", state: "TX", waterway: "Neches River" },
  { name: "Veterans Memorial", state: "TX", waterway: "Neches River" },
  { name: "Hartman", state: "TX", waterway: "Houston Ship Channel" },
  { name: "GulfGate", aliases: ["Gulf Gate"], state: "TX", waterway: "Houston Ship Channel" },

  // Washington
  { name: "Lewis and Clark", state: "WA", waterway: "Columbia River" },

  // Wisconsin
  { name: "Leo Frigo", state: "WI", waterway: "Fox River" },
];

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

/**
 * Mireye returns a full state name ("Louisiana"); the graph test fixtures use a
 * USPS code ("WA"). Accept either rather than making callers care.
 */
function stateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_CODES[s.toLowerCase()] ?? null;
}

/**
 * Strip everything that varies between a federal report and an OSM `name` tag:
 * case, punctuation, the word "bridge" itself, and the directional suffixes OSM
 * hangs off crossings ("Hartman Bridge (eastbound)").
 *
 * Saint and Junior are spelled out in one source and abbreviated in the other,
 * in both directions — the NTSB writes "St. Johns" where OSM has "Saint Johns
 * Bridge", and "William Preston Lane Jr." could arrive either way. Folding them
 * to one spelling here is better than an alias per entry, because the next
 * mismatch of this shape then costs nothing.
 */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(eastbound|westbound|northbound|southbound|upper|lower)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bbridges?\b/g, " ")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bjunior\b/g, "jr")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NtsbMatch {
  /** The NTSB list entry that matched. */
  name: string;
  state: string;
  waterway: string;
  /** How the match was made — exact naming is worth more than a substring hit. */
  confidence: Confidence;
}

/**
 * Decide whether an OSM bridge is one of the NTSB's 68.
 *
 * Three guards against false positives, in order of how much work they do:
 *
 * 1. The state gate. Nexus only ever holds one small bbox in one state, so
 *    filtering the list by state first removes almost every way a generic name
 *    could collide — the "Veterans Memorial" on the NTSB list is in Texas, and
 *    the one in Louisiana is a different structure that happens to share a name.
 * 2. Exact match on the normalised name, which is what most of the list wants.
 * 3. Substring match, but only for names of two or more words. "Memorial",
 *    "Summit" and "Rainbow" are real entries and also words that appear in
 *    dozens of unrelated bridge names; a single-token substring rule would
 *    match all of them. Those entries can still match exactly.
 */
export function matchNtsbBridge(
  osmName: string,
  state?: string | null,
): NtsbMatch | null {
  const osm = normalise(osmName);
  if (!osm) return null;

  const code = stateCode(state);
  // With no state resolved we cannot use the strongest guard, so require an
  // exact hit rather than guessing across the whole country.
  const exactOnly = code == null;
  const pool = code ? NTSB_BRIDGES.filter((b) => b.state === code) : NTSB_BRIDGES;

  for (const b of pool) {
    // Aliases carry the reconciliation work: where OSM's name will never
    // normalise to the federal one, the fix is another alias on the entry, not
    // a looser matcher — loosening costs false positives everywhere else.
    const candidates = [b.name, ...(b.aliases ?? [])].map(normalise).filter(Boolean);

    if (candidates.some((c) => c === osm)) {
      return { name: b.name, state: b.state, waterway: b.waterway, confidence: "high" };
    }

    if (exactOnly) continue;

    const loose = candidates.some(
      (c) => c.includes(" ") && (osm.includes(c) || c.includes(osm)),
    );
    if (loose) {
      return { name: b.name, state: b.state, waterway: b.waterway, confidence: "medium" };
    }
  }

  return null;
}

export const NTSB_SOURCE_URL =
  "https://www.ntsb.gov/investigations/AccidentReports/Reports/MIR2510.pdf";
