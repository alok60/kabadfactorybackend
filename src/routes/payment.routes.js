import { Router } from "express";
import { createPaymentOrder, createPaymentOrderSchema } from "../controllers/payment.controller.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/razorpay/order", authenticate, validate(createPaymentOrderSchema), asyncHandler(createPaymentOrder));

export default router;
