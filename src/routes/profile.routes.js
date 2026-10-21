import { Router } from "express";
import {
  createSupportQuery,
  createSupportQuerySchema,
  getMySupportQuery,
  getProfile,
  listMySupportQueries,
  requestEmailOtp,
  requestEmailOtpSchema,
  resendEmailOtp,
  updateProfile,
  updateProfileSchema,
  verifyEmailOtpSchema,
  verifyProfileEmailOtp
} from "../controllers/profile.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("customer", "executive"));
router.get("/", asyncHandler(getProfile));
router.patch("/", validate(updateProfileSchema), asyncHandler(updateProfile));
router.post("/email/request-otp", validate(requestEmailOtpSchema), asyncHandler(requestEmailOtp));
router.post("/email/resend-otp", validate(requestEmailOtpSchema), asyncHandler(resendEmailOtp));
router.post("/email/verify-otp", validate(verifyEmailOtpSchema), asyncHandler(verifyProfileEmailOtp));
router.post("/support-queries", validate(createSupportQuerySchema), asyncHandler(createSupportQuery));
router.get("/support-queries", asyncHandler(listMySupportQueries));
router.get("/support-queries/:id", asyncHandler(getMySupportQuery));

export default router;
