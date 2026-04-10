import type { NextFunction, Request, Response } from "express";
import type { ZodError, ZodObject, ZodTypeAny } from "zod";

function formatZodError(error: ZodError) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "root";
    if (!fieldErrors[key]) {
      fieldErrors[key] = [];
    }
    fieldErrors[key].push(issue.message);
  }
  return fieldErrors;
}

function zodBadRequest(response: Response, error: ZodError) {
  return response.status(400).json({
    error: "Validation failed",
    code: 400,
    detail: "API-001: Request validation failed",
    issues: {
      fieldErrors: formatZodError(error),
    },
  });
}

export function validateBody<T extends ZodTypeAny>(schema: T) {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return zodBadRequest(response, parsed.error);
    }
    request.body = parsed.data;
    return next();
  };
}

export function validateQuery<T extends ZodObject>(schema: T) {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return zodBadRequest(response, parsed.error);
    }
    request.query = parsed.data as Request["query"];
    return next();
  };
}

export function validateParams<T extends ZodObject>(schema: T) {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) {
      return zodBadRequest(response, parsed.error);
    }
    request.params = parsed.data as Request["params"];
    return next();
  };
}
