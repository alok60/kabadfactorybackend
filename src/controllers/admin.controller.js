import { pool } from "../config/db.js";
import bcrypt from "bcryptjs";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { signToken } from "../services/token.service.js";
import { bumpPickupPricingConfiguration, getPickupChargeForPincode, normalizePincode } from "../services/pickupCharge.service.js";
import { HttpError } from "../utils/httpError.js";
import { normalizeScrapMaterialCategory } from "../constants/scrapMaterialCategories.js";

export const adminLoginSchema = z.object({
  body: z.object({
    identifier: z.string().min(3),
    password: z.string().min(6)
  })
});

export async function loginAdmin(req, res, next) {
  const { identifier, password } = req.validated.body;
  const [rows] = await pool.execute(
    `SELECT id, role, name, mobile, email, password_hash AS passwordHash, is_active AS isActive
     FROM users
     WHERE role = 'admin' AND (mobile = :identifier OR email = :identifier)
     LIMIT 1`,
    { identifier }
  );

  const user = rows[0];
  if (!user || !user.isActive) {
    return next(new HttpError(401, "Invalid admin credentials"));
  }

  let passwordMatches = false;
  if (user.passwordHash) {
    passwordMatches = await bcrypt.compare(password, user.passwordHash);
  } else if (process.env.NODE_ENV !== "production" && password === (process.env.ADMIN_DEFAULT_PASSWORD || "Admin@12345")) {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute("UPDATE users SET password_hash = :passwordHash WHERE id = :id", { id: user.id, passwordHash });
    passwordMatches = true;
  }

  if (!passwordMatches) {
    return next(new HttpError(401, "Invalid admin credentials"));
  }

  await pool.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id", { id: user.id });

  res.json({
    token: signToken(user),
    user: {
      id: user.id,
      role: user.role,
      name: user.name,
      mobile: user.mobile,
      email: user.email
    }
  });
}

export async function getAdminMe(req, res) {
  const [[user]] = await pool.execute(
    `SELECT id, role, name, mobile, email, last_login_at AS lastLoginAt
     FROM users
     WHERE id = :id AND role = 'admin'
     LIMIT 1`,
    { id: req.user.id }
  );

  res.json({ user });
}

export async function dashboard(_req, res) {
  const [[users]] = await pool.execute("SELECT COUNT(*) AS totalUsers FROM users WHERE role = 'customer'");
  const [[orders]] = await pool.execute("SELECT COUNT(*) AS totalOrders FROM bookings");
  const [[revenue]] = await pool.execute("SELECT COALESCE(SUM(total_amount), 0) AS revenue FROM bookings WHERE status IN ('payment_completed', 'completed')");
  const [[pending]] = await pool.execute("SELECT COUNT(*) AS pendingPickups FROM bookings WHERE status NOT IN ('completed', 'cancelled')");
  const [[completed]] = await pool.execute("SELECT COUNT(*) AS completedPickups FROM bookings WHERE status = 'completed'");

  res.json({
    totalUsers: users.totalUsers,
    totalOrders: orders.totalOrders,
    revenue: Number(revenue.revenue),
    pendingPickups: pending.pendingPickups,
    completedPickups: completed.completedPickups
  });
}

