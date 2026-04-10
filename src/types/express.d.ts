import type { UserRole } from "../../lib/db/types";

declare global {
  namespace Express {
    interface AuthenticatedUserContext {
      userId: string;
      role: UserRole;
      walletAddress: string;
      sessionId: string;
    }

    interface Request {
      requestId: string;
      user?: AuthenticatedUserContext;
    }
  }
}

export {};
