import { z } from "zod";
import { pool } from "../config/db.js";
import { getPickupChargeForPincode } from "../services/pickupCharge.service.js";
import { assertBookingCanBeCancelled } from "../utils/bookingCancellation.js";
import { HttpError } from "../utils/httpError.js";

const allowedTimeSlots = ["9:00 AM - 11:00 AM", "11:00 AM - 2:00 PM", "2:00 PM - 5:00 PM", "5:00 PM - 8:00 PM"];
const allowedStatuses = ["confirmed", "executive_assigned", "executive_reached", "scrap_collected", "payment_completed", "completed", "cancelled"];

export const createBookingSchema = z.object({
  body: z.object({
    addressId: z.number().int(),
    estimatedWeightRange: z.enum(["0-10 kg", "10-30 kg", "30-50 kg", "50-200 kg", "More than 200 kg"], {
      message: "Please select the estimated weight."
    }),
    pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid pickup date.").refine(isTodayOrFuture, "Past dates are not available."),
    timeSlot: z.enum(allowedTimeSlots, { message: "Please select a valid time slot." }),
    instructions: z.string().optional().default(""),
    items: z.array(
      z.object({
        categoryId: z.number().int(),
        estimatedQuantity: z.number().positive()
      })
    ).min(1)
  })
});

export const listBookingsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(20).optional().default(5),
    status: z.enum(["all", "active", ...allowedStatuses]).optional().default("all"),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  })
});

export const cancelBookingSchema = z.object({
  body: z.object({
    reason: z.string().trim().max(255, "Cancellation reason is too long.").optional().default("")
  }).optional().default({})
});