export async function listUsers(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["name", "mobile", "email", "status", "createdAt"], "createdAt");
  const filters = ["role = 'customer'"];
  const params = { limit, offset };
  if (search) {
    filters.push("(name LIKE :search OR mobile LIKE :search OR COALESCE(email, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Blocked" ? "is_active = 0" : "is_active = 1");
  const sortMap = { name: "name", mobile: "mobile", email: "email", status: "is_active", createdAt: "created_at" };
  const [rows] = await pool.execute(
    `SELECT id, name, mobile, email,
            IF(is_active = 1, 'Active', 'Blocked') AS status
     FROM users
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM users WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function createUser(req, res) {
  const { name, mobile, email, password, newPassword } = req.body;
  const cleanMobile = normalizeMobile(mobile);
  await ensureMobileAvailable(cleanMobile);
  const passwordHash = await hashOptionalPassword(password || newPassword);
  const [result] = await pool.execute(
    "INSERT INTO users (role, name, mobile, email, password_hash, is_active) VALUES ('customer', :name, :mobile, :email, :passwordHash, 1)",
    { name, mobile: cleanMobile, email: email || null, passwordHash }
  );
  res.status(201).json({ id: result.insertId, name, mobile: cleanMobile, email, status: "Active" });
}

export async function updateUser(req, res) {
  const { name, mobile, email, status, newPassword, password } = req.body;
  const cleanMobile = normalizeMobile(mobile);
  await ensureMobileAvailable(cleanMobile, req.params.id);
  const passwordHash = await hashOptionalPassword(newPassword || password);
  await pool.execute(
    `UPDATE users
     SET name = :name, mobile = :mobile, email = :email, is_active = :isActive,
         password_hash = COALESCE(:passwordHash, password_hash)
     WHERE id = :id AND role = 'customer'`,
    { id: req.params.id, name, mobile: cleanMobile, email: email || null, isActive: status === "Blocked" ? 0 : 1, passwordHash }
  );
  res.json({ id: Number(req.params.id), name, mobile: cleanMobile, email, status });
}

export async function listExecutives(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["name", "mobile", "assigned", "status", "createdAt"], "createdAt");
  const filters = ["u.role = 'executive'"];
  const params = { limit, offset };
  if (search) {
    filters.push("(u.name LIKE :search OR u.mobile LIKE :search OR COALESCE(u.email, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) {
    filters.push(status === "Blocked" ? "u.is_active = 0" : "u.is_active = 1");
  }
  const sortMap = {
    name: "u.name",
    mobile: "u.mobile",
    assigned: "assigned",
    status: "u.is_active",
    createdAt: "u.created_at"
  };
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.mobile, COALESCE(u.email, '') AS area,
            COUNT(b.id) AS assigned,
            IF(u.is_active = 1, 'Available', 'Blocked') AS status
     FROM users u
     LEFT JOIN bookings b ON b.executive_id = u.id AND b.status NOT IN ('completed', 'cancelled')
     WHERE ${filters.join(" AND ")}
     GROUP BY u.id
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM users u WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function createExecutive(req, res) {
  const { name, mobile, area, password, newPassword } = req.body;
  const cleanMobile = normalizeMobile(mobile);
  await ensureMobileAvailable(cleanMobile);
  const passwordHash = await hashOptionalPassword(password || newPassword);
  const [result] = await pool.execute(
    "INSERT INTO users (role, name, mobile, email, password_hash, is_active) VALUES ('executive', :name, :mobile, :area, :passwordHash, 1)",
    { name, mobile: cleanMobile, area: area || null, passwordHash }
  );
  res.status(201).json({ id: result.insertId, name, mobile: cleanMobile, area, assigned: 0, status: "Available" });
}

export async function updateExecutive(req, res) {
  const { name, mobile, area, status, newPassword, password } = req.body;
  const cleanMobile = normalizeMobile(mobile);
  await ensureMobileAvailable(cleanMobile, req.params.id);
  const passwordHash = await hashOptionalPassword(newPassword || password);
  await pool.execute(
    `UPDATE users
     SET name = :name, mobile = :mobile, email = :area, is_active = :isActive,
         password_hash = COALESCE(:passwordHash, password_hash)
     WHERE id = :id AND role = 'executive'`,
    { id: req.params.id, name, mobile: cleanMobile, area: area || null, isActive: status === "Blocked" ? 0 : 1, passwordHash }
  );
  res.json({ id: Number(req.params.id), name, mobile: cleanMobile, area, status });
}

export async function listPickupRequests(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["createdAt", "pickupDate", "status", "customer", "executive"], "createdAt");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(CONCAT('#KF', b.id) LIKE :search OR u.name LIKE :search OR u.mobile LIKE :search OR COALESCE(e.name, '') LIKE :search OR COALESCE(a.city, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) {
    filters.push("b.status = :status");
    params.status = normalizeStatus(status);
  }
  const sortMap = {
    createdAt: "b.created_at",
    pickupDate: "b.pickup_date",
    status: "b.status",
    customer: "u.name",
    executive: "e.name"
  };
  const [rows] = await pool.execute(
    `SELECT CONCAT('#KF', b.id) AS id,
            b.id AS rawId,
            COALESCE(u.name, u.mobile) AS customer,
            COALESCE(GROUP_CONCAT(sc.name ORDER BY sc.name SEPARATOR ', '), 'Mixed Scrap') AS scrap,
            CONCAT(DATE_FORMAT(b.pickup_date, '%Y-%m-%d'), ' ', b.time_slot) AS slot,
            COALESCE(e.name, 'Unassigned') AS executive,
            b.executive_id AS executiveId,
            b.status,
            CONCAT('Rs ', COALESCE(b.pickup_charge, 0)) AS pickupCharge,
            b.assigned_at AS assignedAt
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     JOIN addresses a ON a.id = b.address_id
     LEFT JOIN users e ON e.id = b.executive_id
     LEFT JOIN booking_items bi ON bi.booking_id = b.id
     LEFT JOIN scrap_categories sc ON sc.id = bi.category_id
     WHERE ${filters.join(" AND ")}
     GROUP BY b.id
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     JOIN addresses a ON a.id = b.address_id
     LEFT JOIN users e ON e.id = b.executive_id
     WHERE ${filters.join(" AND ")}`,
    params
  );
  res.json({ data: rows.map((row) => ({ ...row, status: humanizeStatus(row.status) })), pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function updatePickup(req, res) {
  const { status, executive, executiveId } = req.body;
  let normalizedStatus = normalizeStatus(status);
  const [[current]] = await pool.execute("SELECT id, status, customer_id AS customerId, executive_id AS currentExecutiveId FROM bookings WHERE id = :id LIMIT 1", { id: req.params.id });
  if (!current) return res.status(404).json({ message: "Pickup request not found." });
  if (["completed", "cancelled"].includes(current.status)) return res.status(400).json({ message: "Completed or cancelled pickups cannot be reassigned." });

  let nextExecutiveId = null;
  let executiveName = "Unassigned";
  if (executiveId || (executive && executive !== "Unassigned")) {
    const [[user]] = await pool.execute(
      `SELECT id, name, mobile
       FROM users
       WHERE role = 'executive' AND is_active = 1 AND (:id IS NULL OR id = :id) AND (:name IS NULL OR name = :name)
       LIMIT 1`,
      { id: executiveId || null, name: executiveId ? null : executive }
    );
    if (!user) return res.status(400).json({ message: "Please select an active executive." });
    nextExecutiveId = user.id;
    executiveName = user.name || user.mobile;
    if (normalizedStatus === current.status || normalizedStatus === "confirmed") normalizedStatus = "executive_assigned";
  }

  await pool.execute(
    `UPDATE bookings
     SET status = :status,
         executive_id = :executiveId,
         assigned_at = CASE WHEN :executiveId IS NULL THEN assigned_at WHEN executive_id IS NULL OR executive_id <> :executiveId THEN CURRENT_TIMESTAMP ELSE assigned_at END,
         assigned_by_admin_id = CASE WHEN :executiveId IS NULL THEN assigned_by_admin_id WHEN executive_id IS NULL OR executive_id <> :executiveId THEN :adminId ELSE assigned_by_admin_id END
     WHERE id = :id`,
    { id: req.params.id, status: normalizedStatus, executiveId: nextExecutiveId, adminId: req.user.id }
  );

  await pool.execute(
    "INSERT INTO booking_status_events (booking_id, status, note) VALUES (:id, :status, :note)",
    { id: req.params.id, status: normalizedStatus, note: nextExecutiveId ? `Executive assigned by admin - ${executiveName}` : "Updated by admin" }
  );

  const [[booking]] = await pool.execute("SELECT customer_id AS customerId FROM bookings WHERE id = :id LIMIT 1", { id: req.params.id });
  if (booking?.customerId) {
    await pool.execute(
      "INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (:userId, :title, :body, 'pickup', 0)",
      {
        userId: booking.customerId,
        title: nextExecutiveId ? "Executive assigned" : humanizeStatus(normalizedStatus),
        body: nextExecutiveId ? `An executive has been assigned for pickup #KF${req.params.id}.` : `Your pickup #KF${req.params.id} status is now ${humanizeStatus(normalizedStatus)}.`
      }
    );
  }
  if (nextExecutiveId) {
    await pool.execute(
      "INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (:userId, 'New pickup assigned', :body, 'pickup', 0)",
      { userId: nextExecutiveId, body: `Pickup #KF${req.params.id} has been assigned to you.` }
    );
  }

  res.json({ id: Number(req.params.id), status: humanizeStatus(normalizedStatus), executive: executiveName, executiveId: nextExecutiveId, message: "Executive assigned successfully." });
}

