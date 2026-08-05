/**
 * Self-check for edge inference and cascade propagation.
 * Run: npm test
 *
 * Uses a hand-laid synthetic town so every expected edge is verifiable by hand:
 *
 *        S (substation, ~1.1 km north)
 *        |
 *   W (river, runs north-south through the crossing)
 *   ====B====R1========  (R1 primary road, bridge B at the river crossing)
 *        H (hospital, ~55 m south of R1)
 */
import assert from "node:assert/strict";
import { buildGraph, type BuildInput } from "./graph";
import { simulate, dependents, dependencies, weakestPoints } from "./cascade";
import type { GeoNode, Source } from "./types";

const SRC: Source[] = [
  {
    name: "test",
    url: "https://example.invalid",
    fetchedAt: new Date().toISOString(),
    confidence: "high",
  },
];

const node = (p: Partial<GeoNode> & Pick<GeoNode, "id" | "kind" | "name">): GeoNode => ({
  lat: 47.6,
  lng: -122.33,
  tags: {},
  sources: SRC,
  criticality: 0.5,
  ...p,
});

const hospital = node({
  id: "h1",
  kind: "hospital",
  name: "Mercy General",
  lat: 47.6,
  lng: -122.33,
  criticality: 1,
});

const road1 = node({
  id: "r1",
  kind: "road",
  name: "State Route 9",
  lat: 47.6005,
  lng: -122.33,
  criticality: 0.68,
  tags: { highway: "primary" },
  geometry: [
    [-122.34, 47.6005],
    [-122.32, 47.6005],
  ],
});

const road2 = node({
  id: "r2",
  kind: "road",
  name: "Second Avenue",
  lat: 47.5995,
  lng: -122.33,
  criticality: 0.52,
  tags: { highway: "secondary" },
  geometry: [
    [-122.34, 47.5995],
    [-122.32, 47.5995],
  ],
});

const bridge = node({
  id: "b1",
  kind: "bridge",
  name: "River Street Bridge",
  lat: 47.6005,
  lng: -122.33,
  criticality: 0.8,
  tags: { highway: "primary", bridge: "yes" },
});

const river = node({
  id: "w1",
  kind: "waterway",
  name: "Cedar River",
  lat: 47.6005,
  lng: -122.33,
  criticality: 0.3,
  tags: { waterway: "river" },
  geometry: [
    [-122.33, 47.599],
    [-122.33, 47.602],
  ],
});

const substation = node({
  id: "s1",
  kind: "substation",
  name: "Northgate Substation",
  lat: 47.61,
  lng: -122.33,
  criticality: 0.85,
});

const baseInput = (osmNodes: GeoNode[]): BuildInput => ({
  center: { lat: 47.6, lng: -122.33 },
  bbox: [-122.35, 47.59, -122.31, 47.62],
  osmNodes: osmNodes.map((n) => ({ ...n })), // buildGraph mutates criticality
  context: {
    county: "King County",
    state: "WA",
    population: 100_000,
    floodZone: null,
    withinFloodplain: false,
  },
  sources: SRC,
  gaps: [],
});

const edge = (g: ReturnType<typeof buildGraph>, from: string, to: string, rel: string) =>
  g.edges.find((e) => e.from === from && e.to === to && e.rel === rel);

// ---------------------------------------------------------------------------

function testSoleAccessRoadIsWeightedHigher() {
  const one = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  const soleEdge = edge(one, "h1", "r1", "DEPENDS_ON");
  assert.ok(soleEdge, "hospital should depend on the only arterial in range");
  assert.equal(soleEdge.weight, 0.85);
  assert.equal(soleEdge.rule, "R1:road_access");
  assert.match(soleEdge.rationale, /only arterial/);

  const two = buildGraph(baseInput([hospital, road1, road2, bridge, river, substation]));
  const redundant = edge(two, "h1", "r1", "DEPENDS_ON") ?? edge(two, "h1", "r2", "DEPENDS_ON");
  assert.ok(redundant);
  assert.equal(
    redundant.weight,
    0.45,
    "a second arterial in range must reduce the dependency weight",
  );
}

function testStructuralAndHydrologicEdges() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));

  const carries = edge(g, "r1", "b1", "DEPENDS_ON");
  assert.ok(carries, "road should depend on the bridge that carries it");
  assert.equal(carries.rule, "R2:bridge_carries_road");

  assert.ok(edge(g, "b1", "w1", "CROSSES"), "bridge should be recorded as crossing the river");

  const crossing = edge(g, "w1", "r1", "CROSSES");
  assert.ok(crossing, "geometric intersection of river and road must be detected");
  assert.equal(crossing.confidence, "high", "a real geometry intersection is high confidence");
}

function testHospitalGridDependencyAllowsForBackupGeneration() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  const feed = edge(g, "h1", "s1", "DEPENDS_ON");
  assert.ok(feed);
  assert.equal(feed.weight, 0.55, "hospital standby generation must soften the grid dependency");
  assert.match(feed.rationale, /standby generation/);
}

