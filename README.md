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

## What works today: agent mandates (sandbox)

A user can give an AI agent **scoped, revocable, auditable authority to spend
from their balance**, exercised end to end on Nigerian airtime through a
fault-injecting provider simulator. Sandbox only, behind
`METER_AGENTS_SANDBOX=true`; the Stage 2 gate is unchanged. Design:
[agent mandates](docs/superpowers/2026-09-24-meter-agent-mandates-design.md).
Demo recording: not recorded yet.

```text
Agent (LLM via MCP)
   │ POST /v1/agent/purchases  (Idempotency-Key)
   ▼
┌──────────────────── TX1  SERIALIZABLE ────────────────────┐
│ claim key · lock credential, mandate · 13 ordered checks   │
│ ledger reserve (available → reserved) · decision · purchase│
└────────────────────────────────────────────────────────────┘
   │ 202 { purchase_id, status: processing }
   ▼
Finalizer worker (claims with SKIP LOCKED)
   ├─ TX2: pending_dispatch → dispatching (write-ahead, commit)
   ├─ provider.send(request_id = purchase_id)   ← no transaction open
   └─ TX3: delivered → capture · rejected → release · not_sent → retry
           unknown → hold, requery … deadline → unresolved (operator)
```

A network call never happens inside a database transaction, and no money moves
on a guess: an ambiguous provider answer holds the funds until a requery or an
operator with evidence settles it.

Run the demo locally (Postgres up, `METER_AGENTS_SANDBOX=true` in `.env`):

```bash
pnpm --filter @meter/server build
pnpm --filter @meter/server start          # API on $PORT
pnpm --filter @meter/server start:worker   # finalizer + hold sweeper
pnpm demo:setup                            # ₦10,000 credit, demo mandate, prints an mtr_agt_ token once
pnpm demo:timeline <purchase_id>           # decision → ledger → provider → capture
METER_AGENT_CREDENTIAL=mtr_agt_… pnpm demo:concurrency 20
```

`demo:setup` exists because owner routes need a Clerk session; with one, use
`POST /v1/sandbox/credit`, `POST /v1/mandates` and
`POST /v1/mandates/:id/credentials` instead. Simulated outcomes are chosen by the
destination's last four digits: `0000` delivered, `0001` rejected, `0002`/`0003`
unknown then delivered/rejected, `0004` not found then delivered, `0005` pending
until `unresolved`, `0006` connection refused twice, `0007` hangs 20 s so the
worker can be killed mid-send.

Register the MCP server in Claude Desktop's config:

```json
{
  "mcpServers": {
    "meter": {
      "command": "node",
      "args": ["/absolute/path/to/meter/apps/mcp/src/index.ts"],
      "env": { "METER_API_URL": "http://localhost:3001", "METER_AGENT_CREDENTIAL": "mtr_agt_…" }
    }
  }
}
```

Tools: `get_spending_power`, `buy_airtime`, `get_purchase`, `list_purchases`.
The MCP process holds one agent credential and calls only the public agent API:
it has no database access and no route to owner or operator endpoints.

## Core and verticals

Meter Core (PRD §5) owns identity, funding, the ledger, catalog and price versions,
authorization and budgets, usage verification, settlement, reconciliation, risk and
support. It is product-agnostic. A vertical supplies the unit being metered and the
evidence that it was delivered — it does not get its own states, its own money path,
or its own definition of "captured".

| Stage | Product | Meters | Status |
| --- | --- | --- | --- |
| 1 | Meter AI | tokens, tasks, documents | building |
| 2 | Meter Agents | scoped programmatic spend, x402 | authority primitives in sandbox; production gated on Stage 1 exit |
| 3 | Meter Providers | third-party billable units | gated on Stage 2 exit |
| 4 | Meter Content | articles, unlocks, entitlements | gated on Stage 3 exit |
| 5 | Meter Sessions | minutes | gated on Stage 3 exit |
| 6 | Meter Physical | kWh, litres, cycles | gated on partner + regulator |

`modules/products/ai` and a sandbox-only `modules/products/agents` exist. The rest
are directories nobody has written yet on purpose — each is gated behind a
measured exit gate in PRD §9.

## Layout

| Path | Contents |
| --- | --- |
| `apps/server/src/modules/core` | Meter Core. Product-agnostic. |
| `apps/server/src/modules/products` | Verticals. One per stage, as they are gated in. |
| `apps/server/src/adapters` | External providers behind Meter-owned interfaces. |
| `apps/server/src/platform` | Database, jobs, telemetry, security. |
| `apps/web` | Static Next.js PWA. No financial logic, no direct database access. |
| `apps/mcp` | Stdio MCP server for agents. A pure HTTP client of the agent API. |
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

Copy `.env.example` to `.env` before `pnpm dev`. The dev and migrate scripts
read it with Node's own `--env-file-if-exists`, so no dotenv dependency is
involved and a missing file is not an error. Turbo runs tasks in strict env
mode, so any variable the app reads must also be listed in `globalPassThroughEnv`
in `turbo.json` — otherwise it is silently stripped before the task sees it.

`pnpm db:up` binds 5432. If something already holds it, set `METER_PG_PORT=5433`
and use that port in `DATABASE_URL`.

## Clerk

The server needs environment values only — `@clerk/backend` is already a
dependency and no frontend scaffolding is involved. From the Clerk dashboard:

| Variable | Dashboard location | Required |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | API keys -> Secret key (`sk_...`) | Yes, enforced in production |
| `CLERK_JWT_KEY` | API keys -> JWT public key (PEM) | No; set it to verify tokens without a JWKS fetch |
| `CLERK_WEBHOOK_SECRET` | Webhooks -> endpoint -> Signing secret (`whsec_...`) | Yes, to provision users |

Put them in `.env`, never in a committed file.

Clerk owns authentication; Meter owns identity. A Clerk subject is never a
financial key. `POST /v1/webhooks/clerk` maps a subject to an internal UUIDv7
user, and until that row exists the guard denies with `IDENTITY_NOT_FOUND`. In
the dashboard, point a webhook endpoint at `<public-url>/v1/webhooks/clerk` and
subscribe to `user.created`, `user.updated` and `user.deleted`. The route is
signature-verified, replay-protected, and rejects an event ID reused with
different bytes. `user.deleted` suspends the user rather than removing the row,
because ledger accounts reference it.

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

Agent mandates add seven more (design §12.1): I9 mandate exposure never
exceeds a limit under concurrency; I10 a hold is captured or released exactly
once, never both (property test over interleaved finalizer, sweeper, revocation
and operator actions); I11 an unknown provider outcome never moves money; I12 a
worker killed after write-ahead causes at most one send; I13 a declined request
writes no ledger row and reaches no provider; I14 a credential revoked before an
authorization commits cannot authorize; I15 pre-dispatch expiry and revocation
release exactly the held amount once.
