
import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.routes.js";
import categoryRoutes from "./routes/category.routes.js";
import cmsRoutes from "./routes/cms.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import addressRoutes from "./routes/address.routes.js";
import executiveRoutes from "./routes/executive.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import serviceabilityRoutes from "./routes/serviceability.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";

// Configure these in your production environment.
const allowedOrigins = [
  process.env.ADMIN_URL,
  process.env.WEBSITE_URL,
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/$/, ""));

// Security headers
app.disable("x-powered-by");
app.use(helmet());

// Only configure this if your deployment has a trusted reverse proxy.
// Set the correct proxy configuration for your hosting provider.
// Example for exactly one trusted proxy hop:
// app.set("trust proxy", 1);

// CORS
app.use(
  cors({
    origin(origin, callback) {
      // Requests from native mobile apps and server-to-server clients
      // may not include an Origin header.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/$/, "");

      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      // Permit local development origins only outside production.
      if (!isProduction) {
        const localOrigins = [
          "http://localhost:5173",
          "http://localhost:5174",
          "http://localhost:8081",
        ];

        if (localOrigins.includes(normalizedOrigin)) {
          return callback(null, true);
        }
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Request parsing limits
app.use(express.json({ limit: "2mb" }));
app.use(
  express.urlencoded({
    extended: true,
    limit: "100kb",
    parameterLimit: 1000,
  })
);

// Request logging
app.use(morgan(isProduction ? "combined" : "dev"));

// General API rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

app.use(generalLimiter);

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "kabad-factory-api",
  });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/serviceability", serviceabilityRoutes);
app.use("/api/cms", cmsRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/executive", executiveRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);

// Handle unknown routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

// Centralized error handler must remain last.
app.use(errorHandler);

export default app;
