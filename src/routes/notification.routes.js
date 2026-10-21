import { Router } from "express";
import {
  clearNotifications,
  listNotifications,
  listNotificationsSchema,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount
} from "../controllers/notification.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("customer", "executive", "admin"));
router.get("/", validate(listNotificationsSchema), asyncHandler(listNotifications));
router.get("/unread-count", asyncHandler(unreadNotificationCount));
router.post("/read-all", asyncHandler(markAllNotificationsRead));
router.post("/clear", asyncHandler(clearNotifications));
router.post("/:id/read", asyncHandler(markNotificationRead));

export default router;
