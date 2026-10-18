import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    if (error.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", error.retryAfterSeconds);
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error && typeof error === "object" && "type" in error) {
    if (error.type === "entity.parse.failed") {
      res.status(400).json({
        error: { code: "invalid_json", message: "Request body must be valid JSON" },
      });
      return;
    }
    if (error.type === "entity.too.large") {
      res.status(413).json({
        error: { code: "request_too_large", message: "Request body is too large" },
      });
      return;
    }
  }

  console.error("Unhandled request error", error);
  res.status(500).json({
    error: { code: "internal_error", message: "An unexpected error occurred" },
  });
};