export async function listExecutiveOptions(_req, res) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.mobile,
            IF(u.is_active = 1, 'Available', 'Blocked') AS availability,
            COUNT(b.id) AS activeAssigned
     FROM users u
     LEFT JOIN bookings b ON b.executive_id = u.id AND b.status NOT IN ('completed', 'cancelled')
     WHERE u.role = 'executive' AND u.is_active = 1
     GROUP BY u.id
     ORDER BY u.name, u.mobile`
  );
  res.json({ data: rows });
}

export async function executiveReports(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["name", "assigned", "pending", "completed", "completionPercentage", "lastActivity"], "lastActivity");
  const filters = ["u.role = 'executive'"];
  const params = { limit, offset };
  if (search) {
    filters.push("(u.name LIKE :search OR u.mobile LIKE :search OR COALESCE(u.email, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status === "Active") filters.push("u.is_active = 1");
  if (status === "Inactive") filters.push("u.is_active = 0");
  const sortMap = {
    name: "u.name",
    assigned: "totalAssigned",
    pending: "pending",
    completed: "completed",
    completionPercentage: "completionPercentage",
    lastActivity: "lastActivity"
  };
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.mobile, COALESCE(u.email, '') AS email,
            COUNT(b.id) AS totalAssigned,
            SUM(CASE WHEN b.status IN ('confirmed', 'executive_assigned') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN b.status IN ('executive_reached', 'scrap_collected', 'payment_completed') THEN 1 ELSE 0 END) AS inProgress,
            SUM(CASE WHEN b.status = 'scrap_collected' THEN 1 ELSE 0 END) AS scrapCollected,
            SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            COALESCE(SUM(b.actual_weight), 0) AS totalCollectedWeight,
            COALESCE(SUM(b.total_amount), 0) AS totalAmount,
            MAX(COALESCE(b.updated_at, b.assigned_at, b.created_at)) AS lastActivity,
            MAX(b.assigned_at) AS lastAssignedAt,
            MAX(CASE WHEN b.status = 'completed' THEN b.updated_at ELSE NULL END) AS lastCompletedAt,
            CASE WHEN COUNT(b.id) = 0 THEN 0 ELSE ROUND(SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) * 100 / COUNT(b.id), 1) END AS completionPercentage
     FROM users u
     LEFT JOIN bookings b ON b.executive_id = u.id
     WHERE ${filters.join(" AND ")}
     GROUP BY u.id
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM users u WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function listCategories(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["name", "status", "price", "createdAt"], "name");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(name LIKE :search OR description LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Hidden" ? "is_active = 0" : "is_active = 1");
  const sortMap = { name: "name", status: "is_active", price: "price", createdAt: "created_at" };
  const [rows] = await pool.execute(
    `SELECT id, name AS category, category AS materialCategory, unit, CONCAT('Rs ', price) AS price, description,
            image_url AS imageUrl,
            IF(is_active = 1, 'Active', 'Hidden') AS status
     FROM scrap_categories
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}, display_order
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM scrap_categories WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows.map((row) => ({ ...row, iconUrl: publicMediaUrl(req, row.imageUrl) })), pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function createCategory(req, res) {
  const { category, materialCategory, unit, price, description, status } = req.body;
  const normalizedMaterialCategory = normalizeScrapMaterialCategory(materialCategory);
  if (!normalizedMaterialCategory) throw new HttpError(400, "Choose a valid material category");
  const numericPrice = parsePrice(price);
  const iconPath = req.file ? await persistUploadedCategoryIcon(req.file) : null;
  const [result] = await pool.execute(
    `INSERT INTO scrap_categories (name, category, slug, unit, price, image_url, description, is_active)
     VALUES (:name, :materialCategory, :slug, :unit, :price, :imageUrl, :description, :isActive)`,
    {
      name: category,
      materialCategory: normalizedMaterialCategory,
      slug: slugify(category),
      unit: unit || "kg",
      price: numericPrice,
      imageUrl: iconPath,
      description: description || "",
      isActive: status === "Hidden" ? 0 : 1
    }
  );
  res.status(201).json({
    id: result.insertId,
    category,
    materialCategory: normalizedMaterialCategory,
    unit: unit || "kg",
    price: `Rs ${numericPrice}`,
    description: description || "",
    imageUrl: iconPath,
    iconUrl: publicMediaUrl(req, iconPath),
    status: status || "Active"
  });
}

