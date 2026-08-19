/**
 * Self-check for the evidence panel's vessel-strike additions, run by `npm test`.
 *
 * The panel decides what a user is offered from the selected node alone — the
 * NTSB citation, the vessel check, the exposure brief — and getting a condition
 * backwards shows up as a button that is simply never there, which is invisible
 * in a screenshot of a location where it correctly should not be.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import EvidencePanel, { type Props } from "./EvidencePanel";
import type { VesselTraffic } from "@/lib/sources/ais";
import type { GeoNode, KnowledgeGraph } from "@/lib/types";
import type { VesselAlert } from "@/lib/watch";

const graph: KnowledgeGraph = {
  nodes: [],
  edges: [],
  center: { lat: 37.8199, lng: -122.4783 },
  bbox: [-122.5, 37.8, -122.45, 37.83],
  sources: [],
  gaps: [],
  builtAt: new Date().toISOString(),
};

const bridge: GeoNode = {
  id: "osm:way/537838948",
  kind: "bridge",
  name: "Golden Gate Bridge",
  lat: 37.8199,
  lng: -122.4783,
  tags: {},
  sources: [],
  criticality: 0.92,
};

const render = (
  selected: GeoNode,
  vessels: VesselTraffic | null = null,
  watch: Props["watch"] = null,
  alerts: VesselAlert[] = [],
) =>
  renderToStaticMarkup(
    <EvidencePanel
      graph={graph}
      mireyeFields={{}}
      selected={selected}
      cascade={null}
      simulating={false}
      timelineHours={null}
      vessels={vessels}
      checkingVessels={false}
      watch={watch}
      alerts={alerts}
      onSimulate={() => {}}
      onCheckVessels={() => {}}
      onToggleWatch={() => {}}
      onAsk={() => {}}
      onClearCascade={() => {}}
    />,
  );

function testListedBridgeOffersTheCitationAndBothActions() {
  const html = render({
    ...bridge,
    ntsbListed: { matchedName: "Golden Gate", state: "CA", waterway: "San Francisco Bay" },
  });
  assert.ok(html.includes("NTSB vessel-strike list"), "a listed structure must say so");
  assert.ok(html.includes("San Francisco Bay"), "the channel it spans is part of the finding");
  assert.ok(html.includes("MIR2510.pdf"), "the claim has to link to the report it came from");
  assert.ok(html.includes("Check live vessel traffic"));
  assert.ok(html.includes("Generate exposure brief"));
}

function testUnlistedBridgeStillOffersTheVesselCheck() {
  const html = render(bridge);
  assert.ok(!html.includes("NTSB vessel-strike list"), "no match means no federal claim");
  assert.ok(
    html.includes("Check live vessel traffic"),
    "any bridge is worth checking; only the brief is gated on the listing",
  );
  assert.ok(!html.includes("Generate exposure brief"));
}

function testNonBridgeOffersNeither() {
  const html = render({ ...bridge, id: "osm:way/1", kind: "substation", name: "Bay Substation" });
  assert.ok(!html.includes("Check live vessel traffic"));
  assert.ok(!html.includes("Generate exposure brief"));
}

function testAnEmptyWindowShowsItsReasonRatherThanNothing() {
  const html = render(bridge, {
    vessels: [],
    windowSeconds: 6,
    fetchedAt: new Date().toISOString(),
    gap: "No vessel broadcast in this window.",
  });
  assert.ok(html.includes("Live vessel traffic"), "a check that found nothing still ran");
  assert.ok(html.includes("No vessel broadcast in this window."));
}

const watchOn = (over: Partial<NonNullable<Props["watch"]>> = {}) => ({
  nodeId: bridge.id,
  nodeName: bridge.name,
  startedAt: "2026-08-05T18:00:00.000Z",
  lastCheckAt: "2026-08-05T18:04:00.000Z",
  polls: 5,
  ...over,
});

function testARunningWatchIsVisibleFromAnywhere() {
  // The point of a watch is that it keeps running while you look at something
  // else, so it cannot be rendered out of the selected structure.
  const html = render({ ...bridge, id: "osm:way/1", kind: "substation" }, null, watchOn());
  assert.ok(html.includes("Watch"), "a running watch must show even off its own structure");
  assert.ok(html.includes("Golden Gate Bridge"), "and must name what it is watching");
  assert.ok(html.includes("100 m"), "the alerting rule is stated, not implied");
}

function testABlindWatchSaysSoRatherThanLookingQuiet() {
  const html = render(
    bridge,
    null,
    watchOn({ gap: "Live vessel traffic is not configured (AISSTREAM_API_KEY unset)." }),
    [],
  );
  assert.ok(
    html.includes("AISSTREAM_API_KEY unset"),
    "a watch that cannot see must not render as a watch that sees nothing",
  );
}

function testAnAlertCarriesTheReadingsItWasRaisedOn() {
  const alert: VesselAlert = {
    id: "367123456@T1",
    mmsi: 367123456,
    name: "ATLANTIC TRADER",
    type: "cargo",
    lengthM: 229,
    draughtM: 9.8,
    destination: "PORT NEWARK",
    speedKn: 6.2,
    distanceM: 210,
    nodeId: bridge.id,
    nodeName: bridge.name,
    firstSeen: "2026-08-05T18:03:00.000Z",
    lastSeen: "2026-08-05T18:04:00.000Z",
    open: true,
  };
  const html = render(bridge, null, watchOn(), [alert]);
  assert.ok(html.includes("ATLANTIC TRADER"));
  assert.ok(html.includes("229 m"));
  assert.ok(html.includes("210 m"), "an open approach shows its distance, not a label");
  assert.ok(html.includes("Assess this approach"), "an alert is actionable, not just a log line");
}

const tests = [
  testListedBridgeOffersTheCitationAndBothActions,
  testUnlistedBridgeStillOffersTheVesselCheck,
  testNonBridgeOffersNeither,
  testAnEmptyWindowShowsItsReasonRatherThanNothing,
  testARunningWatchIsVisibleFromAnywhere,
  testABlindWatchSaysSoRatherThanLookingQuiet,
  testAnAlertCarriesTheReadingsItWasRaisedOn,
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