function testCascadeFromBridgeReachesPopulation() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  const result = simulate(g, "b1", { scenario: "bridge collapse" });

  const road = result.impacts.find((i) => i.nodeId === "r1");
  assert.ok(road, "the road carried by the bridge must be impacted");
  assert.equal(road.severity, 0.8);
  assert.equal(road.onsetHours, 0, "a severed route fails immediately");

  const hosp = result.impacts.find((i) => i.nodeId === "h1");
  assert.ok(hosp, "the hospital must be reached through the road");
  // 1.0 origin * 0.8 (road needs bridge) * 0.85 (hospital's sole access road)
  assert.ok(
    Math.abs(hosp.severity - 0.68) < 1e-6,
    `expected 0.68 severity through two hops, got ${hosp.severity}`,
  );
  assert.equal(hosp.path.length, 3, "path should be bridge -> road -> hospital");
  assert.equal(hosp.reasoning.length, 2, "every hop must carry its rationale");

  assert.ok(result.totalPopulationAffected > 0, "cascade should terminate in people");
  assert.ok(result.timeline.length > 0);
}

function testBackupGenerationDelaysHospitalOnset() {
  const g = buildGraph(baseInput([hospital, road1, road2, bridge, river, substation]));
  const result = simulate(g, "s1", { scenario: "substation failure" });
  const hosp = result.impacts.find((i) => i.nodeId === "h1");
  assert.ok(hosp, "hospital should appear downstream of its substation");
  assert.equal(hosp.onsetHours, 72, "hospital degradation should lag by generator runtime");
}

function testWorstCasePathWins() {
  // The hospital is reachable from the bridge both directly (via the road) and
  // indirectly (road -> substation -> hospital). The worse path must survive.
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  const hosp = simulate(g, "b1").impacts.find((i) => i.nodeId === "h1");
  assert.ok(hosp);
  assert.ok(hosp.severity >= 0.68, "must retain the most severe route, not the last one found");
}

function testTraversalDirections() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));

  const downstream = dependents(g, "b1").map((d) => d.node.id);
  assert.ok(downstream.includes("r1"), "road depends on the bridge");
  assert.ok(downstream.includes("h1"), "hospital is transitively downstream of the bridge");

  const upstream = dependencies(g, "h1").map((d) => d.node.id);
  assert.ok(upstream.includes("r1"), "hospital needs its access road");
  assert.ok(upstream.includes("s1"), "hospital needs its substation");
  assert.ok(!upstream.includes("h1"), "a node must not list itself as a dependency");
}

function testNoInfiniteLoopOnCycles() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  // Force a cycle: the substation now also depends on the hospital.
  g.edges.push({
    from: "s1",
    to: "h1",
    rel: "DEPENDS_ON",
    weight: 0.9,
    rationale: "synthetic cycle",
    confidence: "low",
    rule: "test:cycle",
  });
  const result = simulate(g, "b1");
  assert.ok(result.impacts.length > 0, "cycles must not starve the traversal");
  for (const i of result.impacts) {
    assert.equal(new Set(i.path).size, i.path.length, `path ${i.path.join(" -> ")} revisits a node`);
  }
}

function testWeakestPointsRanksConnectors() {
  const g = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  const ranked = weakestPoints(g, 5);
  assert.ok(ranked.length > 0);
  const top = ranked.slice(0, 3).map((r) => r.node.id);
  assert.ok(
    top.includes("b1") || top.includes("r1"),
    `expected the bridge or its road near the top, got ${top.join(", ")}`,
  );
  // The river threatens nothing here (no floodplain), so it must not outrank them.
  assert.notEqual(ranked[0].node.id, "w1");
}

function testFloodHazardOnlyWhenInMappedZone() {
  const dry = buildGraph(baseInput([hospital, road1, bridge, river, substation]));
  assert.ok(!dry.nodes.some((n) => n.kind === "floodplain"), "no hazard node outside a flood zone");

  const wetInput = baseInput([hospital, road1, bridge, river, substation]);
  wetInput.context = { ...wetInput.context, floodZone: "AE", withinFloodplain: true };
  const wet = buildGraph(wetInput);

  assert.ok(wet.nodes.some((n) => n.kind === "floodplain"), "zone AE must create a hazard node");
  const threatened = wet.edges.filter((e) => e.rel === "THREATENS");
  assert.ok(threatened.length > 0, "assets near the watercourse must be flagged");
  assert.ok(
    threatened.every((e) => e.confidence === "low"),
    "proximity-inferred exposure must not claim high confidence",
  );
}

/**
 * R10 fires off a name match, which is the part most likely to go quietly
 * wrong: too loose and every bridge in Louisiana looks federally flagged, too
 * tight and the one bridge that is flagged reads as ordinary.
 */
