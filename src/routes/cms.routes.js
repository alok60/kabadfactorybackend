import { Router } from "express";
import { getActiveCmsPage, listActiveFaqs } from "../controllers/cms.controller.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/faqs", asyncHandler(listActiveFaqs));
router.get("/:type", asyncHandler(getActiveCmsPage));

export default router;
