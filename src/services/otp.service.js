const mockOtpStore = new Map();

export async function sendOtp(mobile) {
  const otp = process.env.NODE_ENV === "production" ? generateOtp() : "123456";
  mockOtpStore.set(mobile, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });

  return {
    mobile,
    message: process.env.NODE_ENV === "production" ? "OTP sent" : "Mock OTP is 123456"
  };
}

export async function verifyOtp(mobile, otp) {
  const record = mockOtpStore.get(mobile);
  return Boolean(record && record.otp === otp && record.expiresAt > Date.now());
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
