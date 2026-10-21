import { Router } from "express";
import { login, loginSchema, me, register, registerSchema } from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/login", validate(loginSchema), asyncHandler(login));
router.post("/register", validate(registerSchema), asyncHandler(register));
router.get("/me", authenticate, asyncHandler(me));

export default router;
