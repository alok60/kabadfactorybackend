import { z } from "zod";
import { pool } from "../config/db.js";

const addressBody = z.object({
  fullName: z.string().trim().min(2, "Full name is required.").max(120, "Full name is too long."),
  mobile: z.string().trim().min(1, "Mobile number is required.").regex(/^\d{10,15}$/, "Please enter a valid mobile number."),
  label: z.enum(["home", "office", "other"]).default("home"),
  line1: z.string().trim().min(3, "House, flat, or building is required.").max(255),
  line2: z.string().trim().min(2, "Street or locality is required.").max(255),
  landmark: z.string().optional().default(""),
  city: z.string().trim().min(2, "City is required.").max(100),
  state: z.string().trim().min(2, "State is required.").max(100),
  pincode: z.string().trim().min(4, "Postal code is required.").max(12, "Please enter a valid postal code."),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isDefault: z.boolean().optional().default(false)
});

export const createAddressSchema = z.object({ body: addressBody });
export const updateAddressSchema = z.object({ body: addressBody.partial().extend({ isDefault: z.boolean().optional() }) });

export async function listAddresses(req, res) {
  const [rows] = await pool.execute(
    `SELECT id, full_name AS fullName, mobile, label, line1, line2, landmark, city, state, pincode,
            latitude, longitude, is_default AS isDefault
     FROM addresses
     WHERE user_id = :userId AND is_deleted = 0
     ORDER BY is_default DESC, id DESC`,
    { userId: req.user.id }
  );
  res.json({ data: rows });
}

