export function errorHandler(error, _req, res, _next) {
  const isDatabaseError = error.code?.startsWith?.("ER_") || error.sqlMessage || error.sql;
  const isUploadSizeError = error.code === "LIMIT_FILE_SIZE";
  const isUploadValidationError = error.message?.startsWith?.("Unsupported category icon format");
  const statusCode = error.statusCode || (isDatabaseError ? 500 : isUploadSizeError || isUploadValidationError ? 400 : 500);
  const payload = {
    message: isDatabaseError
      ? "Something went wrong. Please try again."
      : isUploadSizeError
        ? "Category icon must be 2 MB or smaller."
        : error.message || "Something went wrong"
  };

  if (isDatabaseError) {
    console.error("Database error", error);
  }

  if (error.details && !isDatabaseError) {
    payload.details = error.details;
  }

  if (process.env.NODE_ENV !== "production") {
    payload.stack = error.stack;
  }

  res.status(statusCode).json(payload);
}
