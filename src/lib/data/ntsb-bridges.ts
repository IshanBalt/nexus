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
  /**
   * Where the structure is, so the fleet can be watched without a human picking
   * points off a map. The NTSB report names structures, not coordinates, so
   * every one of these was resolved afterwards: `nominatim` where the geocoder
   * returned a feature inside the right state, `osm` where it did not and a
   * named way carrying the right road over the right water was found instead.
   */
  lat?: number;
  lng?: number;
  located?: "nominatim" | "osm";
  /**
   * Why this structure has no coordinate. Three of them resolve only to road
   * segments whose centroids sit a mile from the span, and a federal finding
   * attached to the wrong structure is worse than one structure left out — so
   * these are excluded from the fleet and say why, rather than being guessed.
   */
  locationGap?: string;
}

export const NTSB_BRIDGES: NtsbBridge[] = [
  // CA
  { name: "Richmond-San Rafael", state: "CA", waterway: "San Francisco Bay", lat: 37.9377058, lng: -122.4583655, located: "nominatim" },
  { name: "Carquinez", state: "CA", waterway: "Carquinez Strait", lat: 38.0608989, lng: -122.2251736, located: "nominatim" },
  { name: "Benicia-Martinez", state: "CA", waterway: "Carquinez Strait", lat: 38.0404902, lng: -122.1228994, located: "nominatim" },
  { name: "Antioch", state: "CA", waterway: "San Joaquin River", lat: 38.0297241, lng: -121.7515641, located: "nominatim" },
  { name: "San Mateo-Hayward", state: "CA", waterway: "San Francisco Bay", lat: 37.5950607, lng: -122.2288275, located: "nominatim" },
  { name: "Coronado", aliases: ["San Diego-Coronado"], state: "CA", waterway: "San Diego Bay", lat: 32.6928078, lng: -117.1503137, located: "nominatim" },
  { name: "Golden Gate", state: "CA", waterway: "San Francisco Bay", lat: 37.8176155, lng: -122.4783123, located: "nominatim" },
  // DE
  { name: "Summit", state: "DE", waterway: "Chesapeake and Delaware Canal", lat: 39.54148, lng: -75.73824, located: "osm" },
  { name: "Saint Georges", aliases: ["St Georges"], state: "DE", waterway: "Chesapeake and Delaware Canal", lat: 39.5524948, lng: -75.6507773, located: "nominatim" },
  { name: "Reedy Point", state: "DE", waterway: "Chesapeake and Delaware Canal", lat: 39.5584456, lng: -75.5824037, located: "nominatim" },
  // FL
  { name: "Sunshine Skyway", state: "FL", waterway: "Tampa Bay", lat: 27.617565, lng: -82.6535188, located: "nominatim" },
  { name: "Napoleon Bonaparte Broward", aliases: ["Dames Point"], state: "FL", waterway: "St. Johns River", lat: 30.3790463, lng: -81.5545862, located: "nominatim" },
  // GA
  { name: "Talmadge", aliases: ["Talmadge Memorial"], state: "GA", waterway: "Savannah River", lat: 32.0905374, lng: -81.0974066, located: "nominatim" },
  // IL
  { name: "Chicago Skyway Calumet River", aliases: ["Chicago Skyway"], state: "IL", waterway: "Calumet River", lat: 41.7176562, lng: -87.54278, located: "nominatim" },
  // LA
  { name: "Huey P. Long", state: "LA", waterway: "Mississippi River", lat: 29.9421682, lng: -90.1665627, located: "nominatim" },
  { name: "Greater New Orleans", aliases: ["Crescent City Connection"], state: "LA", waterway: "Mississippi River", lat: 29.9377577, lng: -90.0568725, located: "nominatim" },
  { name: "Israel LaFleur", state: "LA", waterway: "Calcasieu River", lat: 30.2068016, lng: -93.2848893, located: "nominatim" },
  { name: "Hale Boggs", aliases: ["Luling"], state: "LA", waterway: "Mississippi River", lat: 29.9456238, lng: -90.3722932, located: "nominatim" },
  { name: "Horace Wilkinson", state: "LA", waterway: "Mississippi River", lat: 30.4395674, lng: -91.1971058, located: "nominatim" },
  { name: "Gramercy", aliases: ["Veterans Memorial"], state: "LA", waterway: "Mississippi River", lat: 30.0436374, lng: -90.6712603, located: "nominatim" },
  { name: "Sunshine", state: "LA", waterway: "Mississippi River", lat: 30.0985073, lng: -90.9091582, located: "nominatim" },
  // MD
  { name: "William Preston Lane Jr.", aliases: ["Chesapeake Bay", "Bay"], state: "MD", waterway: "Chesapeake Bay", lat: 38.9961371, lng: -76.3892615, located: "nominatim" },
  { name: "Chesapeake City", state: "MD", waterway: "Chesapeake and Delaware Canal", lat: 39.5285398, lng: -75.8141971, located: "nominatim" },
  // MA
  { name: "Tobin", aliases: ["Maurice J. Tobin Memorial"], state: "MA", waterway: "Mystic River", lat: 42.3800419, lng: -71.0519202, located: "nominatim" },
  { name: "Bourne", state: "MA", waterway: "Cape Cod Canal", lat: 41.7477306, lng: -70.5895299, located: "nominatim" },
  { name: "Sagamore", state: "MA", waterway: "Cape Cod Canal", lat: 41.7761641, lng: -70.543369, located: "nominatim" },
  // MI
  { name: "Mackinac", state: "MI", waterway: "Straits of Mackinac", lat: 45.8153178, lng: -84.7280522, located: "nominatim" },
  // NH
  { name: "Memorial", state: "NH", waterway: "Piscataqua River", lat: 43.079502, lng: -70.7525813, located: "nominatim" },
  // NJ
  { name: "Commodore Barry", state: "NJ", waterway: "Delaware River", lat: 39.8267836, lng: -75.3700139, located: "nominatim" },
  { name: "Vincent R. Casciano", aliases: ["Newark Bay"], state: "NJ", waterway: "Newark Bay", lat: 40.6946123, lng: -74.1160441, located: "nominatim" },
  // NY
  { name: "Verrazano Narrows", aliases: ["Verrazzano-Narrows", "Verrazzano Narrows"], state: "NY", waterway: "The Narrows", lat: 40.6063358, lng: -74.0454441, located: "nominatim" },
  { name: "Brooklyn", state: "NY", waterway: "East River", lat: 40.7062175, lng: -73.9970208, located: "nominatim" },
  { name: "Manhattan", state: "NY", waterway: "East River", lat: 40.7069642, lng: -73.9904592, located: "nominatim" },
  { name: "Williamsburg", state: "NY", waterway: "East River", lat: 40.7135807, lng: -73.9721363, located: "nominatim" },
  { name: "Newburgh-Beacon", state: "NY", waterway: "Hudson River", lat: 41.5194131, lng: -73.9968924, located: "nominatim" },
  { name: "Rip Van Winkle", state: "NY", waterway: "Hudson River", lat: 42.221876, lng: -73.8439686, located: "nominatim" },
  { name: "Ogdensburg-Prescott International", aliases: ["Ogdensburg-Prescott"], state: "NY", waterway: "St. Lawrence River", lat: 44.7298847, lng: -75.4557453, located: "nominatim" },
  { name: "George Washington", state: "NY", waterway: "Hudson River", lat: 40.8523792, lng: -73.9566274, located: "nominatim" },
  { name: "Outerbridge Crossing", state: "NY", waterway: "Arthur Kill", lat: 40.5252739, lng: -74.2384605, located: "nominatim" },
  { name: "Seaway International", state: "NY", waterway: "St. Lawrence River", lat: 44.9895172, lng: -74.7393646, located: "nominatim" },
  { name: "Thousand Islands", state: "NY", waterway: "St. Lawrence River", lat: 44.3022957, lng: -75.9826661, located: "nominatim" },
  // OH
  { name: "CUY-00490-0010", aliases: ["I-490"], state: "OH", waterway: "Cuyahoga River", lat: 41.47977, lng: -81.66805, located: "osm" },
  { name: "CUY-00002-1441", aliases: ["Main Avenue"], state: "OH", waterway: "Cuyahoga River", lat: 41.49481, lng: -81.70729, located: "osm" },
  { name: "CUY-00006-1456", aliases: ["Detroit Avenue"], state: "OH", waterway: "Cuyahoga River", lat: 41.49423, lng: -81.70286, located: "osm" },
  { name: "CUY-00010-1613", aliases: ["Carnegie Avenue"], state: "OH", waterway: "Cuyahoga River", lat: 41.49941, lng: -81.67162, located: "osm" },
  { name: "LUC-01W02-0002", aliases: ["Dr. Martin Luther King Jr. Memorial"], state: "OH", waterway: "Maumee River", lat: 41.65165, lng: -83.52704, located: "osm" },
  { name: "LUC-00002-1862", aliases: ["Anthony Wayne"], state: "OH", waterway: "Maumee River", lat: 41.64126, lng: -83.53514, located: "osm" },
  // OR
  { name: "Astoria-Megler", state: "OR", waterway: "Columbia River", lat: 46.2172535, lng: -123.8629268, located: "nominatim" },
  { name: "St. Johns", state: "OR", waterway: "Willamette River", lat: 45.5851511, lng: -122.7646277, located: "nominatim" },
  // PA
  { name: "Walt Whitman", state: "PA", waterway: "Delaware River", lat: 39.9072951, lng: -75.1410302, located: "nominatim" },
  { name: "Benjamin Franklin", state: "PA", waterway: "Delaware River", lat: 39.9529288, lng: -75.1343785, located: "nominatim" },
  { name: "Betsy Ross", state: "PA", waterway: "Delaware River", lat: 39.9847942, lng: -75.0659033, located: "nominatim" },
  { name: "Delaware River Turnpike", state: "PA", waterway: "Delaware River", lat: 40.1157232, lng: -74.8256028, located: "nominatim" },
  // RI
  { name: "Claiborne Pell Newport", aliases: ["Newport", "Pell"], state: "RI", waterway: "Narragansett Bay", lat: 41.5035896, lng: -71.3423974, located: "nominatim" },
  // TX
  { name: "Buffalo Bayou Toll", state: "TX", waterway: "Houston Ship Channel", locationGap: "OSM names the Beltway 8 crossing only as tollway segments, none of which is the span itself" },
  { name: "Sidney Sherman", aliases: ["Beltway 8"], state: "TX", waterway: "Houston Ship Channel", locationGap: "I-610 crosses the Houston Ship Channel on ways whose centroids sit a mile off the span; no way carries the name" },
  { name: "Rainbow", state: "TX", waterway: "Neches River", lat: 29.984244, lng: -93.8708568, located: "nominatim" },
  { name: "Veterans Memorial", state: "TX", waterway: "Neches River", lat: 29.9803582, lng: -93.8700305, located: "nominatim" },
  { name: "Hartman", state: "TX", waterway: "Houston Ship Channel", lat: 29.70239, lng: -95.01852, located: "osm" },
  { name: "GulfGate", aliases: ["Gulf Gate"], state: "TX", waterway: "Houston Ship Channel", locationGap: "no OSM feature carries this name near the Houston Ship Channel" },
  // WA
  { name: "Lewis and Clark", state: "WA", waterway: "Columbia River", lat: 46.1081576, lng: -122.9586084, located: "nominatim" },
  // WI
  { name: "Leo Frigo", state: "WI", waterway: "Fox River", lat: 44.5307424, lng: -87.9993328, located: "nominatim" },
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
