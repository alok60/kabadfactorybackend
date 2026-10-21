export async function sendEmail({ to, subject, text }) {
  if (process.env.EMAIL_PROVIDER === "smtp") {
    console.warn("SMTP provider is not configured in this starter. Plug nodemailer or your email provider here.");
  }

  console.log(`[email:dev] to=${to} subject=${subject} body=${text}`);
  return { delivered: process.env.EMAIL_PROVIDER !== "mock" };
}
