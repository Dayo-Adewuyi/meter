# Meter

Meter Core is a metered-payments platform: quote, authorize, reserve, meter, capture,
settle, reconcile — once, for every vertical that sells a measurable unit.
Meter AI is the first product on it, not the product.

Docs: [master PRD](docs/superpowers/specs/2026-09-20-meter-master-platform-prd.md) ·
[technology architecture](docs/superpowers/specs/2026-09-20-meter-technology-architecture-design.md) ·
[implementation plan](docs/superpowers/specs/2026-09-20-meter-implementation-plan.md) ·
[ticket breakdown](docs/superpowers/specs/2026-09-20-meter-ticket-breakdown.md)

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up && pnpm db:migrate
pnpm dev
```

## Core and verticals

Meter Core (PRD §5) owns identity, funding, the ledger, catalog and price versions,
authorization and budgets, usage verification, settlement, reconciliation, risk and
support. It is product-agnostic. A vertical supplies the unit being metered and the
evidence that it was delivered — it does not get its own states, its own money path,
or its own definition of "captured".

| Stage | Product | Meters | Status |
| --- | --- | --- | --- |
| 1 | Meter AI | tokens, tasks, documents | building |
| 2 | Meter Agents | scoped programmatic spend, x402 | gated on Stage 1 exit |
| 3 | Meter Providers | third-party billable units | gated on Stage 2 exit |
| 4 | Meter Content | articles, unlocks, entitlements | gated on Stage 3 exit |
| 5 | Meter Sessions | minutes | gated on Stage 3 exit |
| 6 | Meter Physical | kWh, litres, cycles | gated on partner + regulator |

Only `modules/products/ai` exists. The other five are directories nobody has written
yet on purpose — each is gated behind a measured exit gate in PRD §9.

## Layout

| Path | Contents |
| --- | --- |
| `apps/server/src/modules/core` | Meter Core. Product-agnostic. |
| `apps/server/src/modules/products` | Verticals. One per stage, as they are gated in. |
| `apps/server/src/adapters` | External providers behind Meter-owned interfaces. |
| `apps/server/src/platform` | Database, jobs, telemetry, security. |
| `apps/web` | Static Next.js PWA. No financial logic, no direct database access. |
| `packages/contracts` | Browser-safe schemas, incl. the canonical transaction model. |
| `packages/config` | Typed environment, validated at boot. |
| `database/migrations` | Reviewed SQL, applied in filename order. |
| `infra` | Render, Cloudflare, monitoring. |

## Rules that are not negotiable

- Money is `bigint` atomic units in the server and a decimal string on the wire. `number` is never money.
- Only the ledger module writes `ledger.*`. Posted entries are append-only.
- Financial commands carry an idempotency key and run `SERIALIZABLE`.
- No external network call happens inside a database transaction.
- Cross-module access goes through application interfaces or committed outbox events.
- A vertical depends on core. Core never depends on a vertical.

## Dependency policy

Installs execute no lifecycle scripts, resolve nothing published in the last
7 days, and fail on a lockfile that does not match the manifests. Adding a
dependency that needs a build script means reading that script and adding the
package to `onlyBuiltDependencies` in `pnpm-workspace.yaml` in its own commit.

## Deviations from the design doc

| Doc | Here | Why |
| --- | --- | --- |
| Arch §7 flat `modules/`, incl. `ai` | `modules/core` + `modules/products` | PRD §5 separates Meter Core from verticals. Flat, `ai` reads as core. |
| Arch §11.1 schema `authorization` | `authz` | Reserved word in PostgreSQL; the doc's name needs double quotes in every query. |
| Arch §7 `packages/ui` | empty | One consumer so far. Add it when a second appears. |
| Nest CLI for build | `tsc` | TypeScript 7 ships `tsc` only; the CLI needs the programmatic API (back in 7.1). |

`pnpm db:up` binds 5432. If something already holds it, set `METER_PG_PORT=5433`
and use that port in `DATABASE_URL`.

## Financial invariant suite

Every change that touches money must pass the mandatory financial suite before
merge. It runs against a real PostgreSQL 18 and is a separate required CI job
(`financial`), never folded into the generic test step.

```bash
pnpm db:up
DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm db:migrate
DATABASE_URL=postgres://meter:meter@localhost:5432/meter pnpm test:financial
```

The suite covers eight named invariants: journals balance by asset, posted
entries cannot be edited or deleted, available balance cannot go negative,
concurrent authorizations cannot overspend, capture cannot exceed its
reservation, capture plus release equals the original reservation, recognized
retries cannot create value, and a projection rebuild reproduces the recorded
balances.
