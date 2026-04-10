import {
  AuthError,
  ConflictError,
  DatabaseError,
  ForbiddenError,
  NotFoundError,
  globalErrorHandler,
  notFoundHandler,
  registerProcessErrorHandlers,
} from "./globalErrorHandler";

export class AppError extends Error {
  status: number;
  code: number;
  detail: string;
  headers?: Record<string, string>;

  constructor(status: number, code: number, detail: string, message?: string) {
    super(message ?? detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const errorHandler = globalErrorHandler;

export {
  AuthError,
  ConflictError,
  DatabaseError,
  ForbiddenError,
  NotFoundError,
  notFoundHandler,
  registerProcessErrorHandlers,
};