export async function createAddress(req, res) {
  const payload = normalizeAddress(req.validated.body);
  const existing = await findDuplicateAddress(req.user.id, payload);
  if (existing) {
    return res.status(200).json({ ...existing, duplicate: true, message: "This address is already saved." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (payload.isDefault) {
      await connection.execute("UPDATE addresses SET is_default = 0 WHERE user_id = :userId", { userId: req.user.id });
    }

    const [result] = await connection.execute(
      `INSERT INTO addresses
       (user_id, full_name, mobile, label, line1, line2, landmark, city, state, pincode, latitude, longitude, is_default)
       VALUES (:userId, :fullName, :mobile, :label, :line1, :line2, :landmark, :city, :state, :pincode, :latitude, :longitude, :isDefault)`,
      toDbParams(req.user.id, payload)
    );

    await connection.commit();
    res.status(201).json({ id: result.insertId, ...payload });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateAddress(req, res) {
  const [[existing]] = await pool.execute("SELECT * FROM addresses WHERE id = :id AND user_id = :userId AND is_deleted = 0 LIMIT 1", {
    id: req.params.id,
    userId: req.user.id
  });
  if (!existing) return res.status(404).json({ message: "Address not found" });

  const payload = normalizeAddress({
    fullName: req.validated.body.fullName ?? existing.full_name,
    mobile: req.validated.body.mobile ?? existing.mobile,
    label: req.validated.body.label ?? existing.label,
    line1: req.validated.body.line1 ?? existing.line1,
    line2: req.validated.body.line2 ?? existing.line2 ?? "",
    landmark: req.validated.body.landmark ?? existing.landmark ?? "",
    city: req.validated.body.city ?? existing.city,
    state: req.validated.body.state ?? existing.state,
    pincode: req.validated.body.pincode ?? existing.pincode,
    latitude: req.validated.body.latitude ?? existing.latitude ?? undefined,
    longitude: req.validated.body.longitude ?? existing.longitude ?? undefined,
    isDefault: req.validated.body.isDefault ?? Boolean(existing.is_default)
  });

  const duplicate = await findDuplicateAddress(req.user.id, payload, req.params.id);
  if (duplicate) return res.status(409).json({ message: "Matching address already exists", data: duplicate });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const usedInBookings = await hasBookings(connection, req.params.id, req.user.id);
    if (payload.isDefault) {
      await connection.execute("UPDATE addresses SET is_default = 0 WHERE user_id = :userId", { userId: req.user.id });
    }

    if (usedInBookings) {
      const [created] = await connection.execute(
        `INSERT INTO addresses
         (user_id, full_name, mobile, label, line1, line2, landmark, city, state, pincode, latitude, longitude, is_default)
         VALUES (:userId, :fullName, :mobile, :label, :line1, :line2, :landmark, :city, :state, :pincode, :latitude, :longitude, :isDefault)`,
        toDbParams(req.user.id, payload)
      );
      await connection.execute(
        "UPDATE addresses SET is_deleted = 1, is_default = 0, archived_at = NOW(), replaced_by_address_id = :newId WHERE id = :id AND user_id = :userId",
        { newId: created.insertId, id: req.params.id, userId: req.user.id }
      );
      await connection.commit();
      return res.json({
        id: created.insertId,
        ...payload,
        archivedPrevious: true,
        message: "Address updated successfully."
      });
    }

    await connection.execute(
      `UPDATE addresses SET
       full_name = :fullName, mobile = :mobile, label = :label, line1 = :line1, line2 = :line2,
       landmark = :landmark, city = :city, state = :state, pincode = :pincode,
       latitude = :latitude, longitude = :longitude, is_default = :isDefault
       WHERE id = :id AND user_id = :userId`,
      { ...toDbParams(req.user.id, payload), id: req.params.id }
    );
    await connection.commit();
    res.json({ id: Number(req.params.id), ...payload });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteAddress(req, res) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const usedInBookings = await hasBookings(connection, req.params.id, req.user.id);
    if (usedInBookings) {
      await connection.execute(
        "UPDATE addresses SET is_deleted = 1, is_default = 0, archived_at = NOW() WHERE id = :id AND user_id = :userId",
        { id: req.params.id, userId: req.user.id }
      );
      await connection.commit();
      return res.json({
        id: Number(req.params.id),
        deleted: true,
        archived: true,
        message: "Address deleted successfully."
      });
    }

    await connection.execute("DELETE FROM addresses WHERE id = :id AND user_id = :userId", { id: req.params.id, userId: req.user.id });
    await connection.commit();
    res.json({ id: Number(req.params.id), deleted: true, message: "Address deleted successfully." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function setDefaultAddress(req, res) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[address]] = await connection.execute(
      "SELECT id FROM addresses WHERE id = :id AND user_id = :userId AND is_deleted = 0 LIMIT 1",
      { id: req.params.id, userId: req.user.id }
    );
    if (!address) {
      await connection.rollback();
      return res.status(404).json({ message: "Address not found" });
    }
    await connection.execute("UPDATE addresses SET is_default = 0 WHERE user_id = :userId", { userId: req.user.id });
    await connection.execute("UPDATE addresses SET is_default = 1 WHERE id = :id AND user_id = :userId", {
      id: req.params.id,
      userId: req.user.id
    });
    await connection.commit();
    res.json({ id: Number(req.params.id), isDefault: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeAddress(payload) {
  return {
    ...payload,
    fullName: clean(payload.fullName),
    mobile: String(payload.mobile || "").replace(/\D/g, ""),
    line1: clean(payload.line1),
    line2: clean(payload.line2),
    landmark: clean(payload.landmark || ""),
    city: clean(payload.city),
    state: clean(payload.state),
    pincode: String(payload.pincode || "").replace(/\s+/g, "").toUpperCase(),
    label: payload.label || "home",
    isDefault: Boolean(payload.isDefault)
  };
}

async function findDuplicateAddress(userId, payload, excludeId = null) {
  const [rows] = await pool.execute(
    `SELECT id, full_name AS fullName, mobile, label, line1, line2, landmark, city, state, pincode,
            latitude, longitude, is_default AS isDefault
     FROM addresses
     WHERE user_id = :userId
       AND (:excludeId IS NULL OR id <> :excludeId)
       AND is_deleted = 0
       AND LOWER(TRIM(line1)) = LOWER(TRIM(:line1))
       AND LOWER(TRIM(COALESCE(line2, ''))) = LOWER(TRIM(:line2))
       AND LOWER(TRIM(COALESCE(landmark, ''))) = LOWER(TRIM(:landmark))
       AND LOWER(TRIM(city)) = LOWER(TRIM(:city))
       AND LOWER(TRIM(state)) = LOWER(TRIM(:state))
       AND REPLACE(UPPER(pincode), ' ', '') = :pincode
     LIMIT 1`,
    { userId, excludeId, ...payload }
  );
  return rows[0];
}

async function hasBookings(connection, addressId, userId) {
  const [[row]] = await connection.execute(
    `SELECT COUNT(*) AS total
     FROM bookings
     WHERE address_id = :addressId AND customer_id = :userId`,
    { addressId, userId }
  );
  return Number(row.total) > 0;
}

function toDbParams(userId, payload) {
  return {
    userId,
    fullName: payload.fullName,
    mobile: payload.mobile,
    label: payload.label,
    line1: payload.line1,
    line2: payload.line2,
    landmark: payload.landmark,
    city: payload.city,
    state: payload.state,
    pincode: payload.pincode,
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    isDefault: payload.isDefault ? 1 : 0
  };
}

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
