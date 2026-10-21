import { Router } from "express";
import {
  createAddress,
  createAddressSchema,
  deleteAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
  updateAddressSchema
} from "../controllers/address.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("customer"));
router.get("/", asyncHandler(listAddresses));
router.post("/", validate(createAddressSchema), asyncHandler(createAddress));
router.patch("/:id", validate(updateAddressSchema), asyncHandler(updateAddress));
router.delete("/:id", asyncHandler(deleteAddress));
router.patch("/:id/default", asyncHandler(setDefaultAddress));

export default router;
