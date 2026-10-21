import { getPickupChargeForPincode, normalizePincode } from "../services/pickupCharge.service.js";
import { pool } from "../config/db.js";

export async function checkPincodeServiceability(req, res) {
  const pincode = normalizePincode(req.query.pincode || req.query.pin);
  const connection = await pool.getConnection();

  try {
    const pricing = await getPickupChargeForPincode(connection, pincode);
    res.json({
      success: true,
      serviceable: true,
      message: pricing.pickupCharge > 0
        ? "Pickup is available for this PIN code."
        : "Free pickup is available for this PIN code.",
      data: {
        pincode: pricing.customerPincode,
        pickupCharge: pricing.pickupCharge,
        distanceKm: pricing.chargeableDistanceKm,
        rawDistanceKm: pricing.rawDistanceKm,
        distanceBufferKm: pricing.distanceBufferKm,
        chargeableDistanceKm: pricing.chargeableDistanceKm
      }
    });
  } finally {
    connection.release();
  }
}
