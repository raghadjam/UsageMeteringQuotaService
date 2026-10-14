import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors";

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, "invalid_request", "Request body is invalid"));
      return;
    }

    req.body = result.data;
    next();
  };
}