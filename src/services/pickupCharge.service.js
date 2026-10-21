import { HttpError } from "../utils/httpError.js";

export const PICKUP_DISTANCE_BUFFER_KM = 5;
export const PIN_DISTANCE_PROVIDER_VERSION = 2;

export function normalizePincode(value) {
  const pincode = String(value || "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(pincode)) {
    throw new HttpError(400, "Please select an address with a valid 6 digit PIN code.");
  }
  return pincode;
}

export async function getPickupChargeForPincode(connection, rawPincode) {
  const customerPincode = normalizePincode(rawPincode);
  const configurationVersion = await getPricingConfigurationVersion(connection);

  const [[cached]] = await connection.execute(
    `SELECT cache.customer_pincode AS customerPincode,
            cache.nearest_store_id AS nearestStoreId,
            cache.store_pincode AS storePincode,
            cache.distance_km AS distanceKm,
            cache.raw_distance_km AS rawDistanceKm,
            cache.distance_buffer_km AS distanceBufferKm,
            cache.chargeable_distance_km AS chargeableDistanceKm,
            cache.pickup_charge AS pickupCharge,
            cache.pickup_charge_slab_id AS pickupChargeSlabId,
            cache.configuration_version AS configurationVersion
     FROM pincode_pickup_charge_cache cache
     JOIN store_locations store ON store.id = cache.nearest_store_id
       AND store.is_active = 1
       AND store.pincode = cache.store_pincode
     JOIN pickup_charge_slabs slab ON slab.id = cache.pickup_charge_slab_id
       AND slab.is_active = 1
       AND cache.raw_distance_km IS NOT NULL
       AND cache.distance_buffer_km = :distanceBufferKm
       AND cache.chargeable_distance_km IS NOT NULL
       AND ((slab.min_distance_km = 0 AND cache.chargeable_distance_km >= slab.min_distance_km) OR cache.chargeable_distance_km > slab.min_distance_km)
       AND cache.chargeable_distance_km <= slab.max_distance_km
       AND cache.pickup_charge = slab.pickup_charge
     WHERE cache.customer_pincode = :customerPincode
       AND cache.configuration_version = :configurationVersion
       AND cache.is_valid = 1
     LIMIT 1`,
    { customerPincode, configurationVersion, distanceBufferKm: PICKUP_DISTANCE_BUFFER_KM }
  );

  if (cached) {
    debugPickupCharge("cache-hit", { customerPincode, configurationVersion, cached });
    return normalizePickupChargeResult({ ...cached, cacheHit: true });
  }

  const calculated = await calculatePickupCharge(connection, customerPincode, configurationVersion);
  await connection.execute(
    `INSERT INTO pincode_pickup_charge_cache
     (customer_pincode, nearest_store_id, store_pincode, distance_km, raw_distance_km, distance_buffer_km, chargeable_distance_km, pickup_charge, pickup_charge_slab_id, configuration_version, is_valid, calculated_at)
     VALUES
     (:customerPincode, :nearestStoreId, :storePincode, :distanceKm, :rawDistanceKm, :distanceBufferKm, :chargeableDistanceKm, :pickupCharge, :pickupChargeSlabId, :configurationVersion, 1, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       nearest_store_id = VALUES(nearest_store_id),
       store_pincode = VALUES(store_pincode),
       distance_km = VALUES(distance_km),
       raw_distance_km = VALUES(raw_distance_km),
       distance_buffer_km = VALUES(distance_buffer_km),
       chargeable_distance_km = VALUES(chargeable_distance_km),
       pickup_charge = VALUES(pickup_charge),
       pickup_charge_slab_id = VALUES(pickup_charge_slab_id),
       configuration_version = VALUES(configuration_version),
       is_valid = 1,
       calculated_at = CURRENT_TIMESTAMP`,
    calculated
  );

  return normalizePickupChargeResult({ ...calculated, cacheHit: false });
}

export async function bumpPickupPricingConfiguration(connection) {
  await connection.execute(
    `INSERT INTO pickup_pricing_config (id, version)
     VALUES (1, 2)
     ON DUPLICATE KEY UPDATE version = version + 1`
  );
}

async function getPricingConfigurationVersion(connection) {
  const [[row]] = await connection.execute("SELECT version, distance_buffer_km AS distanceBufferKm, distance_provider_version AS distanceProviderVersion FROM pickup_pricing_config WHERE id = 1 LIMIT 1");
  if (row?.version) {
    if (Number(row.distanceBufferKm) !== PICKUP_DISTANCE_BUFFER_KM || Number(row.distanceProviderVersion) !== PIN_DISTANCE_PROVIDER_VERSION) {
      await connection.execute(
        `UPDATE pickup_pricing_config
         SET version = version + 1,
             distance_buffer_km = :distanceBufferKm,
             distance_provider_version = :distanceProviderVersion
         WHERE id = 1`,
        { distanceBufferKm: PICKUP_DISTANCE_BUFFER_KM, distanceProviderVersion: PIN_DISTANCE_PROVIDER_VERSION }
      );
      const [[updated]] = await connection.execute("SELECT version FROM pickup_pricing_config WHERE id = 1 LIMIT 1");
      return Number(updated.version);
    }
    return Number(row.version);
  }
  await connection.execute("INSERT INTO pickup_pricing_config (id, version, distance_buffer_km, distance_provider_version) VALUES (1, 1, :distanceBufferKm, :distanceProviderVersion)", {
    distanceBufferKm: PICKUP_DISTANCE_BUFFER_KM,
    distanceProviderVersion: PIN_DISTANCE_PROVIDER_VERSION
  });
  return 1;
}

