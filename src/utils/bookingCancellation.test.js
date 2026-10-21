import test from "node:test";
import assert from "node:assert/strict";

import { assertBookingCanBeCancelled, getCancellationBlockReason } from "./bookingCancellation.js";

test("allows cancellation for an unassigned confirmed pickup", () => {
  assert.equal(getCancellationBlockReason({ id: 1, status: "confirmed", executiveId: null }), null);
  assert.doesNotThrow(() => assertBookingCanBeCancelled({ id: 1, status: "confirmed", executiveId: null }));
});

test("blocks cancellation after an executive is assigned", () => {
  const reason = getCancellationBlockReason({ id: 1, status: "executive_assigned", executiveId: 22 });
  assert.equal(reason.statusCode, 409);
  assert.match(reason.message, /executive has already been assigned/i);
});

test("blocks completed and collected pickups", () => {
  for (const status of ["scrap_collected", "payment_completed", "completed"]) {
    const reason = getCancellationBlockReason({ id: 1, status, executiveId: null });
    assert.equal(reason.statusCode, 400);
  }
});

test("blocks double cancellation", () => {
  const reason = getCancellationBlockReason({ id: 1, status: "cancelled", executiveId: null });
  assert.equal(reason.statusCode, 400);
  assert.match(reason.message, /already cancelled/i);
});
