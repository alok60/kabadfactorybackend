import { Router } from "express";
import {
  adminLoginSchema,
  createAdminCmsPage,
  createAdminFaq,
  createCategory,
  createExecutive,
  createNotification,
  createOffer,
  createUser,
  dashboard,
  deleteAdminFaq,
  executiveReports,
  getAdminMe,
  listAdminCmsPages,
  listAdminFaqs,
  loginAdmin,
  listCategories,
  listExecutiveOptions,
  listExecutives,
  listNotifications,
  listOffers,
  listPayments,
  listPickupChargeSlabs,
  listPincodePickupChargeCache,
  listPickupRequests,
  listStoreLocations,
  listSupportQueries,
  listUsers,
  updateCategory,
  updateAdminCmsPage,
  updateAdminFaq,
  updateExecutive,
  updateNotification,
  updateOffer,
  updatePickupChargeSlab,
  updatePickup,
  updateStoreLocation,
  updateSupportQuery,
  updateUser,
  createPickupChargeSlab,
  createStoreLocation,
  refreshPincodePickupCharge
} from "../controllers/admin.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { categoryIconUpload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/auth/login", validate(adminLoginSchema), asyncHandler(loginAdmin));

router.use(authenticate, authorize("admin"));
router.get("/auth/me", asyncHandler(getAdminMe));

router.get("/dashboard", asyncHandler(dashboard));

router.get("/users", asyncHandler(listUsers));
router.post("/users", asyncHandler(createUser));
router.patch("/users/:id", asyncHandler(updateUser));

router.get("/executives", asyncHandler(listExecutives));
router.get("/executive-options", asyncHandler(listExecutiveOptions));
router.get("/executive-reports", asyncHandler(executiveReports));
router.post("/executives", asyncHandler(createExecutive));
router.patch("/executives/:id", asyncHandler(updateExecutive));

router.get("/pickups", asyncHandler(listPickupRequests));
router.patch("/pickups/:id", asyncHandler(updatePickup));

router.get("/categories", asyncHandler(listCategories));
router.post("/categories", categoryIconUpload.single("iconFile"), asyncHandler(createCategory));
router.patch("/categories/:id", categoryIconUpload.single("iconFile"), asyncHandler(updateCategory));

router.get("/stores", asyncHandler(listStoreLocations));
router.post("/stores", asyncHandler(createStoreLocation));
router.patch("/stores/:id", asyncHandler(updateStoreLocation));

router.get("/pickup-charges", asyncHandler(listPickupChargeSlabs));
router.post("/pickup-charges", asyncHandler(createPickupChargeSlab));
router.patch("/pickup-charges/:id", asyncHandler(updatePickupChargeSlab));

router.get("/pincode-pickup-charge-cache", asyncHandler(listPincodePickupChargeCache));
router.post("/pincode-pickup-charge-cache/:pincode/refresh", asyncHandler(refreshPincodePickupCharge));

router.get("/offers", asyncHandler(listOffers));
router.post("/offers", asyncHandler(createOffer));
router.patch("/offers/:id", asyncHandler(updateOffer));

router.get("/notifications", asyncHandler(listNotifications));
router.post("/notifications", asyncHandler(createNotification));
router.patch("/notifications/:id", asyncHandler(updateNotification));

router.get("/payments", asyncHandler(listPayments));

router.get("/support", asyncHandler(listSupportQueries));
router.patch("/support/:id", asyncHandler(updateSupportQuery));

router.get("/faqs", asyncHandler(listAdminFaqs));
router.post("/faqs", asyncHandler(createAdminFaq));
router.patch("/faqs/:id", asyncHandler(updateAdminFaq));
router.delete("/faqs/:id", asyncHandler(deleteAdminFaq));

router.get("/cms/:type", asyncHandler(listAdminCmsPages));
router.post("/cms/:type", asyncHandler(createAdminCmsPage));
router.patch("/cms/:type/:id", asyncHandler(updateAdminCmsPage));

export default router;
