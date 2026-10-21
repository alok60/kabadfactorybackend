import assert from "node:assert/strict";
import test from "node:test";
import { __pickupChargeTest, getPickupChargeForPincode } from "./pickupCharge.service.js";

test("474001 is serviceable when active store 474011 and active slabs include the calculated distance", async () => {
  const connection = fakeConnection({
    version: 5,
    cache: null,
    stores: [{ id: 7, name: "Gwalior Store", pincode: "474011", is_active: 1 }],
    slabs: [
      { id: 1, min: 0, max: 5, charge: 10 },
      { id: 2, min: 5, max: 10, charge: 20 },
      { id: 3, min: 10, max: 20, charge: 30 },
      { id: 4, min: 20, max: 30, charge: 50 },
      { id: 5, min: 30, max: 200, charge: 200 }
    ]
  });

  const result = await getPickupChargeForPincode(connection, "474001");

  assert.equal(result.nearestStoreId, 7);
  assert.equal(result.storePincode, "474011");
  assert.equal(result.distanceKm, 1);
  assert.equal(result.rawDistanceKm, 1);
  assert.equal(result.distanceBufferKm, 5);
  assert.equal(result.chargeableDistanceKm, 6);
  assert.equal(result.pickupCharge, 20);
  assert.equal(result.pickupChargeSlabId, 2);
  assert.equal(result.cacheHit, false);
  assert.equal(connection.insertedCache.length, 1);
});

test("valid current cache is reused without loading active stores", async () => {
  const connection = fakeConnection({
    version: 6,
    cache: {
      customerPincode: "474001",
      nearestStoreId: 7,
      storePincode: "474011",
      distanceKm: 1,
      rawDistanceKm: 1,
      distanceBufferKm: 5,
      chargeableDistanceKm: 6,
      pickupCharge: 20,
      pickupChargeSlabId: 2,
      configurationVersion: 6
    },
    stores: [{ id: 7, name: "Gwalior Store", pincode: "474011" }],
    slabs: [{ id: 2, min: 5, max: 10, charge: 20 }]
  });

  const result = await getPickupChargeForPincode(connection, "474001");

  assert.equal(result.cacheHit, true);
  assert.equal(connection.activeStoreLoads, 0);
  assert.equal(connection.insertedCache.length, 0);
});

test("stale cache is ignored and the new larger slab can make a PIN serviceable", async () => {
  const connection = fakeConnection({
    version: 8,
    cache: null,
    stores: [{ id: 4, name: "Outer Store", pincode: "474500" }],
    slabs: [
      { id: 4, min: 20, max: 30, charge: 50 },
      { id: 5, min: 30, max: 200, charge: 200 }
    ]
  });

  const result = await getPickupChargeForPincode(connection, "474001");

  assert.equal(result.pickupCharge, 200);
  assert.equal(result.pickupChargeSlabId, 5);
  assert.ok(result.distanceKm > 30);
  assert.ok(result.distanceKm <= 200);
  assert.equal(connection.insertedCache.length, 1);
});

test("PIN-code distance fallback keeps exact nearby PINs inside configured slabs", () => {
  assert.equal(__pickupChargeTest.pincodeDistanceKm("474001", "474011"), 1);
  assert.equal(__pickupChargeTest.pincodeDistanceKm("474011", "474011"), 0);
});

test("chargeable distance adds the fixed buffer exactly once at slab boundaries", () => {
  const cases = [
    [0, 5],
    [1, 6],
    [5, 10],
    [10, 15],
    [15, 20],
    [25, 30],
    [26, 31],
    [195, 200],
    [196, 201]
  ];
  cases.forEach(([raw, expected]) => {
    assert.equal(__pickupChargeTest.chargeableDistanceKm(raw), expected);
  });
});

test("serviceability uses chargeable distance, so raw distance over 195 can exceed a 200 km max slab", async () => {
  const connection = fakeConnection({
    version: 9,
    cache: null,
    stores: [{ id: 9, name: "Far Store", pincode: "517020" }],
    slabs: [{ id: 5, min: 30, max: 200, charge: 200 }]
  });

  await assert.rejects(
    () => getPickupChargeForPincode(connection, "474001"),
    /Pickup service is currently not available/
  );
  assert.equal(connection.insertedCache.length, 0);
});

test("nearest store is selected by raw distance before the 5 km buffer is applied", async () => {
  const connection = fakeConnection({
    version: 10,
    cache: null,
    stores: [
      { id: 11, name: "Farther Store", pincode: "474080" },
      { id: 12, name: "Nearest Store", pincode: "474011" }
    ],
    slabs: [
      { id: 1, min: 0, max: 5, charge: 10 },
      { id: 2, min: 5, max: 10, charge: 20 }
    ]
  });

  const result = await getPickupChargeForPincode(connection, "474001");

  assert.equal(result.nearestStoreId, 12);
  assert.equal(result.rawDistanceKm, 1);
  assert.equal(result.chargeableDistanceKm, 6);
  assert.equal(result.pickupCharge, 20);
});

test("474011 to 475110 uses practical PIN distance fallback and lands in the 30-200 km slab after buffer", async () => {
  const connection = fakeConnection({
    version: 11,
    cache: null,
    stores: [{ id: 21, name: "Gwalior Store", pincode: "474011" }],
    slabs: [
      { id: 1, min: 0, max: 5, charge: 10 },
      { id: 2, min: 5, max: 10, charge: 20 },
      { id: 3, min: 10, max: 20, charge: 30 },
      { id: 4, min: 20, max: 30, charge: 50 },
      { id: 5, min: 30, max: 200, charge: 200 }
    ]
  });

  const result = await getPickupChargeForPincode(connection, "475110");

  assert.equal(result.nearestStoreId, 21);
  assert.equal(result.rawDistanceKm, 42.92);
  assert.equal(result.distanceBufferKm, 5);
  assert.equal(result.chargeableDistanceKm, 47.92);
  assert.equal(result.pickupCharge, 200);
  assert.equal(result.pickupChargeSlabId, 5);
});

function fakeConnection({ version, cache, stores, slabs }) {
  return {
    activeStoreLoads: 0,
    insertedCache: [],
    async execute(sql, params = {}) {
      if (sql.includes("UPDATE pickup_pricing_config")) return [{ affectedRows: 1 }];
      if (sql.includes("FROM pickup_pricing_config")) return [[{ version, distanceBufferKm: 5, distanceProviderVersion: __pickupChargeTest.providerVersion }]];
      if (sql.includes("FROM pincode_pickup_charge_cache") && sql.includes("LIMIT 1")) return [[cache].filter(Boolean)];
      if (sql.includes("FROM store_locations") && sql.includes("WHERE is_active = 1")) {
        this.activeStoreLoads += 1;
        return [stores];
      }
      if (sql.includes("FROM pickup_charge_slabs") && sql.includes("LIMIT 1")) {
        const distance = Number(params.distanceKm);
        const slab = slabs.find((item) => ((item.min === 0 && distance >= item.min) || distance > item.min) && distance <= item.max);
        return [[slab ? { id: slab.id, pickupCharge: slab.charge } : undefined].filter(Boolean)];
      }
      if (sql.includes("INSERT INTO pincode_pickup_charge_cache")) {
        this.insertedCache.push(params);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}
