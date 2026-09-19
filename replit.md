# TRACE Digital Content Forensics

TRACE investigates the origin and modification history of digital images and text using transparent, deterministic evidence instead of fabricated AI-detection certainty.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/trace/src/` — React/Vite application, routes, report views, and visual system
- `artifacts/api-server/src/routes/analyses.ts` — analysis and history API
- `artifacts/api-server/src/services/forensics.ts` — deterministic image and text inspection
- `lib/api-spec/openapi.yaml` — source of truth for API contracts
- `lib/db/src/schema/index.ts` — PostgreSQL schema for analyses, evidence, detector results, and reports

## Architecture decisions

- Evidence is stored separately from the final interpretation so individual findings remain inspectable.
- Confidence is nullable and the MVP returns `inconclusive` when no reliable model is configured.
- Uploaded images are processed in memory; only hashes, metadata, evidence, and reports are retained.
- Image upload uses a bounded base64 JSON contract to keep the shared TypeScript client/server toolchain portable.

## Product

- Analyze images for file metadata, dimensions, hashes, metadata markers, byte entropy, provenance availability, and editing-software markers.
- Analyze pasted text for transparent stylometric statistics.
- Review evidence-led reports and browse/delete analysis history.

## User preferences

- Keep advanced AI detection explicitly marked as unavailable until a real open model is configured.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`.
- Use the managed API and TRACE workflows rather than starting root-level dev commands.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
