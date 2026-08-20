/**
 * Self-check for the AIS merge, run by `npm test`.
 *
 * The merge is the part with something to get wrong: a ship's name, size and
 * destination arrive on a different message from its position, either order, and
 * the two have to end up on one record. Everything else in ais.ts is socket
 * plumbing that only a live key can exercise.
 */
import assert from "node:assert/strict";
import { mergeAisMessage, type Vessel } from "./ais";

// The Crescent City Connection, and a ship a few hundred metres downriver.
const BRIDGE = { lat: 29.9316, lng: -90.0546 };

const position = (mmsi: number, lat: number, lng: number, sog = 8.4) => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: mmsi, ShipName: "PECOS@@@@@@@@@@@@@@@", latitude: lat, longitude: lng },
  Message: { PositionReport: { Sog: sog, Cog: 181.2 } },
});

const staticData = (mmsi: number, lat: number, lng: number) => ({
  MessageType: "ShipStaticData",
  MetaData: { MMSI: mmsi, ShipName: "PECOS@@@@@@@@@@@@@@@", latitude: lat, longitude: lng },
  Message: {
    ShipStaticData: {
      Name: "PECOS@@@@@@@@@@@@@@@",
      Type: 80,
      Dimension: { A: 160, B: 40, C: 16, D: 16 },
      MaximumStaticDraught: 11.2,
      Destination: "NEW ORLEANS@@@@@@@@@",
    },
  },
});

function testPositionAndStaticDataMergeOntoOneVessel() {
  for (const order of [
    [position(367_001_234, 29.9295, -90.0546), staticData(367_001_234, 29.9295, -90.0546)],
    [staticData(367_001_234, 29.9295, -90.0546), position(367_001_234, 29.9295, -90.0546)],
  ]) {
    const seen = new Map<number, Vessel>();
    for (const m of order) mergeAisMessage(seen, m, BRIDGE.lat, BRIDGE.lng);

    assert.equal(seen.size, 1, "the same MMSI is one vessel, not two");
    const v = seen.get(367_001_234)!;
    assert.equal(v.name, "PECOS", "AIS pads names with @ and the padding is not the name");
    assert.equal(v.type, "tanker", "type code 80 is the tanker band");
    assert.equal(v.lengthM, 200, "length is bow plus stern, not the raw dimensions");
    assert.equal(v.draughtM, 11.2);
    assert.equal(v.destination, "NEW ORLEANS");
    assert.equal(v.speedKn, 8.4, "static data must not wipe the position report");
    assert.equal(v.courseDeg, 181.2);
    assert.ok(v.distanceM > 100 && v.distanceM < 400, `expected a few hundred metres, got ${v.distanceM}`);
  }
}

function testUnavailableReadingsAreNotTreatedAsMeasurements() {
  const seen = new Map<number, Vessel>();
  mergeAisMessage(
    seen,
    {
      MessageType: "PositionReport",
      MetaData: { MMSI: 367_009_999, ShipName: "MARY LOU", latitude: 29.932, longitude: -90.055 },
      // 102.3 kn and 360 deg are the AIS codes for "not available".
      Message: { PositionReport: { Sog: 102.3, Cog: 360 } },
    },
    BRIDGE.lat,
    BRIDGE.lng,
  );
  const v = seen.get(367_009_999)!;
  assert.equal(v.speedKn, null, "102.3 kn means no reading, not a speed");
  assert.equal(v.courseDeg, null, "360 deg means no reading, not a course");
}

function testMessagesWithoutAPositionAreDropped() {
  const seen = new Map<number, Vessel>();
  mergeAisMessage(seen, { MessageType: "PositionReport", MetaData: { MMSI: 1 } }, BRIDGE.lat, BRIDGE.lng);
  mergeAisMessage(seen, {}, BRIDGE.lat, BRIDGE.lng);
  assert.equal(seen.size, 0, "a vessel with no position cannot be placed near the structure");
}

const tests = [
  testPositionAndStaticDataMergeOntoOneVessel,
  testUnavailableReadingsAreNotTreatedAsMeasurements,
  testMessagesWithoutAPositionAreDropped,
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