export async function createBooking(req, res) {
  const { addressId, estimatedWeightRange, pickupDate, timeSlot, instructions, items } = req.validated.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [[address]] = await connection.execute(
      `SELECT id, full_name AS fullName, mobile, label, line1, line2, landmark, city, state, pincode
       FROM addresses
       WHERE id = :addressId AND user_id = :customerId AND is_deleted = 0
       LIMIT 1`,
      { addressId, customerId: req.user.id }
    );
    if (!address) {
      await connection.rollback();
      return res.status(400).json({ message: "Please select a valid saved address." });
    }
    const pickupChargeInfo = await getPickupChargeForPincode(connection, address.pincode);

    const [booking] = await connection.execute(
      `INSERT INTO bookings
       (customer_id, address_id, address_full_name, address_mobile, address_label, address_line1, address_line2,
        address_landmark, address_city, address_state, address_pincode, pickup_size, estimated_weight_range, pickup_date, time_slot, instructions, status,
        pickup_charge, pickup_distance_km, pickup_distance_buffer_km, pickup_chargeable_distance_km, pickup_store_id, pickup_charge_slab_id, pickup_pincode)
       VALUES
       (:customerId, :addressId, :addressFullName, :addressMobile, :addressLabel, :addressLine1, :addressLine2,
        :addressLandmark, :addressCity, :addressState, :addressPincode, :pickupSize, :estimatedWeightRange, :pickupDate, :timeSlot, :instructions, 'confirmed',
        :pickupCharge, :pickupDistanceKm, :pickupDistanceBufferKm, :pickupChargeableDistanceKm, :pickupStoreId, :pickupChargeSlabId, :pickupPincode)`,
      {
        customerId: req.user.id,
        addressId,
        addressFullName: address.fullName || null,
        addressMobile: address.mobile || null,
        addressLabel: address.label || null,
        addressLine1: address.line1 || null,
        addressLine2: address.line2 || null,
        addressLandmark: address.landmark || null,
        addressCity: address.city || null,
        addressState: address.state || null,
        addressPincode: address.pincode || null,
        pickupSize: null,
        estimatedWeightRange,
        pickupDate,
        timeSlot,
        instructions,
        pickupCharge: pickupChargeInfo.pickupCharge,
        pickupDistanceKm: pickupChargeInfo.rawDistanceKm,
        pickupDistanceBufferKm: pickupChargeInfo.distanceBufferKm,
        pickupChargeableDistanceKm: pickupChargeInfo.chargeableDistanceKm,
        pickupStoreId: pickupChargeInfo.nearestStoreId,
        pickupChargeSlabId: pickupChargeInfo.pickupChargeSlabId,
        pickupPincode: pickupChargeInfo.customerPincode
      }
    );

    for (const item of items) {
      const [[category]] = await connection.execute(
        `SELECT id, name, unit, price
         FROM scrap_categories
         WHERE id = :categoryId AND is_active = 1
         LIMIT 1`,
        { categoryId: item.categoryId }
      );
      if (!category) {
        await connection.rollback();
        return res.status(400).json({ message: "Please select valid active scrap items." });
      }
      await connection.execute(
        `INSERT INTO booking_items (booking_id, category_id, item_name_snapshot, estimated_quantity, unit_price, unit_snapshot)
         VALUES (:bookingId, :categoryId, :name, :estimatedQuantity, :price, :unit)`,
        { bookingId: booking.insertId, categoryId: item.categoryId, name: category.name, estimatedQuantity: item.estimatedQuantity, price: category.price, unit: category.unit || "kg" }
      );
    }

    await connection.execute(
      "INSERT INTO booking_status_events (booking_id, status, note) VALUES (:bookingId, 'confirmed', 'Booking confirmed')",
      { bookingId: booking.insertId }
    );

    await connection.execute(
      `INSERT INTO notifications (user_id, title, body, type, is_read)
       VALUES (:customerId, 'Pickup booked', :body, 'pickup', 0)`,
      {
        customerId: req.user.id,
        body: `Your pickup #KF${booking.insertId} is booked for ${pickupDate} during ${timeSlot}.`
      }
    );

    await connection.commit();
    res.status(201).json({
      success: true,
      message: "Pickup scheduled successfully",
      id: booking.insertId,
      status: "confirmed",
      pickup: {
        id: booking.insertId,
        pickupCharge: pickupChargeInfo.pickupCharge,
        distanceKm: pickupChargeInfo.chargeableDistanceKm,
        rawDistanceKm: pickupChargeInfo.rawDistanceKm,
        distanceBufferKm: pickupChargeInfo.distanceBufferKm,
        chargeableDistanceKm: pickupChargeInfo.chargeableDistanceKm,
        nearestStoreId: pickupChargeInfo.nearestStoreId
      }
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function isTodayOrFuture(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selected = new Date(`${value}T00:00:00`);
  return selected.getTime() >= today.getTime();
}

export async function listMyBookings(req, res) {
  const { page, limit, status, startDate, endDate } = req.validated.query;
  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ message: "Start date cannot be after end date." });
  }
  const offset = (page - 1) * limit;
  const filters = ["b.customer_id = :customerId"];
  const params = { customerId: req.user.id, limit, offset };

  if (status === "active") {
    filters.push("b.status NOT IN ('completed', 'cancelled')");
  } else if (status && status !== "all") {
    filters.push("b.status = :status");
    params.status = status;
  }
  if (startDate) {
    filters.push("b.pickup_date >= :startDate");
    params.startDate = startDate;
  }
  if (endDate) {
    filters.push("b.pickup_date <= :endDate");
    params.endDate = endDate;
  }

  const [rows] = await pool.execute(
    `SELECT b.id, b.pickup_date AS pickupDate, b.time_slot AS timeSlot, b.status, b.total_amount AS totalAmount,
            b.pickup_charge AS pickupCharge, b.pickup_distance_km AS pickupDistanceKm,
            b.pickup_distance_buffer_km AS pickupDistanceBufferKm,
            b.pickup_chargeable_distance_km AS pickupChargeableDistanceKm,
            b.pickup_pincode AS pickupPincode,
            b.created_at AS bookingDate, b.payment_mode AS paymentMode,
            e.name AS executiveName,
            e.mobile AS executiveMobile,
            e.email AS executiveEmail,
            COALESCE(b.address_label, a.label) AS addressLabel,
            COALESCE(b.address_line1, a.line1) AS line1,
            COALESCE(b.address_line2, a.line2) AS line2,
            COALESCE(b.address_landmark, a.landmark) AS landmark,
            COALESCE(b.address_city, a.city) AS city,
            COALESCE(b.address_state, a.state) AS state,
            COALESCE(b.address_pincode, a.pincode) AS pincode,
            COUNT(bi.id) AS itemCount
     FROM bookings b
     JOIN addresses a ON a.id = b.address_id
     LEFT JOIN users e ON e.id = b.executive_id AND e.role = 'executive'
     LEFT JOIN booking_items bi ON bi.booking_id = b.id
     WHERE ${filters.join(" AND ")}
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT :limit OFFSET :offset`,
    params
  );

  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM bookings b
     WHERE ${filters.join(" AND ")}`,
    params
  );

  const total = Number(countRow?.total || 0);
  res.json({
    data: rows.map((row) => ({
      ...row,
      assignedExecutive: row.executiveName
        ? {
          name: row.executiveName,
          mobile: row.executiveMobile || null,
          profileImageUrl: null
        }
        : null,
      executiveName: undefined,
      executiveMobile: undefined,
      executiveEmail: undefined
    })),
    pagination: { page, limit, total, hasMore: offset + rows.length < total }
  });
}

export async function getBooking(req, res) {
  const [rows] = await pool.execute(
    `SELECT b.*, b.created_at AS bookingDate,
            u.name AS customerName, u.mobile AS customerMobile, u.email AS customerEmail, u.email_verified_at AS customerEmailVerifiedAt,
            e.name AS executiveName,
            e.mobile AS executiveMobile,
            b.pickup_charge AS pickupCharge,
            b.pickup_distance_km AS pickupDistanceKm,
            b.pickup_distance_buffer_km AS pickupDistanceBufferKm,
            b.pickup_chargeable_distance_km AS pickupChargeableDistanceKm,
            b.pickup_pincode AS pickupPincode,
            COALESCE(b.address_line1, a.line1) AS line1,
            COALESCE(b.address_line2, a.line2) AS line2,
            COALESCE(b.address_landmark, a.landmark) AS landmark,
            COALESCE(b.address_city, a.city) AS city,
            COALESCE(b.address_state, a.state) AS state,
            COALESCE(b.address_pincode, a.pincode) AS pincode
     FROM bookings b
     JOIN addresses a ON a.id = b.address_id
     JOIN users u ON u.id = b.customer_id
     LEFT JOIN users e ON e.id = b.executive_id
     WHERE b.id = :id AND b.customer_id = :customerId
     LIMIT 1`,
    {
    id: req.params.id,
    customerId: req.user.id
    }
  );

  if (!rows[0]) return res.status(404).json({ message: "Order not found." });

  const [events] = await pool.execute(
    "SELECT status, note, created_at AS createdAt FROM booking_status_events WHERE booking_id = :id ORDER BY created_at",
    { id: req.params.id }
  );

  const items = await getBookingItems(req.params.id, "Could not load order items. Please try again.");
  const otherItems = await getBookingOtherItems(req.params.id, "Could not load order items. Please try again.");

  const booking = rows[0] || null;
  res.json({
    data: booking
      ? {
        ...booking,
        assignedExecutive: booking.executiveName
          ? {
            name: booking.executiveName,
            mobile: booking.executiveMobile || null,
            profileImageUrl: null
          }
          : null
      }
      : null,
    timeline: events,
    items,
    otherItems
  });
}

export async function cancelBooking(req, res) {
  const reason = req.validated?.body?.reason || "";
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [[booking]] = await connection.execute(
      `SELECT id, customer_id AS customerId, executive_id AS executiveId, status
       FROM bookings
       WHERE id = :id AND customer_id = :customerId
       LIMIT 1
       FOR UPDATE`,
      { id: req.params.id, customerId: req.user.id }
    );

    assertBookingCanBeCancelled(booking);

    const [result] = await connection.execute(
      `UPDATE bookings
       SET status = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           cancellation_reason = :reason
       WHERE id = :id
         AND customer_id = :customerId
         AND executive_id IS NULL
         AND status NOT IN ('cancelled', 'scrap_collected', 'payment_completed', 'completed')`,
      { id: req.params.id, customerId: req.user.id, reason: reason || null }
    );

    if (!result.affectedRows) {
      const [[latest]] = await connection.execute(
        `SELECT id, customer_id AS customerId, executive_id AS executiveId, status
         FROM bookings
         WHERE id = :id AND customer_id = :customerId
         LIMIT 1
         FOR UPDATE`,
        { id: req.params.id, customerId: req.user.id }
      );
      assertBookingCanBeCancelled(latest);
      throw new HttpError(409, "Pickup could not be cancelled. Please refresh and try again.");
    }

    await connection.execute(
      "INSERT INTO booking_status_events (booking_id, status, note) VALUES (:bookingId, 'cancelled', :note)",
      { bookingId: req.params.id, note: reason ? `Cancelled by customer - ${reason}` : "Cancelled by customer" }
    );

    await connection.execute(
      `INSERT INTO notifications (user_id, title, body, type, is_read)
       VALUES (:customerId, 'Pickup cancelled', :body, 'pickup', 0)`,
      { customerId: req.user.id, body: `Your pickup #KF${req.params.id} has been cancelled.` }
    );

    const [[updated]] = await connection.execute(
      `SELECT b.id, b.pickup_date AS pickupDate, b.time_slot AS timeSlot, b.status, b.total_amount AS totalAmount,
              b.pickup_charge AS pickupCharge, b.pickup_distance_km AS pickupDistanceKm,
              b.pickup_distance_buffer_km AS pickupDistanceBufferKm,
              b.pickup_chargeable_distance_km AS pickupChargeableDistanceKm,
              b.pickup_pincode AS pickupPincode, b.cancelled_at AS cancelledAt, b.cancellation_reason AS cancellationReason,
              b.created_at AS bookingDate, b.payment_mode AS paymentMode,
              COUNT(bi.id) AS itemCount
       FROM bookings b
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       WHERE b.id = :id AND b.customer_id = :customerId
       GROUP BY b.id
       LIMIT 1`,
      { id: req.params.id, customerId: req.user.id }
    );

    await connection.commit();
    res.json({ success: true, message: "Pickup cancelled successfully.", data: updated });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function downloadBookingBill(req, res) {
  const [[booking]] = await pool.execute(
    `SELECT b.*, b.created_at AS bookingDate,
            u.name AS customerName, u.mobile AS customerMobile, u.email AS customerEmail, u.email_verified_at AS customerEmailVerifiedAt,
            e.name AS executiveName,
            COALESCE(b.address_full_name, a.full_name) AS addressFullName,
            COALESCE(b.address_mobile, a.mobile) AS addressMobile,
            COALESCE(b.address_label, a.label) AS addressLabel,
            COALESCE(b.address_line1, a.line1) AS line1,
            COALESCE(b.address_line2, a.line2) AS line2,
            COALESCE(b.address_landmark, a.landmark) AS landmark,
            COALESCE(b.address_city, a.city) AS city,
            COALESCE(b.address_state, a.state) AS state,
            COALESCE(b.address_pincode, a.pincode) AS pincode,
            b.pickup_charge AS pickupCharge,
            b.pickup_distance_km AS pickupDistanceKm,
            b.pickup_distance_buffer_km AS pickupDistanceBufferKm,
            b.pickup_chargeable_distance_km AS pickupChargeableDistanceKm,
            b.pickup_pincode AS pickupPincode,
            b.collected_at AS collectedAt,
            b.payment_completed_at AS paymentCompletedAt,
            b.payment_reference AS paymentReference
     FROM bookings b
     JOIN users u ON u.id = b.customer_id
     LEFT JOIN users e ON e.id = b.executive_id
     JOIN addresses a ON a.id = b.address_id
     WHERE b.id = :id AND (b.customer_id = :userId OR b.executive_id = :userId OR :role = 'admin')
     LIMIT 1`,
    { id: req.params.id, userId: req.user.id, role: req.user.role }
  );

  if (!booking) return res.status(404).json({ message: "Pickup not found." });
  if (booking.status !== "completed") return res.status(400).json({ message: "Bill is available after pickup completion." });

  const items = await getBookingItems(req.params.id, "Could not download the bill. Please try again.");
  const otherItems = await getBookingOtherItems(req.params.id, "Could not download the bill. Please try again.");

  const completion = await latestStatusDate(req.params.id, "completed");
  const pdf = createInvoicePdf(booking, items, otherItems, completion);
  const filename = `Kabad-Factory-Bill-KF${booking.id}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(pdf);
}

async function getBookingItems(bookingId, message) {
  try {
    const [items] = await pool.execute(
      `SELECT bi.id, bi.estimated_quantity AS estimatedQuantity, bi.actual_quantity AS actualQuantity,
              bi.amount,
              COALESCE(bi.item_name_snapshot, c.name) AS name,
              COALESCE(bi.unit_snapshot, c.unit) AS unit,
              COALESCE(bi.unit_price, c.price) AS price,
              c.description
       FROM booking_items bi
       JOIN scrap_categories c ON c.id = bi.category_id
       WHERE bi.booking_id = :bookingId
       ORDER BY c.name, bi.id`,
      { bookingId }
    );
    return items;
  } catch (error) {
    console.error("Failed to load booking items", { bookingId, error });
    throw new HttpError(500, message);
  }
}

async function getBookingOtherItems(bookingId, message) {
  try {
    const [items] = await pool.execute(
      `SELECT id, description AS name, actual_quantity AS actualQuantity, unit, unit_price AS price, amount, 1 AS isOther
       FROM booking_other_items
       WHERE booking_id = :bookingId
       ORDER BY id`,
      { bookingId }
    );
    return items;
  } catch (error) {
    console.error("Failed to load booking other items", { bookingId, error });
    throw new HttpError(500, message);
  }
}

async function latestStatusDate(bookingId, status) {
  const [[row]] = await pool.execute(
    "SELECT created_at AS createdAt FROM booking_status_events WHERE booking_id = :bookingId AND status = :status ORDER BY created_at DESC LIMIT 1",
    { bookingId, status }
  );
  return row?.createdAt || null;
}

function createInvoicePdf(booking, items, otherItems, completion) {
  const scrapTotal = roundMoney([...items, ...otherItems].reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const pickupCharge = roundMoney(booking.pickupCharge ?? booking.pickup_charge ?? 0);
  const payableTotal = roundMoney(booking.total_amount || 0);
  const rows = [...items, ...otherItems].map((item) => {
    const quantity = Number(item.actualQuantity || item.estimatedQuantity || 0);
    const unit = item.unit || "kg";
    return [
      `${item.isOther ? "Other - " : ""}${item.name || "Scrap Item"}`,
      `${formatNumber(quantity)} ${unit}`,
      `Rs ${formatNumber(item.price || 0)}/${unit}`,
      `Rs ${formatNumber(item.amount || 0)}`
    ];
  });
  const address = [booking.line1, booking.line2, booking.landmark, booking.city, booking.state, booking.pincode].filter(Boolean).join(", ");
  const pages = [[]];
  let current = pages[0];
  const push = (op) => current.push(op);
  let y = 790;

  function nextPage() {
    current = [];
    pages.push(current);
    y = 790;
    drawHeader();
  }

  function text(value, x, size = 10, bold = false, color = "0 0 0") {
    push(`${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escapePdfText(value)}) Tj ET`);
  }

  function line(x1, y1, x2, y2, color = "0.78 0.84 0.79") {
    push(`${color} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  function rect(x, top, width, height, color) {
    push(`${color} rg ${x} ${top - height} ${width} ${height} re f`);
  }

  function drawHeader() {
    rect(40, 815, 515, 78, "0.145 0.427 0.227");
    push("1 1 1 rg 54 752 46 46 re f");
    y = 778;
    text("KF", 67, 17, true, "0.145 0.427 0.227");
    y = 784;
    text("KABAD FACTORY", 112, 19, true, "1 1 1");
    y = 763;
    text("Innovators of Recycling | contact@kabadfactory.com | 8319060820", 112, 10, false, "1 1 1");
    y = 724;
    text("SCRAP PICKUP BILL", 40, 18, true);
    y -= 14;
    line(40, y, 555, y, "0.145 0.427 0.227");
    y -= 24;
  }

  function kv(label, value, x) {
    text(label, x, 8, true);
    y -= 12;
    wrapText(value || "-", x, 210, 9);
  }

  function wrapText(value, x, maxChars = 60, size = 9) {
    const words = String(value || "").split(/\s+/);
    let lineText = "";
    for (const word of words) {
      if (`${lineText} ${word}`.trim().length > maxChars) {
        text(lineText, x, size, false);
        y -= 12;
        lineText = word;
      } else {
        lineText = `${lineText} ${word}`.trim();
      }
    }
    if (lineText) {
      text(lineText, x, size, false);
      y -= 12;
    }
  }

  drawHeader();
  const infoY = y;
  kv("Bill Number", `KF-BILL-${booking.id}`, 40);
  y = infoY;
  kv("Order Number", `KF${booking.id}`, 220);
  y = infoY;
  kv("Generated", formatDate(new Date()), 400);
  y -= 10;
  line(40, y, 555, y);
  y -= 20;

  const customerY = y;
  text("Customer Details", 40, 12, true);
  y -= 15;
  wrapText(`${booking.customerName || "Customer"} | ${booking.customerMobile || booking.addressMobile || ""}`, 40, 64, 10);
  wrapText(booking.customerEmailVerifiedAt ? booking.customerEmail : "Email: Not verified", 40, 64, 9);
  wrapText(`Address: ${address}`, 40, 78, 9);
  y = customerY;
  text("Pickup & Payment", 335, 12, true);
  y -= 15;
  wrapText(`Pickup: ${formatDate(booking.pickupDate)} | ${booking.time_slot || booking.timeSlot || ""}`, 335, 38, 9);
  wrapText(`Collected: ${formatDate(booking.collectedAt)}`, 335, 38, 9);
  wrapText(`Completed: ${formatDate(completion)}`, 335, 38, 9);
  wrapText(`Payment: ${humanizePayment(booking.payment_mode)} | ${booking.paymentReference || "-"}`, 335, 38, 9);
  wrapText(`Executive: ${booking.executiveName || "Not assigned"}${booking.executiveMobile ? ` | ${booking.executiveMobile}` : ""}`, 335, 38, 9);
  y = Math.min(y, customerY - 96);
  line(40, y, 555, y);
  y -= 20;

  drawTableHeader();
  rows.forEach((row) => {
    if (y < 95) nextPage();
    drawTableRow(row);
  });
  y -= 8;
  line(360, y, 555, y, "0.145 0.427 0.227");
  y -= 18;
  text("Scrap Subtotal", 370, 11, true);
  text(`Rs ${formatNumber(scrapTotal)}`, 485, 11, true);
  y -= 18;
  text("Pickup Charge", 370, 11, true);
  text(`- Rs ${formatNumber(pickupCharge)}`, 485, 11, true);
  y -= 18;
  text("Total Payable", 370, 13, true);
  text(`Rs ${formatNumber(payableTotal)}`, 475, 13, true);
  y -= 34;

  if (booking.instructions) {
    text("Instructions", 40, 11, true);
    y -= 13;
    wrapText(booking.instructions, 40, 90, 9);
  }
  if (y < 120) nextPage();
  y = Math.max(y, 112);
  text("Digitally Signed by Kabad Factory", 40, 10, true);
  y -= 14;
  text("This bill is system-generated and does not require a physical signature.", 40, 8, false);
  y -= 16;
  text("Thank you for contributing to a cleaner and greener environment.", 40, 10, true);

  function drawTableHeader() {
    rect(40, y + 12, 515, 26, "0.918 0.969 0.925");
    text("Item", 50, 10, true);
    text("Weight", 285, 10, true);
    text("Rate", 380, 10, true);
    text("Amount", 485, 10, true);
    y -= 24;
  }

  function drawTableRow(row) {
    const rowY = y;
    wrapText(row[0], 50, 34, 9);
    const usedY = y;
    y = rowY;
    text(row[1], 285, 9, false);
    text(row[2], 380, 9, false);
    text(row[3], 485, 9, true);
    y = Math.min(usedY, rowY - 16);
    line(40, y + 4, 555, y + 4);
  }

  return buildPdf(pages);
}

function buildPdf(pageStreams) {
  const objects = [];
  const pageObjectNumbers = [];
  const fontRegularObject = 3 + pageStreams.length * 2;
  const fontBoldObject = fontRegularObject + 1;
  pageStreams.forEach((ops, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    pageObjectNumbers.push(pageNumber);
    const stream = ops.join("\n");
    objects[pageNumber - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRegularObject} 0 R /F2 ${fontBoldObject} 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    objects[contentNumber - 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;
  objects[fontRegularObject - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[fontBoldObject - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, "\\$&").slice(0, 120);
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function humanizePayment(value) {
  return String(value || "cash")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getFullYear()}`;
}
