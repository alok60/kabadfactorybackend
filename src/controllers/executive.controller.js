import { z } from "zod";
import { pool } from "../config/db.js";

export const updatePickupSchema = z.object({
  body: z.object({
    status: z.enum(["executive_assigned", "executive_reached", "payment_completed", "completed"]),
    actualWeight: z.number().optional(),
    totalAmount: z.number().optional(),
    paymentMode: z.enum(["cash", "upi", "bank_transfer", "other"]).optional(),
    paymentReference: z.string().max(120).optional().default(""),
    note: z.string().optional().default("")
  })
});

export const collectScrapSchema = z.object({
  body: z.object({
    items: z.array(
      z.object({
        itemId: z.number().int().positive(),
        weight: z.coerce.number().positive("Weight must be greater than zero.")
      })
    ).min(1, "Please enter collected weight for each item."),
    otherItem: z.object({
      description: z.string().trim().max(160).optional().default(""),
      weight: z.union([z.coerce.number().positive(), z.literal(""), z.null()]).optional(),
      rate: z.union([z.coerce.number().positive(), z.literal(""), z.null()]).optional(),
      unit: z.string().trim().max(30).optional().default("kg")
    }).optional()
  })
});

export async function listAssignedPickups(req, res) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
  const offset = (page - 1) * limit;
  const status = String(req.query.status || "").trim();
  const search = String(req.query.search || "").trim();
  const filters = ["b.executive_id = :executiveId"];
  const params = { executiveId: req.user.id, limit, offset };
  if (status) {
    filters.push("b.status = :status");
    params.status = status;
  } else {
    filters.push("b.status NOT IN ('completed', 'cancelled')");
  }
  if (search) {
    filters.push("(CONCAT('#KF', b.id) LIKE :search OR u.name LIKE :search OR u.mobile LIKE :search OR COALESCE(b.address_city, a.city, '') LIKE :search)");
    params.search = `%${search}%`;
  }
  const [rows] = await pool.execute(
    `SELECT b.id, b.pickup_date AS pickupDate, b.time_slot AS timeSlot, b.status,
            b.instructions, b.estimated_weight_range AS estimatedWeightRange, b.total_amount AS totalAmount, b.payment_mode AS paymentMode,
            b.pickup_charge AS pickupCharge, b.pickup_distance_km AS pickupDistanceKm,
            b.assigned_at AS assignedAt,
            u.name AS customerName, u.mobile,
            COALESCE(b.address_line1, a.line1) AS line1,
            COALESCE(b.address_line2, a.line2) AS line2,
            COALESCE(b.address_landmark, a.landmark) AS landmark,
            COALESCE(b.address_city, a.city) AS city,
            COALESCE(b.address_state, a.state) AS state,
            COALESCE(b.address_pincode, a.pincode) AS pincode,
            a.latitude, a.longitude,
            COUNT(bi.id) AS itemCount
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     JOIN addresses a ON a.id = b.address_id
     LEFT JOIN booking_items bi ON bi.booking_id = b.id
     WHERE ${filters.join(" AND ")}
     GROUP BY b.id
     ORDER BY COALESCE(b.assigned_at, b.created_at) DESC, b.id DESC
     LIMIT :limit OFFSET :offset`,
    params
  );

  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     JOIN addresses a ON a.id = b.address_id
     WHERE ${filters.join(" AND ")}`,
    params
  );
  const total = Number(countRow.total || 0);
  res.json({ data: rows, pagination: { page, limit, totalRecords: total, totalPages: Math.max(Math.ceil(total / limit), 1), hasNextPage: offset + rows.length < total } });
}

export async function getAssignedPickup(req, res) {
  const [[pickup]] = await pool.execute(
    `SELECT b.id, b.status, b.total_amount AS totalAmount, b.payment_mode AS paymentMode,
            b.pickup_charge AS pickupCharge, b.pickup_distance_km AS pickupDistanceKm,
            u.name AS customerName, u.mobile
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     WHERE b.id = :id AND (b.executive_id = :executiveId OR :role = 'admin')
     LIMIT 1`,
    { id: req.params.id, executiveId: req.user.id, role: req.user.role }
  );

  if (!pickup) return res.status(404).json({ message: "Assigned pickup not found." });

  const [items] = await pool.execute(
    `SELECT bi.id AS itemId, bi.estimated_quantity AS estimatedQuantity, bi.actual_quantity AS actualWeight,
            COALESCE(bi.unit_price, c.price) AS rate, COALESCE(bi.unit_snapshot, c.unit) AS unit,
            bi.amount, c.name, c.description
     FROM booking_items bi
     JOIN scrap_categories c ON c.id = bi.category_id
     WHERE bi.booking_id = :id
     ORDER BY c.name, bi.id`,
    { id: req.params.id }
  );

  const [otherItems] = await pool.execute(
    `SELECT id, description, actual_quantity AS actualWeight, unit, unit_price AS rate, amount
     FROM booking_other_items
     WHERE booking_id = :id
     ORDER BY id`,
    { id: req.params.id }
  );

  res.json({ data: pickup, items, otherItems });
}

export async function updatePickupStatus(req, res) {
  const { status, actualWeight, totalAmount, paymentMode, paymentReference, note } = req.validated.body;
  const [[booking]] = await pool.execute(
    "SELECT id, status, customer_id AS customerId, total_amount AS totalAmount FROM bookings WHERE id = :id AND (executive_id = :executiveId OR :role = 'admin') LIMIT 1",
    { id: req.params.id, executiveId: req.user.id, role: req.user.role }
  );

  if (!booking) return res.status(404).json({ message: "Assigned pickup not found." });
  if (status === "payment_completed" && Number(booking.totalAmount || 0) <= 0) {
    return res.status(400).json({ message: "Collect scrap and calculate payable amount before payment completion." });
  }
  if (!isNextStatus(booking.status, status)) {
    return res.status(400).json({ message: "Please follow the valid pickup status sequence." });
  }

  await pool.execute(
    `UPDATE bookings
     SET status = :status,
         actual_weight = COALESCE(:actualWeight, actual_weight),
         total_amount = COALESCE(:totalAmount, total_amount),
         payment_mode = CASE WHEN :status = 'payment_completed' THEN :paymentMode ELSE payment_mode END,
         payment_reference = CASE WHEN :status = 'payment_completed' THEN :paymentReference ELSE payment_reference END,
         payment_completed_at = CASE WHEN :status = 'payment_completed' THEN CURRENT_TIMESTAMP ELSE payment_completed_at END
     WHERE id = :id AND (executive_id = :executiveId OR :role = 'admin')`,
    {
      status,
      actualWeight: actualWeight ?? null,
      totalAmount: totalAmount ?? null,
      paymentMode: normalizePaymentMode(paymentMode),
      paymentReference: paymentReference || null,
      id: req.params.id,
      executiveId: req.user.id,
      role: req.user.role
    }
  );

  await pool.execute("INSERT INTO booking_status_events (booking_id, status, note) VALUES (:id, :status, :note)", {
    id: req.params.id,
    status,
    note
  });

  await pool.execute(
    "INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (:userId, :title, :body, 'pickup', 0)",
    {
      userId: booking.customerId,
      title: statusTitle(status),
      body: status === "payment_completed"
        ? `Payment of Rs ${Number(booking.totalAmount || 0).toFixed(2)} has been completed for order KF${booking.id}.`
        : `Your pickup #KF${booking.id} status is now ${statusTitle(status)}.`
    }
  );

  res.json({ id: Number(req.params.id), status });
}