async function calculatePickupCharge(connection, customerPincode, configurationVersion) {
  const [stores] = await connection.execute(
    `SELECT id, name, pincode
     FROM store_locations
     WHERE is_active = 1
     ORDER BY id`
  );
  if (!stores.length) {
    throw new HttpError(400, "Pickup service is temporarily unavailable. Please contact support.");
  }

  const candidates = (await Promise.all(stores
    .map(async (store) => {
      let storePincode;
      try {
        storePincode = normalizePincode(store.pincode);
      } catch {
        debugPickupCharge("invalid-store-pincode", { storeId: store.id, storePincode: store.pincode });
        return null;
      }
      return {
        ...store,
        storePincode,
        distanceKm: await getDynamicPincodeDistance(storePincode, customerPincode, store)
      };
    })))
    .filter(Boolean);

  if (!candidates.length) {
    throw new HttpError(400, "Pickup service is temporarily unavailable. Please contact support.");
  }

  const nearest = candidates
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  const rawDistanceKm = round2(nearest.distanceKm);
  if (!Number.isFinite(rawDistanceKm)) {
    throw new HttpError(400, "Unable to verify pickup availability right now. Please try again.");
  }
  const distanceBufferKm = PICKUP_DISTANCE_BUFFER_KM;
  const chargeableDistanceKm = round2(rawDistanceKm + distanceBufferKm);
  debugPickupCharge("nearest-store", { customerPincode, storeId: nearest.id, storePincode: nearest.storePincode, rawDistanceKm, distanceBufferKm, chargeableDistanceKm });

  const [[slab]] = await connection.execute(
    `SELECT id, pickup_charge AS pickupCharge
     FROM pickup_charge_slabs
     WHERE is_active = 1
       AND ((min_distance_km = 0 AND :distanceKm >= min_distance_km) OR :distanceKm > min_distance_km)
       AND :distanceKm <= max_distance_km
     ORDER BY min_distance_km ASC
     LIMIT 1`,
    { distanceKm: chargeableDistanceKm }
  );

  if (!slab) {
    debugPickupCharge("no-matching-slab", { customerPincode, rawDistanceKm, distanceBufferKm, chargeableDistanceKm });
    throw new HttpError(400, "Pickup service is currently not available for this address.");
  }

  return {
    customerPincode,
    nearestStoreId: nearest.id,
    storePincode: nearest.storePincode,
    distanceKm: rawDistanceKm,
    rawDistanceKm,
    distanceBufferKm,
    chargeableDistanceKm,
    pickupCharge: round2(slab.pickupCharge),
    pickupChargeSlabId: slab.id,
    configurationVersion
  };
}

async function getDynamicPincodeDistance(storePincode, customerPincode, store) {
  debugPickupCharge("distance-input", { customerPincode, storePincode, storeId: store.id, providerVersion: PIN_DISTANCE_PROVIDER_VERSION });
  if (process.env.PIN_DISTANCE_API_URL) {
    const distance = await fetchConfiguredPincodeDistance(storePincode, customerPincode);
    if (Number.isFinite(distance) && distance >= 0) return distance;
    throw new HttpError(400, "Unable to calculate pickup availability right now. Please try again.");
  }
  return pincodeDistanceKm(storePincode, customerPincode);
}

function pincodeDistanceKm(a, b) {
  if (a === b) return 0;
  const prefixA = Number(a.slice(0, 3));
  const prefixB = Number(b.slice(0, 3));
  const suffixA = Number(a.slice(3));
  const suffixB = Number(b.slice(3));
  const prefixKm = Math.abs(prefixA - prefixB) * 35;
  const localKm = Math.abs(suffixA - suffixB) * 0.08;
  return Math.max(1, prefixKm + localKm);
}

async function fetchConfiguredPincodeDistance(fromPincode, toPincode) {
  const url = new URL(process.env.PIN_DISTANCE_API_URL);
  url.searchParams.set("from", fromPincode);
  url.searchParams.set("to", toPincode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.PIN_DISTANCE_TIMEOUT_MS || 5000));
  try {
    const response = await fetch(url, {
      headers: process.env.PIN_DISTANCE_API_KEY ? { Authorization: `Bearer ${process.env.PIN_DISTANCE_API_KEY}` } : undefined,
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    const value = data.distanceKm ?? data.distance_km ?? data.distance;
    return Number(value);
  } catch (error) {
    debugPickupCharge("distance-provider-failed", { fromPincode, toPincode, error: error.message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePickupChargeResult(result) {
  return {
    customerPincode: result.customerPincode,
    nearestStoreId: Number(result.nearestStoreId),
    storePincode: result.storePincode,
    distanceKm: round2(result.distanceKm),
    rawDistanceKm: round2(result.rawDistanceKm ?? result.distanceKm),
    distanceBufferKm: round2(result.distanceBufferKm ?? PICKUP_DISTANCE_BUFFER_KM),
    chargeableDistanceKm: round2(result.chargeableDistanceKm ?? Number(result.distanceKm || 0) + PICKUP_DISTANCE_BUFFER_KM),
    pickupCharge: round2(result.pickupCharge),
    pickupChargeSlabId: Number(result.pickupChargeSlabId),
    configurationVersion: Number(result.configurationVersion),
    cacheHit: Boolean(result.cacheHit)
  };
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function debugPickupCharge(event, data) {
  if (process.env.PICKUP_CHARGE_DEBUG === "1") {
    console.info(`[pickup-charge] ${event}`, data);
  }
}

export const __pickupChargeTest = {
  pincodeDistanceKm,
  chargeableDistanceKm: (rawDistanceKm) => round2(Number(rawDistanceKm) + PICKUP_DISTANCE_BUFFER_KM),
  providerVersion: PIN_DISTANCE_PROVIDER_VERSION
};