export async function updateCategory(req, res) {
  const { category, materialCategory, unit, price, description, status, removeIcon } = req.body;
  const normalizedMaterialCategory = normalizeScrapMaterialCategory(materialCategory);
  if (!normalizedMaterialCategory) throw new HttpError(400, "Choose a valid material category");
  const numericPrice = parsePrice(price);
  const [[existing]] = await pool.execute("SELECT image_url AS imageUrl FROM scrap_categories WHERE id = :id LIMIT 1", { id: req.params.id });
  const nextIconPath = req.file ? await persistUploadedCategoryIcon(req.file) : removeIcon === "true" ? null : existing?.imageUrl || null;

  await pool.execute(
    `UPDATE scrap_categories
     SET name = :name, category = :materialCategory, unit = :unit, price = :price, image_url = :imageUrl, description = :description, is_active = :isActive
     WHERE id = :id`,
    { id: req.params.id, name: category, materialCategory: normalizedMaterialCategory, unit: unit || "kg", price: numericPrice, imageUrl: nextIconPath, description: description || "", isActive: status === "Hidden" ? 0 : 1 }
  );

  if ((req.file || removeIcon === "true") && existing?.imageUrl && existing.imageUrl !== nextIconPath) {
    await removeLocalUpload(existing.imageUrl);
  }

  res.json({
    id: Number(req.params.id),
    category,
    materialCategory: normalizedMaterialCategory,
    unit: unit || "kg",
    price: `Rs ${numericPrice}`,
    description: description || "",
    imageUrl: nextIconPath,
    iconUrl: publicMediaUrl(req, nextIconPath),
    status
  });
}

