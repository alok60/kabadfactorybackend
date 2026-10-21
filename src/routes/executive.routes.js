import { Router } from "express";
import { collectScrap, collectScrapSchema, getAssignedPickup, listAssignedPickups, updatePickupSchema, updatePickupStatus } from "../controllers/executive.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("executive", "admin"));
router.get("/pickups", asyncHandler(listAssignedPickups));
router.get("/pickups/:id", asyncHandler(getAssignedPickup));
router.post("/pickups/:id/collect", validate(collectScrapSchema), asyncHandler(collectScrap));
router.patch("/pickups/:id/status", validate(updatePickupSchema), asyncHandler(updatePickupStatus));

export default router;
