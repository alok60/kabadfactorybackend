import Razorpay from "razorpay";
import { z } from "zod";

export const createPaymentOrderSchema = z.object({
  body: z.object({
    amount: z.number().positive(),
    bookingId: z.number().int()
  })
});

export async function createPaymentOrder(req, res) {
  const { amount, bookingId } = req.validated.body;
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  const order = await razorpay.orders.create({
    amount: Math.round(amount * 100),
    currency: "INR",
    receipt: `booking_${bookingId}`
  });

  res.json({ order });
}
