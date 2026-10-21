import { Router } from "express";
import {
  cancelBooking,
  cancelBookingSchema,
  createBooking,
  createBookingSchema,
  downloadBookingBill,
  getBooking,
  listBookingsSchema,
  listMyBookings
} from "../controllers/booking.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("customer"));
router.get("/", validate(listBookingsSchema), asyncHandler(listMyBookings));
router.get("/:id", asyncHandler(getBooking));
router.get("/:id/bill", asyncHandler(downloadBookingBill));
router.post("/", validate(createBookingSchema), asyncHandler(createBooking));
router.post("/:id/cancel", validate(cancelBookingSchema), asyncHandler(cancelBooking));

export default router;