function testNtsbMatchingIsNeitherTooLooseNorTooTight() {
  const ntsbInput = (bridgeName: string, state: string | null) => {
    const b = { ...bridge, name: bridgeName };
    const input = baseInput([hospital, road1, b, river, substation]);
    input.context = { ...input.context, state };
    return buildGraph(input);
  };

  // Exact, on the local name OSM actually uses rather than the federal one.
  const exact = ntsbInput("Crescent City Connection", "Louisiana");
  const listed = exact.nodes.find((n) => n.id === "b1");
  assert.ok(listed?.ntsbListed, "an alias on the NTSB list must match");
  assert.equal(listed.ntsbListed.matchedName, "Greater New Orleans");
  assert.equal(listed.ntsbListed.waterway, "Mississippi River");

  const flag = edge(exact, "w1", "b1", "THREATENS");
  assert.ok(flag, "R10 must run from the water to the structure");
  assert.equal(flag.rule, "R10:vessel_strike_exposure");
  assert.equal(flag.confidence, "high", "an exact name match is not a guess");

  // The R2 edge for the same pair must survive R10 being added. Both are keyed
  // on from|to|rel, so this is the regression guard against a silent collision.
  assert.ok(
    edge(exact, "b1", "w1", "CROSSES"),
    "R2's crossing edge must not be clobbered by R10",
  );

  assert.ok(
    exact.sources.some((s) => /NTSB/.test(s.name)),
    "a match must cite the report it came from",
  );

  // Partial name, carrying route junk the way OSM does.
  const loose = ntsbInput("I 10; Horace Wilkinson Bridge", "LA");
  const partial = loose.nodes.find((n) => n.id === "b1");
  assert.ok(partial?.ntsbListed, "a substring of a multi-word entry must still match");
  assert.equal(
    edge(loose, "w1", "b1", "THREATENS")?.confidence,
    "medium",
    "a partial match must not claim the confidence of an exact one",
  );

  // Right name, wrong state. The list has a Veterans Memorial in Texas and
  // Louisiana both; the state gate is what keeps them apart.
  const wrongState = ntsbInput("Crescent City Connection", "Texas");
  assert.ok(
    !wrongState.nodes.find((n) => n.id === "b1")?.ntsbListed,
    "the state gate must reject a name from another state's list",
  );

  // An ordinary bridge stays ordinary.
  const plain = ntsbInput("River Street Bridge", "Louisiana");
  assert.ok(!plain.nodes.find((n) => n.id === "b1")?.ntsbListed);
  assert.ok(
    !plain.edges.some((e) => e.rule === "R10:vessel_strike_exposure"),
    "an unlisted bridge must produce no vessel-strike edge",
  );
  assert.ok(
    !plain.sources.some((s) => /NTSB/.test(s.name)),
    "no match means no citation — the panel records what was used, not what exists",
  );

  // Saint/St. differs between the two sources in both directions. Observed
  // live: OSM tags the Portland crossing "Saint Johns Bridge", the NTSB list
  // calls it "St. Johns".
  const spelledOut = ntsbInput("Saint Johns Bridge", "Oregon");
  assert.equal(
    spelledOut.nodes.find((n) => n.id === "b1")?.ntsbListed?.matchedName,
    "St. Johns",
    "Saint and St. must fold to the same name",
  );

  // The walkways over a big span are their own named ways in OSM and match the
  // list just as well as the roadway does. Observed live: the Golden Gate came
  // back as three flagged structures, two of them sidewalks.
  const spansInput = baseInput([
    hospital,
    road1,
    { ...bridge, id: "b1", name: "Golden Gate Bridge", criticality: 0.92 },
    { ...bridge, id: "b2", name: "Golden Gate Bridge East Sidewalk", criticality: 0.62 },
    river,
    substation,
  ]);
  spansInput.context = { ...spansInput.context, state: "California" };
  const spans = buildGraph(spansInput);
  const flagged = spans.nodes.filter((n) => n.ntsbListed);
  assert.equal(flagged.length, 1, "one NTSB entry must flag one structure, not every way named after it");
  assert.equal(flagged[0].id, "b1", "the flagged structure is the one carrying the roadway");

  // Single-word entries are real ("Summit", "Rainbow", "Memorial") and are also
  // words that turn up in unrelated bridge names. They match exactly or not at all.
  const generic = ntsbInput("Memorial Park Footbridge", "New Hampshire");
  assert.ok(
    !generic.nodes.find((n) => n.id === "b1")?.ntsbListed,
    "a one-word entry must not substring-match its way onto unrelated structures",
  );
}

function testGapsAreReportedNotHidden() {
  const input = baseInput([hospital, substation]); // no roads at all
  const g = buildGraph(input);
  assert.ok(
    g.gaps.some((x) => /Road access/.test(x.dataset)),
    "missing road coverage must surface as an explicit gap",
  );
}

const tests = [
  testSoleAccessRoadIsWeightedHigher,
  testStructuralAndHydrologicEdges,
  testHospitalGridDependencyAllowsForBackupGeneration,
  testCascadeFromBridgeReachesPopulation,
  testBackupGenerationDelaysHospitalOnset,
  testWorstCasePathWins,
  testTraversalDirections,
  testNoInfiniteLoopOnCycles,
  testWeakestPointsRanksConnectors,
  testFloodHazardOnlyWhenInMappedZone,
  testNtsbMatchingIsNeitherTooLooseNorTooTight,
  testGapsAreReportedNotHidden,
];

let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`  ok  ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${t.name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
