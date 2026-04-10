# BountyEscrow AI

Algorand-native bounty escrow platform with validation-gated payouts.

## Product Summary

BountyEscrow AI enforces a deterministic payout flow:

1. Client posts bounty and locks funds in Algorand escrow.
2. Freelancer accepts terms and submits work evidence (GitHub-centric workflow).
3. CI/CD webhook signals and GROQ scoring compute validation decisions.
4. Escrow is released only when validation and compliance checks pass.
5. Disputed bounties remain locked for multi-signature arbitration.

## Required Stack

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS, Pera Wallet SDK
- Backend: Node.js, Express 4, TypeScript, Socket.io, Zod, JWT
- Blockchain: Algorand, PyTeal smart contracts, ARC-4, Algorand JS SDK
- Database: PostgreSQL (Neon)
- AI/ML: GROQ API hybrid scoring (AI + CI/CD + client rating)
- DevOps: GitHub Webhooks, GitHub Actions, Vercel
- Wallet auth: Pera Wallet, WalletConnect, AlgoSigner
- Orchestration: Inngest for background jobs with retries

## Non-Negotiable Guardrails

The platform must enforce these rules in all environments:

1. Never release escrow without passing validation.
2. Never allow the same user to be both client and freelancer on the same bounty.
3. All payout wallets must pass sanctions checks before any payout.
4. All background jobs run through Inngest with retry logic.
5. All API inputs are validated with Zod before DB or blockchain execution.

## Current Repository Scope

This repository currently contains the Next.js frontend workspace and UI flow alignment.
Backend services, smart contracts, and worker orchestration are documented as required architecture and should be implemented in dedicated services.

### Frontend Alignment Implemented

- Product naming and copy updated to BountyEscrow AI.
- Dashboard route model aligned to bounty language (`/dashboard/bounties/...`).
- Escrow release UI guardrails wired via `lib/project-config.ts`.
- Payment release messaging now explains why escrow remains locked when rules fail.

## Key Frontend Paths

- `app/page.tsx`: marketing landing
- `app/dashboard/page.tsx`: bounty-centric overview
- `app/dashboard/bounties/page.tsx`: bounty list/creation entry
- `app/dashboard/bounties/[id]/page.tsx`: bounty detail and release decision UI
- `app/dashboard/chat/[projectId]/page.tsx`: real-time bounty conversation
- `lib/project-config.ts`: product constants + release guard helpers

## Environment Variables

Create `.env.local` for local frontend runtime:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

If omitted, frontend falls back to `http://localhost:4000/api`.

## Local Development

```bash
npm install
npm run dev
npm run api:dev
```

## Express Backend (TypeScript)

Backend source lives in `src/` with this structure:

- `src/middleware`: auth, validation, rate limit, sanctions, error handling
- `src/routes`: auth, bounties, users
- `src/services`: Algorand and wallet helpers
- `src/schemas`: Zod request schemas
- `src/types`: Express request context typing

Key API routes:

- `POST /api/auth/wallet-login`
- `POST /api/auth/refresh`
- `POST /api/auth/disconnect`
- `POST /api/bounties`
- `POST /api/bounties/:id/fund`
- `GET /api/bounties`
- `GET /api/bounties/:id`
- `PATCH /api/bounties/:id/extend-deadline`
- `DELETE /api/bounties/:id`
- `POST /api/bounties/:id/accept`
- `GET /api/users/me`

## CI

GitHub Actions workflow is included for lint, typecheck, and build validation on push and pull request.

## Neon PostgreSQL Schema

Complete database implementation has been added for BountyEscrow AI.

- Migration: `db/migrations/0001_bountyescrow_schema.sql`
- Seed data: `db/seeds/0001_seed.sql`
- Typed DB models: `lib/db/types.ts`
- Typed query layer: `lib/db/queries.ts`
- DB client + transactions: `lib/db/client.ts`
- DB to HTTP error mapping: `lib/db/errors.ts`, `lib/db/http.ts`

### Run Database Tasks

```bash
npm run db:migrate
npm run db:seed
npm run db:check
```

Required environment variable:

```bash
DATABASE_URL=postgresql://...
```

### Exception Handling Coverage

- DB-001: Row-level locking with `SELECT ... FOR UPDATE` in bounty acceptance flow.
- DB-002: Pool exhaustion mapped to HTTP 503 with `Retry-After`.
- DB-003: Migration transaction rollback on failure.
- DB-004: Consistency query for `escrow_locked = true` and missing contract address.
- DB-005: Soft-delete filtering (`deleted_at IS NULL`) in query layer.
- XC-001: Trigger blocks self-submission by bounty creator.

## Backend Architecture Checklist (Required)

When implementing backend services, keep these contracts:

1. Validate all request payloads with Zod before DB/blockchain logic.
2. Use JWT auth and role checks on all bounty/protected routes.
3. Enforce identity-separation rule before assignment and payout.
4. Execute sanctions checks before release transactions.
5. Trigger Inngest jobs for validation, payouts, retries, and notifications.
6. Use webhook-driven CI/CD status updates as scoring input.
7. Return safe error objects only, without leaking stack traces.