export async function collectScrap(req, res) {
  const { items, otherItem } = req.validated.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [[booking]] = await connection.execute(
      `SELECT id, status, customer_id AS customerId, pickup_charge AS pickupCharge
       FROM bookings
       WHERE id = :id AND (executive_id = :executiveId OR :role = 'admin')
       LIMIT 1 FOR UPDATE`,
      { id: req.params.id, executiveId: req.user.id, role: req.user.role }
    );

    if (!booking) {
      await connection.rollback();
      return res.status(404).json({ message: "Assigned pickup not found." });
    }
    if (booking.status !== "executive_reached") {
      await connection.rollback();
      return res.status(400).json({ message: "This order cannot be marked collected in its current status." });
    }

    const [selectedRows] = await connection.execute(
      `SELECT bi.id AS itemId, bi.category_id AS categoryId,
              COALESCE(bi.item_name_snapshot, c.name) AS name,
              COALESCE(bi.unit_snapshot, c.unit) AS unit,
              COALESCE(bi.unit_price, c.price) AS price
       FROM booking_items bi
       JOIN scrap_categories c ON c.id = bi.category_id
       WHERE bi.booking_id = :id`,
      { id: req.params.id }
    );
    const selectedById = new Map(selectedRows.map((row) => [Number(row.itemId), row]));
    const submittedById = new Map(items.map((item) => [Number(item.itemId), item]));

    if (selectedRows.length === 0 || submittedById.size !== selectedRows.length) {
      await connection.rollback();
      return res.status(400).json({ message: "Please enter collected weight for every selected item." });
    }

    const responseItems = [];
    let totalCents = 0;
    let totalWeight = 0;

    for (const row of selectedRows) {
      const submitted = submittedById.get(Number(row.itemId));
      if (!submitted) {
        await connection.rollback();
        return res.status(400).json({ message: "Please enter collected weight for every selected item." });
      }

      const weight = roundQuantity(submitted.weight);
      const rate = roundMoney(row.price);
      const amount = roundMoney(weight * rate);
      totalCents += Math.round(amount * 100);
      totalWeight += weight;

      await connection.execute(
        `UPDATE booking_items
         SET actual_quantity = :weight,
             item_name_snapshot = :name,
             unit_price = :rate,
             unit_snapshot = :unit,
             amount = :amount,
             collected_by = :executiveId,
             collected_at = CURRENT_TIMESTAMP
         WHERE id = :itemId AND booking_id = :bookingId`,
        { weight, name: row.name, rate, unit: row.unit || "kg", amount, executiveId: req.user.id, itemId: row.itemId, bookingId: req.params.id }
      );

      responseItems.push({ itemId: row.itemId, name: row.name, weight, rate, unit: row.unit || "kg", amount });
    }

    await connection.execute("DELETE FROM booking_other_items WHERE booking_id = :bookingId", { bookingId: req.params.id });
    const hasOther = otherItem && (otherItem.description || otherItem.weight || otherItem.rate);
    let responseOtherItem = null;
    if (hasOther) {
      const description = String(otherItem.description || "").trim();
      const weight = roundQuantity(otherItem.weight);
      const rate = roundMoney(otherItem.rate);
      const unit = String(otherItem.unit || "kg").trim() || "kg";
      if (!description || weight <= 0 || rate <= 0) {
        await connection.rollback();
        return res.status(400).json({ message: "Please enter valid Other item description, weight, and rate." });
      }
      const amount = roundMoney(weight * rate);
      totalCents += Math.round(amount * 100);
      totalWeight += weight;
      await connection.execute(
        `INSERT INTO booking_other_items (booking_id, description, actual_quantity, unit, unit_price, amount, collected_by)
         VALUES (:bookingId, :description, :weight, :unit, :rate, :amount, :executiveId)`,
        { bookingId: req.params.id, description, weight, unit, rate, amount, executiveId: req.user.id }
      );
      responseOtherItem = { description, weight, unit, rate, amount };
    }

    const scrapTotal = roundMoney(totalCents / 100);
    const pickupCharge = roundMoney(booking.pickupCharge);
    const totalAmount = Math.max(0, roundMoney(scrapTotal - pickupCharge));
    await connection.execute(
      `UPDATE bookings
       SET status = 'scrap_collected',
           actual_weight = :actualWeight,
           total_amount = :totalAmount,
           collected_at = CURRENT_TIMESTAMP
       WHERE id = :bookingId`,
      { actualWeight: roundQuantity(totalWeight), totalAmount, bookingId: req.params.id }
    );

    await connection.execute(
      "INSERT INTO booking_status_events (booking_id, status, note) VALUES (:bookingId, 'scrap_collected', :note)",
      { bookingId: req.params.id, note: `Scrap collected. Scrap total Rs ${scrapTotal.toFixed(2)}, pickup charge Rs ${pickupCharge.toFixed(2)}, payable Rs ${totalAmount.toFixed(2)}.` }
    );

    await connection.execute(
      "INSERT INTO notifications (user_id, title, body, type, is_read) VALUES (:userId, 'Scrap collected', :body, 'pickup', 0)",
      { userId: booking.customerId, body: `Your scrap has been collected. Total payable amount: Rs ${totalAmount.toFixed(2)}.` }
    );

    await connection.commit();
    res.json({
      success: true,
      message: "Scrap collected successfully.",
      data: { orderId: Number(req.params.id), status: "scrap_collected", items: responseItems, otherItem: responseOtherItem, scrapTotalAmount: scrapTotal, pickupCharge, totalPayableAmount: totalAmount }
    });
  } catch (error) {
    await connection.rollback();
    console.error("Failed to collect scrap", { bookingId: req.params.id, executiveId: req.user?.id, error });
    res.status(500).json({ message: "Could not save collection details. Please try again." });
  } finally {
    connection.release();
  }
}

function isNextStatus(current, next) {
  const sequence = ["confirmed", "executive_assigned", "executive_reached", "scrap_collected", "payment_completed", "completed"];
  const currentIndex = sequence.indexOf(current);
  const nextIndex = sequence.indexOf(next);
  return nextIndex === currentIndex + 1;
}

function statusTitle(value = "") {
  return String(value).split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePaymentMode(value) {
  if (value === "upi" || value === "bank_transfer" || value === "other") return value;
  return "cash";
}
