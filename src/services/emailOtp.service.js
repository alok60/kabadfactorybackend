import crypto from "crypto";
import { pool } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { sendEmail } from "./email.service.js";

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

export async function createEmailOtp({ userId, email }) {
  const normalizedEmail = normalizeEmail(email);
  const [[latest]] = await pool.execute(
    `SELECT created_at AS createdAt
     FROM email_verification_otps
     WHERE user_id = :userId AND email = :email
     ORDER BY created_at DESC
     LIMIT 1`,
    { userId, email: normalizedEmail }
  );

  if (latest?.createdAt) {
    const elapsedSeconds = (Date.now() - new Date(latest.createdAt).getTime()) / 1000;
    if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
      throw new HttpError(429, `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds)} seconds before requesting another OTP`);
    }
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await pool.execute(
    `INSERT INTO email_verification_otps (user_id, email, otp_hash, expires_at)
     VALUES (:userId, :email, :otpHash, :expiresAt)`,
    { userId, email: normalizedEmail, otpHash, expiresAt }
  );
  await pool.execute(
    `UPDATE users
     SET email = :email, email_verified_at = NULL
     WHERE id = :userId`,
    { userId, email: normalizedEmail }
  );

  await sendEmail({
    to: normalizedEmail,
    subject: "Kabad Factory email verification OTP",
    text: `Your Kabad Factory verification OTP is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`
  });

  return {
    email: normalizedEmail,
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
    devOtp: process.env.NODE_ENV === "production" ? undefined : otp
  };
}

export async function verifyEmailOtp({ userId, email, otp }) {
  const normalizedEmail = normalizeEmail(email);
  const [rows] = await pool.execute(
    `SELECT id, otp_hash AS otpHash, attempts, expires_at AS expiresAt, consumed_at AS consumedAt
     FROM email_verification_otps
     WHERE user_id = :userId AND email = :email
     ORDER BY created_at DESC
     LIMIT 1`,
    { userId, email: normalizedEmail }
  );

  const record = rows[0];
  if (!record || record.consumedAt || new Date(record.expiresAt).getTime() < Date.now()) {
    throw new HttpError(400, "Invalid or expired OTP");
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(429, "Too many invalid OTP attempts. Please request a new OTP.");
  }

  const isValid = crypto.timingSafeEqual(Buffer.from(record.otpHash), Buffer.from(hashOtp(otp)));
  if (!isValid) {
    await pool.execute("UPDATE email_verification_otps SET attempts = attempts + 1 WHERE id = :id", { id: record.id });
    throw new HttpError(400, "Invalid OTP");
  }

  await pool.execute("UPDATE email_verification_otps SET consumed_at = NOW() WHERE id = :id", { id: record.id });
  await pool.execute(
    `UPDATE users
     SET email = :email, email_verified_at = NOW()
     WHERE id = :userId`,
    { userId, email: normalizedEmail }
  );

  return { email: normalizedEmail, verified: true };
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(`${otp}:${process.env.JWT_SECRET || "dev-secret"}`).digest("hex");
}
