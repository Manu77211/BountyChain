# BountyEscrow AI Backend Architecture

This document defines the required backend implementation contracts for the BountyEscrow AI platform.

## Runtime Stack

- Node.js + Express 4 + TypeScript
- Socket.io for real-time updates
- Zod for all input validation
- JWT for authentication and role-based authorization
- PostgreSQL (Neon)
- Inngest for orchestration, retries, and background execution
- Algorand + ARC-4 smart contracts for escrow and payout control
- GROQ API for AI scoring

## Required Service Boundaries

- `routes/*`: HTTP routing and auth guards only
- `schemas/*`: Zod request/response schemas
- `services/*`: business logic and policy checks
- `repositories/*`: database access only
- `integrations/*`: Algorand, GitHub webhooks, GROQ, sanctions provider, Inngest
- `sockets/*`: room membership, bounty updates, validation state events

## Core Policy Enforcement

Every payout decision must satisfy all conditions:

1. Validation decision is approved.
2. Client and freelancer are distinct users for the bounty.
3. Sanctions checks pass for source and destination wallets.
4. Dispute state is not active.

Any failed condition keeps escrow locked.

## Suggested Scoring Contract

```ts
export type ValidationDecision = "APPROVED" | "REJECTED" | "REVIEW";

export interface ValidationScore {
  aiScore: number; // GROQ output [0..100]
  ciScore: number; // CI/CD signal [0..100]
  clientRating: number; // client rating [0..100]
  finalScore: number; // weighted
  decision: ValidationDecision;
}
```

Example weighted score:

- `finalScore = aiScore * 0.5 + ciScore * 0.3 + clientRating * 0.2`
- approved if `finalScore >= 75` and required checks pass.

## Inngest Orchestration Requirements

Background operations must run in Inngest with retries:

- CI webhook ingestion and normalization
- GROQ scoring
- sanctions checks
- escrow release transaction submission
- arbitration notifications and reminders
- settlement event fan-out to Socket.io

## API Error Contract

All API errors should return:

```json
{
  "error": "string",
  "code": 400,
  "detail": "string"
}
```

Never expose stack traces to clients.

## Security Notes

- Validate all payloads with Zod before touching DB or blockchain.
- Use parameterized SQL/ORM only.
- Keep secrets in environment variables.
- Verify JWT on every protected route.
- Log policy failures for auditability.
