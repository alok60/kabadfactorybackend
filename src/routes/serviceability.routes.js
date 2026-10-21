import { Router } from "express";
import { checkPincodeServiceability } from "../controllers/serviceability.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/pincode", asyncHandler(checkPincodeServiceability));

export default router;
