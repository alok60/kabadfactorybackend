import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../config/db.js";
import { signToken } from "../services/token.service.js";
import { HttpError } from "../utils/httpError.js";

const mobileSchema = z.string().transform(normalizeMobile).refine((value) => /^\d{10}$/.test(value), "Please enter a 10 digit mobile number.");
const passwordSchema = z.string().min(6, "Password must be at least 6 characters.").max(20, "Password cannot be more than 20 characters.");

export const loginSchema = z.object({
  body: z.object({
    mobile: mobileSchema,
    password: passwordSchema
  })
});

export const registerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80, "Name is too long."),
    mobile: mobileSchema,
    password: passwordSchema
  })
});


export async function login(req, res, next) {
  const { mobile, password } = req.validated.body;
  const [rows] = await pool.execute(
    `SELECT id, role, name, mobile, email, password_hash AS passwordHash, is_active AS isActive
     FROM users
     WHERE mobile = :mobile
     LIMIT 2`,
    { mobile }
  );

  if (rows.length !== 1) {
    return next(new HttpError(401, "Invalid mobile number or password."));
  }

  const user = rows[0];
  if (!user.isActive) {
    return next(new HttpError(403, "Your account is disabled. Please contact support."));
  }
  if (!user.passwordHash) {
    return next(new HttpError(401, "Please contact support to set your account password."));
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return next(new HttpError(401, "Invalid mobile number or password."));
  }

  await pool.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id", { id: user.id });
  res.json(sessionPayload(user));
}

export async function register(req, res, next) {
  const { name, mobile, password } = req.validated.body;
  const [[existing]] = await pool.execute("SELECT id FROM users WHERE mobile = :mobile LIMIT 1", { mobile });
  if (existing) {
    return next(new HttpError(409, "This mobile number is already registered. Please login or contact support."));
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [created] = await pool.execute(
    `INSERT INTO users (role, name, mobile, password_hash, is_active)
     VALUES ('customer', :name, :mobile, :passwordHash, 1)`,
    { name, mobile, passwordHash }
  );
  const user = { id: created.insertId, role: "customer", name, mobile, email: null };
  await pool.execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id", { id: user.id });
  res.status(201).json(sessionPayload(user));
}

export async function me(req, res, next) {
  const [[user]] = await pool.execute(
    `SELECT id, role, name, mobile, email, is_active AS isActive
     FROM users
     WHERE id = :id
     LIMIT 1`,
    { id: req.user.id }
  );
  if (!user) return next(new HttpError(401, "Invalid or expired token."));
  if (!user.isActive) return next(new HttpError(403, "Your account is disabled. Please contact support."));
  res.json({
    user: {
      id: user.id,
      role: user.role,
      name: user.name || "",
      mobile: user.mobile,
      email: user.email || null
    }
  });
}


function sessionPayload(user) {
  const safeUser = {
    id: user.id,
    role: user.role,
    name: user.name || "",
    mobile: user.mobile,
    email: user.email || null
  };
  return { token: signToken(safeUser), user: safeUser };
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "");
}
