/**
 * Self-check for the watch log, run by `npm test`.
 *
 * All of the risk in watch mode is in what counts as one event. A ship under way
 * shows up in tick after tick; get that wrong in one direction and a single
 * passage fills the panel, get it wrong in the other and a ship that comes back
 * an hour later never raises anything.
 */
import assert from "node:assert/strict";
import type { Vessel } from "./sources/ais";
import { mergeAlerts, ofConcern, type VesselAlert } from "./watch";

const NODE = { id: "osm:way/46116280", name: "Brooklyn Bridge" };

const ship = (over: Partial<Vessel> = {}): Vessel => ({
  mmsi: 367_123_456,
  name: "ATLANTIC TRADER",
  lat: 40.7045,
  lng: -73.9955,
  distanceM: 310,
  speedKn: 6.2,
  courseDeg: 41,
  lengthM: 229,
  type: "cargo",
  ...over,
});

function testOnlyBigVesselsUnderWayCount() {
  assert.ok(ofConcern(ship()), "a 229 m box ship making 6 kn is the whole point");
  assert.ok(!ofConcern(ship({ lengthM: 24 })), "a workboat cannot take down a span");
  assert.ok(!ofConcern(ship({ speedKn: 0 })), "moored is not an approach");
  assert.ok(
    !ofConcern(ship({ lengthM: undefined })),
    "a vessel that never sent static data has no size, and a guess is not a finding",
  );
}

function testOnePassageIsOneAlertHoweverManyTicksItSpans() {
  let alerts: VesselAlert[] = [];
  let opened: VesselAlert[];

  ({ alerts, opened } = mergeAlerts(alerts, [ship({ distanceM: 900 })], NODE, "T1"));
  assert.equal(opened.length, 1, "the first sighting raises the alert");

  ({ alerts, opened } = mergeAlerts(alerts, [ship({ distanceM: 310, speedKn: 7.1 })], NODE, "T2"));
  assert.equal(opened.length, 0, "the same ship still passing is not a second event");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].distanceM, 310, "the alert tracks the ship rather than freezing");
  assert.equal(alerts[0].speedKn, 7.1);
  assert.equal(alerts[0].firstSeen, "T1", "the event began when it was first seen");
  assert.equal(alerts[0].lastSeen, "T2");
}

function testStaticDataArrivingLateStillLandsOnTheAlert() {
  // Position reports come every few seconds, the ship's name and size every few
  // minutes, so an early tick can carry a vessel with no dimensions at all.
  let alerts: VesselAlert[] = [];
  ({ alerts } = mergeAlerts(alerts, [ship({ draughtM: undefined, destination: undefined })], NODE, "T1"));
  ({ alerts } = mergeAlerts(
    alerts,
    [ship({ draughtM: 9.8, destination: "PORT NEWARK" })],
    NODE,
    "T2",
  ));
  assert.equal(alerts[0].draughtM, 9.8);
  assert.equal(alerts[0].destination, "PORT NEWARK");
}

function testAVesselThatLeavesAndReturnsIsASecondApproach() {
  let alerts: VesselAlert[] = [];
  let opened: VesselAlert[];

  ({ alerts } = mergeAlerts(alerts, [ship()], NODE, "T1"));
  ({ alerts } = mergeAlerts(alerts, [], NODE, "T2"));
  assert.equal(alerts[0].open, false, "a tick without the vessel closes the event");

  ({ alerts, opened } = mergeAlerts(alerts, [ship()], NODE, "T3"));
  assert.equal(opened.length, 1, "coming back round is a new approach, not a resumed one");
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].firstSeen, "T3", "newest first");
}

function testAQuietTickDoesNotInventAnything() {
  const { alerts, opened } = mergeAlerts([], [], NODE, "T1");
  assert.deepEqual(alerts, []);
  assert.deepEqual(opened, []);
}

const tests = [
  testOnlyBigVesselsUnderWayCount,
  testOnePassageIsOneAlertHoweverManyTicksItSpans,
  testStaticDataArrivingLateStillLandsOnTheAlert,
  testAVesselThatLeavesAndReturnsIsASecondApproach,
  testAQuietTickDoesNotInventAnything,
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
