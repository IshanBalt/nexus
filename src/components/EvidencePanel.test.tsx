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
import EvidencePanel from "./EvidencePanel";
import type { VesselTraffic } from "@/lib/sources/ais";
import type { GeoNode, KnowledgeGraph } from "@/lib/types";

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

const render = (selected: GeoNode, vessels: VesselTraffic | null = null) =>
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
      onSimulate={() => {}}
      onCheckVessels={() => {}}
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

const tests = [
  testListedBridgeOffersTheCitationAndBothActions,
  testUnlistedBridgeStillOffersTheVesselCheck,
  testNonBridgeOffersNeither,
  testAnEmptyWindowShowsItsReasonRatherThanNothing,
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
