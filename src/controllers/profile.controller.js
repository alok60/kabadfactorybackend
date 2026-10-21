import { z } from "zod";
import { pool } from "../config/db.js";
import { createEmailOtp, normalizeEmail, verifyEmailOtp } from "../services/emailOtp.service.js";

export const createSupportQuerySchema = z.object({
  body: z.object({
    subject: z.string().min(3).max(160),
    category: z.enum(["pickup", "payment", "pricing", "account", "other"]).default("other"),
    message: z.string().min(10).max(2000),
    attachmentUrl: z.string().url().optional().or(z.literal("")).default("")
  })
});

export const requestEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email()
  })
});

export const verifyEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/)
  })
});

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Full name is required.").max(120, "Full name is too long.")
      .regex(/^[A-Za-z][A-Za-z .'-]*$/, "Please enter a valid full name.")
  })
});

export async function getProfile(req, res) {
  const [[user]] = await pool.execute(
    `SELECT id, name, mobile, email, email_verified_at AS emailVerifiedAt, role, created_at AS createdAt
     FROM users
     WHERE id = :id
     LIMIT 1`,
    { id: req.user.id }
  );

  const [addresses] = await pool.execute(
    `SELECT id, full_name AS fullName, mobile, label, line1, line2, landmark, city, state, pincode,
            latitude, longitude, is_default AS isDefault
     FROM addresses
     WHERE user_id = :id AND is_deleted = 0
     ORDER BY is_default DESC, id DESC`,
    { id: req.user.id }
  );

  const [bookings] = await pool.execute(
    `SELECT id, pickup_date AS pickupDate, time_slot AS timeSlot, status, total_amount AS totalAmount
     FROM bookings
     WHERE customer_id = :id
     ORDER BY created_at DESC
     LIMIT 10`,
    { id: req.user.id }
  );

  const [supportQueries] = await pool.execute(
    `SELECT id, subject, category, message, attachment_url AS attachmentUrl, status, admin_note AS adminNote, created_at AS createdAt
     FROM support_queries
     WHERE user_id = :id
     ORDER BY created_at DESC
     LIMIT 5`,
    { id: req.user.id }
  );

  res.json({ user, addresses, bookings, supportQueries });
}

export async function updateProfile(req, res) {
  const name = req.validated.body.name.trim().replace(/\s+/g, " ");
  const [result] = await pool.execute(
    "UPDATE users SET name = :name WHERE id = :userId",
    { userId: req.user.id, name }
  );

  if (!result.affectedRows) {
    return res.status(404).json({ message: "User profile not found." });
  }

  const [[user]] = await pool.execute(
    `SELECT id, name, mobile, email, email_verified_at AS emailVerifiedAt, created_at AS createdAt
     FROM users
     WHERE id = :userId
     LIMIT 1`,
    { userId: req.user.id }
  );

  res.json({ message: "Name updated successfully.", user });
}

export async function createSupportQuery(req, res) {
  const { subject, category, message, attachmentUrl } = req.validated.body;
  const [result] = await pool.execute(
    `INSERT INTO support_queries (user_id, subject, category, message, attachment_url, status)
     VALUES (:userId, :subject, :category, :message, :attachmentUrl, 'open')`,
    { userId: req.user.id, subject, category, message, attachmentUrl: attachmentUrl || null }
  );

  res.status(201).json({
    id: result.insertId,
    subject,
    category,
    message,
    status: "Open"
  });
}

export async function requestEmailOtp(req, res) {
  const result = await createEmailOtp({ userId: req.user.id, email: req.validated.body.email });
  res.json({ message: "Email OTP sent", ...result });
}

export async function resendEmailOtp(req, res) {
  const result = await createEmailOtp({ userId: req.user.id, email: req.validated.body.email });
  res.json({ message: "Email OTP resent", ...result });
}

export async function verifyProfileEmailOtp(req, res) {
  const result = await verifyEmailOtp({
    userId: req.user.id,
    email: normalizeEmail(req.validated.body.email),
    otp: req.validated.body.otp
  });
  res.json({ message: "Email verified successfully", ...result });
}

export async function listMySupportQueries(req, res) {
  const [rows] = await pool.execute(
    `SELECT id, subject, category, message, attachment_url AS attachmentUrl, status, admin_note AS adminNote,
            created_at AS createdAt, updated_at AS updatedAt
     FROM support_queries
     WHERE user_id = :userId
     ORDER BY created_at DESC`,
    { userId: req.user.id }
  );
  res.json({ data: rows });
}

export async function getMySupportQuery(req, res) {
  const [[row]] = await pool.execute(
    `SELECT id, subject, category, message, attachment_url AS attachmentUrl, status, admin_note AS adminNote,
            created_at AS createdAt, updated_at AS updatedAt
     FROM support_queries
     WHERE user_id = :userId AND id = :id
     LIMIT 1`,
    { userId: req.user.id, id: req.params.id }
  );
  res.json({ data: row || null });
}
