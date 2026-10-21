import { HttpError } from "./httpError.js";

const blockedAfterCollectionStatuses = new Set(["scrap_collected", "payment_completed", "completed"]);

export function getCancellationBlockReason(booking) {
  if (!booking) return { statusCode: 404, message: "Order not found." };

  const status = String(booking.status || "").toLowerCase();
  const executiveId = booking.executiveId ?? booking.executive_id ?? booking.currentExecutiveId ?? null;

  if (status === "cancelled") {
    return { statusCode: 400, message: "Pickup is already cancelled." };
  }

  if (blockedAfterCollectionStatuses.has(status)) {
    return { statusCode: 400, message: "Pickup can't be cancelled after collection has started." };
  }

  if (executiveId) {
    return { statusCode: 409, message: "Pickup can't be cancelled because an executive has already been assigned." };
  }

  return null;
}

export function assertBookingCanBeCancelled(booking) {
  const blockReason = getCancellationBlockReason(booking);
  if (blockReason) throw new HttpError(blockReason.statusCode, blockReason.message);
}