export async function listStoreLocations(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["name", "city", "pincode", "status", "createdAt"], "createdAt");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(name LIKE :search OR pincode LIKE :search OR COALESCE(city, '') LIKE :search OR COALESCE(address, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Hidden" || status === "Inactive" ? "is_active = 0" : "is_active = 1");
  const sortMap = { name: "name", city: "city", pincode: "pincode", status: "is_active", createdAt: "created_at" };
  const [rows] = await pool.execute(
    `SELECT id, name, address, city, state, pincode,
            IF(is_active = 1, 'Active', 'Hidden') AS status
     FROM store_locations
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM store_locations WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function createStoreLocation(req, res) {
  const payload = storePayload(req.body);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO store_locations (name, address, city, state, pincode, latitude, longitude, is_active)
       VALUES (:name, :address, :city, :state, :pincode, :latitude, :longitude, :isActive)`,
      payload
    );
    await bumpPickupPricingConfiguration(connection);
    await connection.commit();
    res.status(201).json({ id: result.insertId, ...storeResponse(payload) });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateStoreLocation(req, res) {
  const payload = storePayload(req.body);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE store_locations
       SET name = :name, address = :address, city = :city, state = :state, pincode = :pincode,
           latitude = :latitude, longitude = :longitude, is_active = :isActive
       WHERE id = :id`,
      { id: req.params.id, ...payload }
    );
    await bumpPickupPricingConfiguration(connection);
    await connection.commit();
    res.json({ id: Number(req.params.id), ...storeResponse(payload) });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listPickupChargeSlabs(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["minDistanceKm", "maxDistanceKm", "pickupCharge", "status", "createdAt"], "minDistanceKm");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(CAST(min_distance_km AS CHAR) LIKE :search OR CAST(max_distance_km AS CHAR) LIKE :search OR CAST(pickup_charge AS CHAR) LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Hidden" || status === "Inactive" ? "is_active = 0" : "is_active = 1");
  const sortMap = { minDistanceKm: "min_distance_km", maxDistanceKm: "max_distance_km", pickupCharge: "pickup_charge", status: "is_active", createdAt: "created_at" };
  const [rows] = await pool.execute(
    `SELECT id, min_distance_km AS minDistanceKm, max_distance_km AS maxDistanceKm,
            pickup_charge AS pickupCharge,
            CONCAT(min_distance_km, ' - ', max_distance_km, ' km') AS distance,
            CONCAT('Rs ', pickup_charge) AS charge,
            IF(is_active = 1, 'Active', 'Hidden') AS status
     FROM pickup_charge_slabs
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM pickup_charge_slabs WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function createPickupChargeSlab(req, res) {
  const payload = slabPayload(req.body);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureNoSlabOverlap(connection, payload);
    const [result] = await connection.execute(
      `INSERT INTO pickup_charge_slabs (min_distance_km, max_distance_km, pickup_charge, is_active)
       VALUES (:minDistanceKm, :maxDistanceKm, :pickupCharge, :isActive)`,
      payload
    );
    await bumpPickupPricingConfiguration(connection);
    await connection.commit();
    res.status(201).json({ id: result.insertId, ...slabResponse(payload) });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updatePickupChargeSlab(req, res) {
  const payload = slabPayload(req.body);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureNoSlabOverlap(connection, payload, req.params.id);
    await connection.execute(
      `UPDATE pickup_charge_slabs
       SET min_distance_km = :minDistanceKm, max_distance_km = :maxDistanceKm,
           pickup_charge = :pickupCharge, is_active = :isActive
       WHERE id = :id`,
      { id: req.params.id, ...payload }
    );
    await bumpPickupPricingConfiguration(connection);
    await connection.commit();
    res.json({ id: Number(req.params.id), ...slabResponse(payload) });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listPincodePickupChargeCache(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["pincode", "rawDistanceKm", "chargeableDistanceKm", "pickupCharge", "calculatedAt"], "calculatedAt");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(cache.customer_pincode LIKE :search OR store.name LIKE :search OR cache.store_pincode LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Stale" ? "(cache.is_valid = 0 OR cache.configuration_version <> config.version)" : "cache.is_valid = 1 AND cache.configuration_version = config.version");
  const sortMap = { pincode: "cache.customer_pincode", rawDistanceKm: "cache.raw_distance_km", chargeableDistanceKm: "cache.chargeable_distance_km", pickupCharge: "cache.pickup_charge", calculatedAt: "cache.calculated_at" };
  const [rows] = await pool.execute(
    `SELECT cache.id, cache.customer_pincode AS pincode, store.name AS nearestStore,
            cache.store_pincode AS storePincode,
            COALESCE(cache.raw_distance_km, cache.distance_km) AS rawDistanceKm,
            cache.distance_buffer_km AS distanceBufferKm,
            COALESCE(cache.chargeable_distance_km, cache.distance_km) AS chargeableDistanceKm,
            CONCAT('Rs ', cache.pickup_charge) AS pickupCharge,
            cache.configuration_version AS configurationVersion,
            IF(cache.is_valid = 1 AND cache.configuration_version = config.version, 'Valid', 'Stale') AS status,
            cache.calculated_at AS calculatedAt
     FROM pincode_pickup_charge_cache cache
     JOIN store_locations store ON store.id = cache.nearest_store_id
     JOIN pickup_pricing_config config ON config.id = 1
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM pincode_pickup_charge_cache cache
     JOIN store_locations store ON store.id = cache.nearest_store_id
     JOIN pickup_pricing_config config ON config.id = 1
     WHERE ${filters.join(" AND ")}`,
    params
  );
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function refreshPincodePickupCharge(req, res) {
  const pincode = normalizePincode(req.params.pincode);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await getPickupChargeForPincode(connection, pincode);
    await connection.commit();
    res.json({ success: true, message: "Pickup charge cache refreshed.", data: result });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listOffers(_req, res) {
  const [rows] = await pool.execute(
    `SELECT id, title, COALESCE(description, 'All users') AS audience,
            COALESCE(DATE_FORMAT(starts_at, '%Y-%m-%d'), '') AS start,
            COALESCE(DATE_FORMAT(ends_at, '%Y-%m-%d'), '') AS \`end\`,
            IF(is_active = 1, 'Active', 'Draft') AS status
     FROM offers
     ORDER BY id DESC`
  );
  res.json({ data: rows });
}

export async function createOffer(req, res) {
  const { title, audience, start, end, status } = req.body;
  const [result] = await pool.execute(
    "INSERT INTO offers (title, description, starts_at, ends_at, is_active) VALUES (:title, :audience, :start, :end, :isActive)",
    { title, audience, start: start || null, end: end || null, isActive: status === "Active" ? 1 : 0 }
  );
  res.status(201).json({ id: result.insertId, title, audience, start, end, status });
}

export async function updateOffer(req, res) {
  const { title, audience, start, end, status } = req.body;
  await pool.execute(
    "UPDATE offers SET title = :title, description = :audience, starts_at = :start, ends_at = :end, is_active = :isActive WHERE id = :id",
    { id: req.params.id, title, audience, start: start || null, end: end || null, isActive: status === "Active" ? 1 : 0 }
  );
  res.json({ id: Number(req.params.id), title, audience, start, end, status });
}

export async function listNotifications(_req, res) {
  const [rows] = await pool.execute(
    `SELECT id, title, type, IF(user_id IS NULL, 'All users', CONCAT('User ', user_id)) AS audience,
            '1' AS sent,
            IF(is_read = 1, 'Read', 'Sent') AS status
     FROM notifications
     ORDER BY created_at DESC`
  );
  res.json({ data: rows });
}

export async function createNotification(req, res) {
  const { title, type, audience, status } = req.body;
  const [result] = await pool.execute(
    "INSERT INTO notifications (title, body, type, is_read) VALUES (:title, :body, :type, 0)",
    { title, body: audience || title, type: normalizeNotificationType(type) }
  );
  res.status(201).json({ id: result.insertId, title, type, audience, sent: "1", status: status || "Sent" });
}

export async function updateNotification(req, res) {
  const { title, type, audience, status } = req.body;
  await pool.execute(
    "UPDATE notifications SET title = :title, body = :body, type = :type, is_read = :isRead WHERE id = :id",
    {
      id: req.params.id,
      title,
      body: audience || title,
      type: normalizeNotificationType(type),
      isRead: status === "Read" ? 1 : 0
    }
  );
  res.json({ id: Number(req.params.id), title, type, audience, status });
}

export async function listPayments(req, res) {
  const { page, limit, offset, search, sortBy, sortOrder, status } = listParams(req, ["createdAt", "amount", "status", "customer"], "createdAt");
  const filters = ["1 = 1"];
  const params = { limit, offset };
  if (search) {
    filters.push("(CONCAT('#KF', b.id) LIKE :search OR u.name LIKE :search OR u.mobile LIKE :search)");
    params.search = `%${search}%`;
  }
  if (status) filters.push(status === "Completed" ? "b.status IN ('payment_completed', 'completed')" : "b.status NOT IN ('payment_completed', 'completed')");
  const sortMap = { createdAt: "b.created_at", amount: "b.total_amount", status: "b.status", customer: "u.name" };
  const [rows] = await pool.execute(
    `SELECT CONCAT('P', b.id) AS id, CONCAT('#KF', b.id) AS \`order\`,
            COALESCE(u.name, u.mobile) AS customer,
            COALESCE(b.payment_mode, 'cash') AS mode,
            CONCAT('Rs ', COALESCE(b.total_amount, 0)) AS amount,
            CONCAT('Rs ', COALESCE(b.pickup_charge, 0)) AS pickupCharge,
            IF(b.status IN ('payment_completed', 'completed'), 'Completed', 'Pending') AS status
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     WHERE ${filters.join(" AND ")}
     ORDER BY ${sortMap[sortBy]} ${sortOrder}
     LIMIT :limit OFFSET :offset`,
    params
  );
  const [[countRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM bookings b JOIN users u ON u.id = b.customer_id WHERE ${filters.join(" AND ")}`, params);
  res.json({ data: rows, pagination: pagination(page, limit, Number(countRow.total || 0)) });
}

export async function listSupportQueries(_req, res) {
  const [rows] = await pool.execute(
    `SELECT sq.id,
            COALESCE(u.name, 'Customer') AS customer,
            u.mobile,
            sq.subject,
            sq.category,
            sq.message,
            sq.status,
            COALESCE(sq.admin_note, '') AS adminNote,
            DATE_FORMAT(sq.created_at, '%Y-%m-%d %H:%i') AS created
     FROM support_queries sq
     JOIN users u ON u.id = sq.user_id
     ORDER BY sq.created_at DESC`
  );
  res.json({ data: rows.map((row) => ({ ...row, status: humanizeStatus(row.status), category: humanizeStatus(row.category), adminNote: row.adminNote || "" })) });
}

export async function updateSupportQuery(req, res) {
  const { status, adminNote } = req.body;
  await pool.execute(
    "UPDATE support_queries SET status = :status, admin_note = :adminNote WHERE id = :id",
    { id: req.params.id, status: normalizeSupportStatus(status), adminNote: adminNote || null }
  );
  res.json({ id: Number(req.params.id), status, adminNote });
}

export async function listAdminFaqs(_req, res) {
  const [rows] = await pool.execute(
    `SELECT id, question, answer, category, display_order AS displayOrder,
            IF(is_active = 1, 'Active', 'Inactive') AS status
     FROM faqs
     ORDER BY display_order, id DESC`
  );
  res.json({ data: rows });
}

export async function createAdminFaq(req, res) {
  const { question, answer, category, displayOrder, status } = req.body;
  const [result] = await pool.execute(
    `INSERT INTO faqs (question, answer, category, display_order, is_active)
     VALUES (:question, :answer, :category, :displayOrder, :isActive)`,
    { question, answer: sanitizeContent(answer), category, displayOrder: Number(displayOrder) || 100, isActive: status === "Inactive" ? 0 : 1 }
  );
  res.status(201).json({ id: result.insertId, question, answer, category, displayOrder, status: status || "Active" });
}

export async function updateAdminFaq(req, res) {
  const { question, answer, category, displayOrder, status } = req.body;
  await pool.execute(
    `UPDATE faqs
     SET question = :question, answer = :answer, category = :category, display_order = :displayOrder, is_active = :isActive
     WHERE id = :id`,
    { id: req.params.id, question, answer: sanitizeContent(answer), category, displayOrder: Number(displayOrder) || 100, isActive: status === "Inactive" ? 0 : 1 }
  );
  res.json({ id: Number(req.params.id), question, answer, category, displayOrder, status });
}

export async function deleteAdminFaq(req, res) {
  await pool.execute("DELETE FROM faqs WHERE id = :id", { id: req.params.id });
  res.json({ id: Number(req.params.id), deleted: true });
}

export async function listAdminCmsPages(req, res) {
  const pageType = normalizeCmsPageType(req.params.type);
  const [rows] = await pool.execute(
    `SELECT id, title, content, version,
            IF(is_active = 1, 'Active', 'Draft') AS status,
            created_at AS createdAt, updated_at AS updatedAt
     FROM cms_pages
     WHERE page_type = :pageType
     ORDER BY version DESC, id DESC`,
    { pageType }
  );
  res.json({ data: rows });
}

export async function createAdminCmsPage(req, res) {
  const pageType = normalizeCmsPageType(req.params.type);
  const { title, content, version, status } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (status === "Active") {
      await connection.execute("UPDATE cms_pages SET is_active = 0 WHERE page_type = :pageType", { pageType });
    }
    const [result] = await connection.execute(
      `INSERT INTO cms_pages (page_type, title, content, version, is_active)
       VALUES (:pageType, :title, :content, :version, :isActive)`,
      { pageType, title, content: sanitizeContent(content), version: Number(version) || 1, isActive: status === "Active" ? 1 : 0 }
    );
    await connection.commit();
    res.status(201).json({ id: result.insertId, title, content, version, status: status || "Draft" });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateAdminCmsPage(req, res) {
  const pageType = normalizeCmsPageType(req.params.type);
  const { title, content, version, status } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (status === "Active") {
      await connection.execute("UPDATE cms_pages SET is_active = 0 WHERE page_type = :pageType", { pageType });
    }
    await connection.execute(
      `UPDATE cms_pages
       SET title = :title, content = :content, version = :version, is_active = :isActive
       WHERE id = :id AND page_type = :pageType`,
      { id: req.params.id, pageType, title, content: sanitizeContent(content), version: Number(version) || 1, isActive: status === "Active" ? 1 : 0 }
    );
    await connection.commit();
    res.json({ id: Number(req.params.id), title, content, version, status });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function parsePrice(value) {
  return Number(String(value || "0").replace(/[^0-9.]/g, "")) || 0;
}

function storePayload(body) {
  const name = String(body.name || body.storeName || "").trim();
  if (!name) throw new HttpError(400, "Store name is required.");
  return {
    name,
    address: String(body.address || "").trim() || null,
    city: String(body.city || "").trim() || null,
    state: String(body.state || "").trim() || null,
    pincode: normalizePincode(body.pincode),
    latitude: null,
    longitude: null,
    isActive: body.status === "Hidden" || body.status === "Inactive" ? 0 : 1
  };
}

function storeResponse(payload) {
  return {
    name: payload.name,
    address: payload.address || "",
    city: payload.city || "",
    state: payload.state || "",
    pincode: payload.pincode,
    status: payload.isActive ? "Active" : "Hidden"
  };
}

function slabPayload(body) {
  const minDistanceKm = Number(body.minDistanceKm ?? body.min_distance_km ?? 0);
  const maxDistanceKm = Number(body.maxDistanceKm ?? body.max_distance_km);
  const pickupCharge = Number(String(body.pickupCharge ?? body.pickup_charge ?? "0").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(minDistanceKm) || minDistanceKm < 0) throw new HttpError(400, "Minimum distance must be zero or greater.");
  if (!Number.isFinite(maxDistanceKm) || maxDistanceKm <= minDistanceKm) throw new HttpError(400, "Maximum distance must be greater than minimum distance.");
  if (!Number.isFinite(pickupCharge) || pickupCharge < 0) throw new HttpError(400, "Pickup charge must be zero or greater.");
  return {
    minDistanceKm,
    maxDistanceKm,
    pickupCharge,
    isActive: body.status === "Hidden" || body.status === "Inactive" ? 0 : 1
  };
}

function slabResponse(payload) {
  return {
    minDistanceKm: payload.minDistanceKm,
    maxDistanceKm: payload.maxDistanceKm,
    pickupCharge: payload.pickupCharge,
    distance: `${payload.minDistanceKm} - ${payload.maxDistanceKm} km`,
    charge: `Rs ${payload.pickupCharge}`,
    status: payload.isActive ? "Active" : "Hidden"
  };
}

async function ensureNoSlabOverlap(connection, payload, currentId = null) {
  if (!payload.isActive) return;
  const [[overlap]] = await connection.execute(
    `SELECT id
     FROM pickup_charge_slabs
     WHERE is_active = 1
       AND (:currentId IS NULL OR id <> :currentId)
       AND min_distance_km < :maxDistanceKm
       AND max_distance_km > :minDistanceKm
     LIMIT 1`,
    { currentId, minDistanceKm: payload.minDistanceKm, maxDistanceKm: payload.maxDistanceKm }
  );
  if (overlap) throw new HttpError(400, "Pickup charge distance ranges cannot overlap.");
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function listParams(req, allowedSorts, defaultSort) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
  const offset = (page - 1) * limit;
  const requestedSort = String(req.query.sortBy || defaultSort);
  const sortBy = allowedSorts.includes(requestedSort) ? requestedSort : defaultSort;
  const sortOrder = String(req.query.sortOrder || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "").trim();
  return { page, limit, offset, search, status, sortBy, sortOrder };
}

function pagination(page, limit, totalRecords) {
  const totalPages = Math.max(Math.ceil(totalRecords / limit), 1);
  const currentPage = Math.min(page, totalPages);
  return {
    page: currentPage,
    limit,
    total: totalRecords,
    totalRecords,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1
  };
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeStatus(value) {
  const key = String(value || "confirmed").toLowerCase().replace(/\s+/g, "_");
  const allowed = ["confirmed", "executive_assigned", "executive_reached", "scrap_collected", "payment_completed", "completed", "cancelled"];
  return allowed.includes(key) ? key : "confirmed";
}

function humanizeStatus(value) {
  return String(value || "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeNotificationType(value) {
  const key = String(value || "system").toLowerCase();
  return ["pickup", "offer", "order", "system"].includes(key) ? key : "system";
}

function normalizeSupportStatus(value) {
  const key = String(value || "open").toLowerCase().replace(/\s+/g, "_");
  return ["open", "in_progress", "resolved", "closed"].includes(key) ? key : "open";
}

function normalizeCmsPageType(value) {
  return value === "terms" ? "terms" : "privacy";
}

function sanitizeContent(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .trim();
}

function normalizeMobile(value) {
  const mobile = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(mobile)) {
    throw new HttpError(400, "Please enter a 10 digit mobile number.");
  }
  return mobile;
}

async function hashOptionalPassword(value) {
  const password = String(value || "");
  if (!password) return null;
  if (password.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters.");
  }
  if (password.length > 20) {
    throw new HttpError(400, "Password cannot be more than 20 characters.");
  }
  return bcrypt.hash(password, 12);
}

async function ensureMobileAvailable(mobile, currentUserId = null) {
  const [[existing]] = await pool.execute(
    "SELECT id FROM users WHERE mobile = :mobile AND (:currentUserId IS NULL OR id <> :currentUserId) LIMIT 1",
    { mobile, currentUserId }
  );
  if (existing) {
    throw new HttpError(409, "This mobile number is already registered.");
  }
}

async function persistUploadedCategoryIcon(file) {
  const relativePath = `/uploads/category-icons/${file.filename}`;
  const valid = await isSupportedImageFile(file);
  if (!valid) {
    await fs.unlink(file.path).catch(() => {});
    throw new HttpError(400, "Invalid image file. Please upload a valid PNG, JPG, JPEG, or WebP icon.");
  }
  return relativePath;
}

async function isSupportedImageFile(file) {
  const extension = path.extname(file.originalname || file.filename || "").toLowerCase();
  const buffer = await fs.readFile(file.path);

  if (extension === ".png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (extension === ".webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function publicMediaUrl(req, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const pathValue = String(value).startsWith("/") ? value : `/${value}`;
  return `${req.protocol}://${req.get("host")}${pathValue}`;
}

async function removeLocalUpload(value) {
  if (!value || !String(value).startsWith("/uploads/category-icons/")) return;
  const fileName = path.basename(value);
  const target = path.resolve(process.cwd(), "src/uploads/category-icons", fileName);
  await fs.unlink(target).catch(() => {});
}
