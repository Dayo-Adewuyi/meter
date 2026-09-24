# Meter Agent Mandates Design

**Status:** Draft for founder approval

**Date:** 2026-09-24

**Owner:** Founder / CTO

**Related:** [`master PRD`](2026-09-20-meter-master-platform-prd.md) §8.5, §9.3, §10.3 · [`technology architecture`](2026-09-20-meter-technology-architecture-design.md) §9.3, §10.4, §10.5, §12, §14.3, §15.2 · [`ticket breakdown`](2026-09-20-meter-ticket-breakdown.md) W4, AG-2, AG-3, AG-5 · [`first-ten design`](2026-09-20-meter-first-ten-ledger-prerequisites-design.md)

## 1. Purpose and scope

This design lets a Meter user give an AI agent **scoped, revocable, auditable
authority to spend from their balance**, and exercises that authority end to
end against a real class of purchase: Nigerian airtime top-ups through a
value-added-services (VAS) provider.

It is the smallest slice of Stage 2 (Meter Agents) that proves the three things
an agent-payments platform must get right:

1. **Authority.** An agent can only spend within limits its owner set, and those
   limits hold under concurrency, retries, and revocation.
2. **Delivery truth.** Money is captured only when the provider confirms value
   was delivered, released only when the provider confirms it was not, and held
   — never guessed — when the outcome is unknown.
3. **Accountability.** Every purchase has a complete timeline: which agent, what
   it bought, why it said it was buying it, which policy checks ran, and which
   journals moved value.

### 1.1 In scope

- Mandates: owner-defined spending authority with per-transaction, daily,
  lifetime, velocity, concurrency, category, and destination limits.
- Agent credentials: hashed, scoped, expiring, revocable machine credentials
  bound to one mandate.
- An ordered, deny-by-default policy evaluator whose decision and funds
  reservation commit in one `SERIALIZABLE` transaction.
- A purchase lifecycle for airtime with an explicit **outcome-unknown** path,
  provider requery, crash recovery, and pre-dispatch hold expiry.
- A `VasProvider` port with a deterministic fault-injecting simulator and an
  optional VTpass sandbox adapter.
- REST endpoints for owners and agents, and an MCP server so a real LLM can use
  a mandate.
- Financial invariants I9–I15, added to the mandatory `test:financial` suite.

### 1.2 Out of scope

Organizations and workspaces (AG-1), organization-owned balances (AG-6),
x402 (AG-7), outbound developer webhooks (AG-8), provider settlement and payouts,
data bundles and other VAS categories, real-money funding, and a web
administration UI. Human approval above threshold (AG-5) is a stretch goal
(§12.3).

### 1.3 Deviations from the staged plan

| Plan | Here | Why |
| --- | --- | --- |
| PRD §9.3: Stage 2 gated on Stage 1 exit | Stage 2 authority primitives built now, **sandbox-only** behind `METER_AGENTS_SANDBOX=true` | Authorization (AUTH-01…07) is core, not vertical; building it against a simple fixed-price purchase de-risks Meter AI's authorization path. No production money path is opened; the stage gate is unchanged. |
| Tickets assume organization-owned credentials (AG-1, AG-6) | Mandates are owned by an individual user and spend from that user's `customer_available` account | Organizations are unbuilt. The mandate owner is modelled as an `owner_id` so it can later point at an organization without changing policy evaluation. |
| Arch §12.1: downstream work via outbox → pg-boss | Purchase finalization is driven by a durable state table claimed with `FOR UPDATE SKIP LOCKED` | W7-01 (outbox dispatcher) is unbuilt. The purchase row is the durable intent and is written in the same transaction as the reservation, which gives the same guarantee the outbox exists to provide. Migrate to outbox dispatch when W7 lands (§11.2). |
| PRD §9 lists no VAS vertical | Airtime is a sandbox demonstration target inside `products/agents` | It is the simplest real fixed-price, externally delivered unit with a genuinely ambiguous failure mode. It does not add a stage. |

## 2. Architecture

### 2.1 Module boundaries

```text
apps/server/src/
├── modules/core/authorization/       NEW  mandates, credentials, policy, authorizations
├── modules/core/ledger/              EDIT transaction-scoped command variants (§4)
└── modules/products/agents/          NEW  purchases, dispatch, finalization, HTTP API
apps/server/src/adapters/vas/         NEW  VasProvider port: simulator, vtpass
apps/mcp/                             NEW  stdio MCP server; HTTP client of the agent API
```

- `core/authorization` is product-agnostic. It knows about mandates, limits,
  holds, and decisions. It does not know what airtime is.
- `products/agents` owns the purchase lifecycle and delivery status. It depends
  on core; core never depends on it.
- The ledger remains the only writer to `ledger.*`.
- `apps/mcp` has **no database access and no ledger knowledge**. It holds one
  agent credential and calls the public agent API. An LLM can never reach a code
  path that the HTTP API would not also enforce.
- No VAS provider type leaves `adapters/vas`.

### 2.2 End-to-end flow

```text
Agent (LLM via MCP)
   │ POST /v1/agent/purchases  (Idempotency-Key)
   ▼
┌──────────────────── TX1  SERIALIZABLE ────────────────────┐
│ 1. claim purchase idempotency key                          │
│ 2. lock credential, mandate (FOR UPDATE)                   │
│ 3. evaluate policy (§6) → decision row                     │
│ 4. ledger.reserveInTransaction  available → reserved       │
│ 5. insert authz.authorizations (state=authorized)          │
│ 6. insert agents.purchases (delivery=pending_dispatch)     │
└────────────────────────────────────────────────────────────┘
   │ 202 Accepted { purchase_id, status: processing }
   ▼
Finalizer worker (claims with SKIP LOCKED)
   │
   ├─ TX2: pending_dispatch → dispatching (write-ahead, commit)
   │
   ├─ provider.send(request_id = purchase_id)      ← no DB transaction open
   │
   └─ TX3 by outcome:
        Delivered  → ledger.captureInTransaction → provider_payable
        Rejected   → ledger.releaseInTransaction → available
        NotSent    → back to pending_dispatch (bounded)
        Unknown    → awaiting_confirmation, schedule requery
                         │
                         └─ provider.requery(purchase_id) … until Delivered,
                            Rejected, or deadline → unresolved (held, review)
```

The rule this flow exists to enforce: **a network call never happens inside a
database transaction, and no money moves on a guess.**

## 3. Data model

Money columns are `numeric(38,0)` atomic units (kobo for `NGN`). Both
migrations are additive. The ledger needs no schema change; its change is code
only (§4).

### 3.1 `0010_authz_mandates.sql`

```sql
create table authz.mandates (
  id                     uuid primary key default uuidv7(),
  owner_id               uuid not null references identity.users (id),
  name                   text not null check (length(name) between 1 and 80),
  asset_code             text not null,
  available_account_id   uuid not null references ledger.accounts (id),
  reserved_account_id    uuid not null references ledger.accounts (id),
  status                 text not null default 'active'
                           check (status in ('active', 'revoked')),
  per_transaction_limit  numeric(38,0) not null check (per_transaction_limit > 0),
  daily_limit            numeric(38,0) not null check (daily_limit > 0),
  lifetime_limit         numeric(38,0) not null check (lifetime_limit > 0),
  velocity_max_count     int not null check (velocity_max_count > 0),
  velocity_window_secs   int not null check (velocity_window_secs > 0),
  max_in_flight          int not null default 3 check (max_in_flight > 0),
  duplicate_window_secs  int not null default 120 check (duplicate_window_secs >= 0),
  allowed_categories     text[] not null check (cardinality(allowed_categories) > 0),
  allowed_destinations   text[],            -- null = any destination in category
  expires_at             timestamptz not null,
  revoked_at             timestamptz,
  revoked_reason         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (per_transaction_limit <= daily_limit),
  check (daily_limit <= lifetime_limit),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table authz.agent_credentials (
  id            uuid primary key default uuidv7(),
  mandate_id    uuid not null references authz.mandates (id),
  public_id     text not null unique,          -- the non-secret half of the token
  secret_hash   bytea not null,                -- HMAC-SHA256(pepper, secret)
  label         text not null,
  scopes        text[] not null,               -- e.g. {purchases:create, purchases:read}
  status        text not null default 'active' check (status in ('active', 'revoked')),
  expires_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table authz.authorizations (
  id                 uuid primary key default uuidv7(),
  mandate_id         uuid not null references authz.mandates (id),
  credential_id      uuid not null references authz.agent_credentials (id),
  reservation_id     uuid not null unique references ledger.reservations (id),
  asset_code         text not null,
  amount             numeric(38,0) not null check (amount > 0),
  captured_amount    numeric(38,0) not null default 0 check (captured_amount >= 0),
  state              text not null default 'authorized'
                       check (state in ('authorized', 'captured', 'released', 'expired')),
  hold_expires_at    timestamptz not null,
  correlation_id     uuid not null,
  created_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  check (captured_amount <= amount),
  check ((state = 'authorized') = (finalized_at is null))
);

create index authorizations_mandate_time_idx on authz.authorizations (mandate_id, created_at);
create index authorizations_open_idx on authz.authorizations (hold_expires_at)
  where state = 'authorized';

create table authz.decisions (
  id               uuid primary key default uuidv7(),
  mandate_id       uuid references authz.mandates (id),
  credential_id    uuid references authz.agent_credentials (id),
  outcome          text not null check (outcome in ('approved', 'declined')),
  reason_code      text,                       -- null when approved
  evaluated        jsonb not null,             -- ordered snapshot of every check run
  request_digest   text not null,
  authorization_id uuid references authz.authorizations (id),
  correlation_id   uuid not null,
  created_at       timestamptz not null default now(),
  check ((outcome = 'approved') = (authorization_id is not null)),
  check ((outcome = 'declined') = (reason_code is not null))
);
```

`authz.decisions` rows are append-only, enforced by the same trigger pattern as
`ledger.entries` (0008).

### 3.2 `0011_agents_purchases.sql`

```sql
create schema if not exists agents;

create table agents.purchases (
  id                     uuid primary key default uuidv7(),  -- also the provider request id
  credential_id          uuid not null references authz.agent_credentials (id),
  idempotency_key        text not null,
  request_digest         text not null,
  authorization_id       uuid unique references authz.authorizations (id),
  decision_id            uuid not null references authz.decisions (id),
  category               text not null check (category in ('airtime')),
  network                text not null check (network in ('mtn', 'airtel', 'glo', '9mobile')),
  destination            text not null,       -- normalized E.164, e.g. +2348030000000
  amount                 numeric(38,0) not null check (amount > 0),
  asset_code             text not null,
  intent                 text not null check (length(intent) between 1 and 280),
  canonical_state        text not null,        -- PRD §7.2 state, see §5.1
  delivery_status        text not null
    check (delivery_status in ('declined', 'pending_dispatch', 'dispatching',
      'awaiting_confirmation', 'unresolved', 'delivered', 'rejected', 'expired')),
  send_attempts          int not null default 0,
  requery_attempts       int not null default 0,
  next_action_at         timestamptz,
  lease_until            timestamptz,
  dispatch_started_at    timestamptz,
  resolve_deadline_at    timestamptz,
  provider_reference     text,
  last_provider_outcome  jsonb,                -- redacted, see §9.3
  correlation_id         uuid not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (credential_id, idempotency_key)
);

create index purchases_work_idx on agents.purchases (next_action_at)
  where delivery_status in ('pending_dispatch', 'dispatching', 'awaiting_confirmation');

create table agents.purchase_events (
  id            uuid primary key default uuidv7(),
  purchase_id   uuid not null references agents.purchases (id),
  from_status   text,
  to_status     text not null,
  actor         text not null,               -- 'agent:<credential>', 'worker', 'operator:<user>'
  reason        text not null,
  detail        jsonb not null default '{}',
  ledger_transaction_id uuid,
  created_at    timestamptz not null default now()
);
```

`agents.purchase_events` is append-only and is the source of the timeline
(§9.4). Every status change writes exactly one event in the same transaction as
the change. This satisfies PRD §7.2: every transition records actor, timestamp,
reason, source, and ledger reference.

## 4. Ledger change: transaction-scoped commands (L-01)

Today `reserve`, `capture`, and `release` each open their own `SERIALIZABLE`
transaction. Policy evaluation and the reservation must commit atomically, and
authorization state must change in the same transaction as the ledger movement
it describes. Otherwise a crash between two commits leaves exposure accounting
disagreeing with the ledger.

Extract the body of each command into an exported function that accepts an
open transaction:

```ts
// reservation.service.ts
async reserve(command: ReserveCommand): Promise<ReservationResult> {
  return serializable(this.db, (trx) => this.reserveInTransaction(trx, command), this.retry);
}

/** Caller owns the SERIALIZABLE transaction and its retry. No network calls. */
async reserveInTransaction(trx: Transaction<DB>, command: ReserveCommand): Promise<ReservationResult>
async captureInTransaction(trx: Transaction<DB>, command: CaptureCommand): Promise<CaptureResult>
async releaseInTransaction(trx: Transaction<DB>, command: ReleaseCommand): Promise<ReleaseResult>
```

Rules:

- The `*InTransaction` variants assert the transaction is `SERIALIZABLE`
  (`show transaction_isolation`) and fail with `LEDGER_REQUIRES_SERIALIZABLE`
  otherwise.
- The outer command owns retry. Because `serializable()` re-runs the whole
  callback, the authorization command's policy evaluation re-runs with the
  reservation. That is the point.
- Idempotency is unchanged: the ledger still claims its own key. The
  authorization command derives it deterministically:
  `scope = 'authz.reserve'`, `key = authorization_id`. Capture and release use
  `scope = 'authz.finalize'`, `key = authorization_id`. Because both finalize
  commands share one key, a capture and a release for the same hold cannot both
  succeed: the second is an idempotency conflict (defense in depth for I10).
- Lock order is fixed everywhere: credential → mandate → authorization →
  ledger (advisory lock, then accounts in UUID order). Deadlocks are still
  retried, but the fixed order means they should not occur.

Existing tests keep passing unchanged. Add one test per variant proving it
rejects a non-serializable transaction and commits nothing on a thrown
callback.

## 5. Purchase lifecycle

### 5.1 States

`delivery_status` is the vertical's detail. `canonical_state` is the PRD §7.2
state and is the only state other modules read. A vertical does not get its own
canonical states.

| delivery_status | canonical_state | authorization | Ledger position |
| --- | --- | --- | --- |
| `declined` | `declined` | none | nothing reserved |
| `pending_dispatch` | `authorized` | `authorized` | amount reserved |
| `dispatching` | `in_progress` | `authorized` | amount reserved |
| `awaiting_confirmation` | `in_progress` | `authorized` | amount reserved |
| `unresolved` | `in_progress` | `authorized` | amount reserved, operator review |
| `delivered` | `captured` | `captured` | reserved → `provider_payable` |
| `rejected` | `failed` | `released` | reserved → available |
| `expired` | `expired` | `expired` | reserved → available |

Allowed transitions (anything else is a programming error and throws):

```text
pending_dispatch      → dispatching | expired
dispatching           → delivered | rejected | awaiting_confirmation | pending_dispatch (NotSent only)
awaiting_confirmation → delivered | rejected | unresolved
unresolved            → delivered | rejected            (operator, with evidence)
```

`delivered`, `rejected`, `expired`, and `declined` are terminal.

### 5.2 Provider outcome classification

This is the heart of the design. The `VasProvider` adapter must classify every
call into exactly one of four outcomes, and **must never turn ambiguity into a
definite answer**:

```ts
type SendOutcome =
  | { kind: 'delivered'; providerReference: string; evidence: DeliveryEvidence }
  | { kind: 'rejected'; code: VasRejectCode; providerReference?: string }  // definitive: no value delivered
  | { kind: 'not_sent'; reason: string }                                   // request provably never left
  | { kind: 'unknown'; reason: string; providerReference?: string };      // anything else

type RequeryOutcome =
  | { kind: 'delivered'; providerReference: string; evidence: DeliveryEvidence }
  | { kind: 'rejected'; code: VasRejectCode }
  | { kind: 'pending' }
  | { kind: 'not_found' }        // provider has no record of this request id
  | { kind: 'unknown'; reason: string };
```

Classification rules the adapter must follow (and its contract tests prove):

| Situation | Outcome |
| --- | --- |
| Provider returns an explicit success with a transaction reference | `delivered` |
| Provider returns an explicit, documented terminal failure (invalid number, product unavailable, provider balance insufficient) | `rejected` |
| DNS failure, connection refused, TLS failure **before any request bytes were written** | `not_sent` |
| Timeout after the request was written | `unknown` |
| HTTP 5xx, 429 after write, malformed body, unrecognized status | `unknown` |
| Provider says "pending" / "processing" | `unknown` on send, `pending` on requery |
| Requery says "no such transaction" within the grace period (§5.4) | `not_found` → treated as `pending` |
| Requery says "no such transaction" after the grace period | `rejected` with code `NEVER_RECEIVED` |

Why this matters, stated so reviewers and future contributors do not "simplify"
it:

- Releasing on `unknown` means the user is refunded while the provider may still
  deliver the airtime. Meter then owes the provider for value it never
  collected.
- Capturing on `unknown` means the user may be charged for airtime they never
  received.
- Only holding is safe. The hold costs the user temporary availability of that
  amount, which is visible and bounded. The other two options cost someone real
  money.

### 5.3 Dispatch and crash recovery

The finalizer processes one purchase per claim:

1. **Claim** (short transaction):
   ```sql
   update agents.purchases p
      set lease_until = now() + interval '30 seconds'
    where p.id in (
      select id from agents.purchases
       where delivery_status in ('pending_dispatch', 'dispatching', 'awaiting_confirmation')
         and next_action_at <= now()
         and (lease_until is null or lease_until < now())
       order by next_action_at
       for update skip locked
       limit 10)
   returning *;
   ```
2. **Pre-dispatch revalidation.** For `pending_dispatch`, check in a short
   transaction that the credential and mandate are still active and the hold
   has not expired. If not, go to §5.5.
3. **Write-ahead.** Commit `pending_dispatch → dispatching`,
   `dispatch_started_at = now()`, `send_attempts += 1`, *before* the network
   call.
4. **Send**, with no transaction open, using `request_id = purchase.id`.
5. **Record** the outcome in one `SERIALIZABLE` transaction (TX3): update the
   purchase, append the event, and call `captureInTransaction` or
   `releaseInTransaction` where applicable.

Crash recovery falls out of the write-ahead step:

- A row found in `dispatching` with an expired lease means a worker died after
  step 3. The request may or may not have reached the provider. The finalizer
  **never resends it**. It moves the row to `awaiting_confirmation` and
  requeries. Resending is unnecessary and dangerous; requery is always safe.
- The provider request id is the purchase id, so even an accidental resend is
  deduplicated by any provider that honors request ids. This is belt and
  braces, not the primary guarantee.
- `not_sent` is the only outcome that returns to `pending_dispatch`. It is
  bounded by `send_attempts ≤ 3`; after that the purchase is released as
  `rejected` with code `PROVIDER_UNREACHABLE`. Nothing was sent, so releasing is
  safe.

### 5.4 Requery schedule

`awaiting_confirmation` rows are requeried on a backoff schedule. The schedule
and deadline are configuration so the demo can compress them:

| Setting | Production default | Demo (`METER_AGENTS_SANDBOX`) |
| --- | --- | --- |
| Requery delays | 15s, 30s, 1m, 2m, 5m, 10m, then every 30m | 2s, 4s, 8s, 15s |
| `not_found` grace period | 5 minutes | 10 seconds |
| `resolve_deadline_at` | 24 hours after dispatch | 60 seconds after dispatch |

When the deadline passes without a definitive answer, the purchase moves to
`unresolved` and stays **held**. It raises an operations alert (arch §19.3).
An operator resolves it with `POST /v1/operator/purchases/:id/resolve`, which
requires an outcome, a reason, and an evidence reference (for example the
provider's statement line). Operator resolution is audited in
`agents.purchase_events` with actor `operator:<user_id>`.

### 5.5 Hold expiry and revocation before dispatch

- Every authorization has `hold_expires_at` (default 10 minutes; demo 30
  seconds). A sweeper releases holds whose purchase is still `pending_dispatch`
  after expiry: purchase → `expired`, authorization → `expired`, ledger
  release. Same claim pattern, same TX3 shape.
- Revoking a credential or mandate immediately (same transaction as the
  revocation) expires every purchase under it that is still
  `pending_dispatch`, releasing its hold. Purchases already `dispatching` or
  later are **not** touched: value may already be in flight, and §5.2 applies.
- The sweeper never touches `dispatching`, `awaiting_confirmation`, or
  `unresolved`. Expiry is a pre-dispatch concept only.

## 6. Policy evaluation

### 6.1 Order

Evaluation runs inside TX1, after the credential and mandate rows are locked.
It is ordered, deny-by-default, and short-circuits on the first denial
(AG3-02). Every check that ran is recorded, in order, in
`authz.decisions.evaluated`.

| # | Check | Denial code | Source |
| --- | --- | --- | --- |
| 1 | Credential exists, hash matches, `status = active`, not expired | `CREDENTIAL_INVALID` / `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | AG2 |
| 2 | Credential has scope `purchases:create` | `SCOPE_DENIED` | AG2 |
| 3 | Mandate `status = active`, not expired | `MANDATE_REVOKED` / `MANDATE_EXPIRED` | AG3 |
| 4 | Owner is active and unrestricted | `ACCOUNT_RESTRICTED` | W1-07 (compat reader) |
| 5 | Category in `allowed_categories` | `CATEGORY_NOT_ALLOWED` | AG4 |
| 6 | Destination in `allowed_destinations`, if set | `DESTINATION_NOT_ALLOWED` | AG4 |
| 7 | `amount ≤ per_transaction_limit` | `PER_TRANSACTION_LIMIT` | AG3 |
| 8 | No same destination + amount within `duplicate_window_secs`, unless `confirm_duplicate` | `DUPLICATE_SUSPECTED` | new (§6.4) |
| 9 | Approved authorizations in the last `velocity_window_secs` < `velocity_max_count` | `VELOCITY_LIMIT` | AG3 |
| 10 | Authorizations in `authorized` state < `max_in_flight` | `CONCURRENCY_LIMIT` | AG3 |
| 11 | `exposure_today + amount ≤ daily_limit` | `DAILY_LIMIT` | AUTH-03 |
| 12 | `exposure_lifetime + amount ≤ lifetime_limit` | `LIFETIME_LIMIT` | AG3 |
| 13 | Ledger reserve succeeds | `INSUFFICIENT_FUNDS` | AUTH-01/02 |

Cheap, static checks run first; aggregate queries run after; the ledger
reservation runs last so a decline never touches `ledger.*`.

### 6.2 Exposure

Limits are enforced against **exposure**, not spend:

```text
exposure(mandate, window) =
    Σ amount           where state = 'authorized'   (held: may still be spent)
  + Σ captured_amount  where state = 'captured'     (spent)
  over authz.authorizations created in window
```

Released and expired authorizations contribute zero, so a failed purchase
returns its budget as well as its money.

Exposure is **derived** from `authz.authorizations` on every evaluation. There
are no counters to drift. Correctness under concurrency comes from the
`FOR UPDATE` lock on the mandate row (which serializes authorizations for one
mandate) and from `SERIALIZABLE` isolation. The query is served by
`authorizations_mandate_time_idx`. If p95 authorization latency exceeds the
W4-07 budget of 500 ms, add a maintained counter table then, not before.

The daily window is the calendar day in `Africa/Lagos`, computed in SQL:
`created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`.

### 6.3 Denial payload

Denials are designed to be read by an LLM that must explain them to a human:

```json
{
  "error": {
    "code": "DAILY_LIMIT",
    "message": "This purchase would exceed the mandate's daily limit.",
    "dimension": "daily_limit",
    "limit": "5000.00",
    "current": "4500.00",
    "requested": "1000.00",
    "remaining": "500.00",
    "resets_at": "2026-09-25T00:00:00+01:00",
    "decision_id": "01926f3a-…"
  }
}
```

Every denial names the violated dimension and limit (AG3-03). Amounts are
decimal strings. No denial reveals another mandate's state or the owner's
account balance beyond what the agent's `spending_power` endpoint already
exposes.

### 6.4 Duplicate guard

LLM agents retry tool calls in ways a human would not: after a slow response,
after a context reset, or because they misread a result. An HTTP idempotency key
cannot catch this, because the MCP server issues a new key per tool call. The
duplicate guard catches the agent-level retry instead. A second approved
purchase for the same destination and amount within the window is declined with
`DUPLICATE_SUSPECTED` unless the request sets `confirm_duplicate: true`. The MCP
tool description tells the model to set it only when the user explicitly asked
for a repeat purchase.

## 7. Credentials

- Token format: `mtr_agt_<public_id>_<secret>`. `public_id` is 12 base32
  characters; `secret` is 32 bytes from `crypto.randomBytes`, base64url.
- Stored: `public_id` and `HMAC-SHA256(METER_CREDENTIAL_PEPPER, secret)`. The
  secret is high-entropy, so a fast keyed hash is correct; a password KDF would
  only add latency. Comparison uses `crypto.timingSafeEqual`.
- The full token is returned **once**, at creation. It cannot be retrieved.
- Authentication runs through a new `AgentCredentialGuard`, separate from the
  Clerk-backed `AuthGuard`, and produces an immutable `AgentPrincipal
  { credentialId, mandateId, ownerId, scopes }`. Routes declare which principal
  type they accept; a human session cannot call agent routes and vice versa.
- The guard performs a fast pre-check (outside any transaction) to reject bad
  tokens cheaply. The **authoritative** check is policy step 1 inside TX1, which
  reads the credential row under lock. That is what makes "revoked credentials
  fail on their next authorization attempt" (AUTH-07, AG2-03) true even when
  revocation races a purchase.
- `last_used_at` is updated at most once per minute to avoid write
  amplification on the hot path.

## 8. API

All routes are under `/v1`, return stable machine-readable error codes, and
accept money as decimal strings (`"500.00"`). Financial commands require an
`Idempotency-Key` header.

### 8.1 Owner routes (Clerk session, `AuthGuard`)

| Method and path | Purpose |
| --- | --- |
| `POST /v1/mandates` | Create a mandate. Owner's NGN available/reserved accounts are resolved or created. |
| `GET /v1/mandates` · `GET /v1/mandates/:id` | List and read, including current exposure against each limit. |
| `POST /v1/mandates/:id/revoke` | Revoke mandate and all its credentials; expire undispatched purchases (§5.5). |
| `POST /v1/mandates/:id/credentials` | Issue a credential. Returns the token once. |
| `POST /v1/credentials/:id/revoke` | Revoke one credential; expire its undispatched purchases. |
| `GET /v1/purchases/:id/timeline` | Full timeline (§9.4). |
| `POST /v1/sandbox/credit` | Sandbox only: credit the owner's balance via the ledger `credit` command. 404 unless `METER_AGENTS_SANDBOX=true`. |

### 8.2 Agent routes (`AgentCredentialGuard`)

| Method and path | Purpose |
| --- | --- |
| `GET /v1/agent/spending-power` | `min(available balance, remaining per-tx, remaining daily, remaining lifetime)`, with each limit broken out and the in-flight count. |
| `POST /v1/agent/purchases` | Authorize and enqueue a purchase. |
| `GET /v1/agent/purchases/:id` | Status of one purchase created by this credential. |
| `GET /v1/agent/purchases` | Recent purchases for this credential, newest first, paginated. |

`POST /v1/agent/purchases` request:

```json
{
  "category": "airtime",
  "network": "mtn",
  "destination": "08030000000",
  "amount": "500.00",
  "intent": "User asked to top up their own line before a trip.",
  "confirm_duplicate": false
}
```

Responses:

- `202 Accepted` with `{ "purchase_id", "status": "processing", "canonical_state": "authorized" }`
  when approved. The purchase is funded and queued; delivery is asynchronous.
- `402 Payment Required` with the §6.3 payload for `INSUFFICIENT_FUNDS`.
- `403 Forbidden` with the §6.3 payload for every other policy denial.
- `409 Conflict` with `IDEMPOTENCY_CONFLICT` when the key was used with a
  different body.
- A replay with the same key and body returns the original response with
  header `Idempotent-Replayed: true`.

Validation happens before any transaction: destination is normalized to E.164
and must be a valid Nigerian mobile number; amount must be a positive whole-naira
value between ₦50 and ₦50,000 for airtime; intent is required and capped at 280
characters.

### 8.3 Operator route

`POST /v1/operator/purchases/:id/resolve` (operations role only) resolves an
`unresolved` purchase to `delivered` or `rejected` with a reason and evidence
reference. It uses the same TX3 path as the finalizer.

## 9. VAS provider adapters

### 9.1 Port

```ts
interface VasProvider {
  readonly name: string;
  sendAirtime(req: AirtimeRequest): Promise<SendOutcome>;      // req.requestId = purchase id
  requery(requestId: string): Promise<RequeryOutcome>;
}
```

Both methods run through the outbound call policy wrapper (W5-05) when it
exists. Until then the adapter applies its own connect timeout (3s), response
timeout (15s), and a per-provider concurrency cap. It does **not** retry
`sendAirtime` internally: retry decisions belong to the finalizer, which knows
whether a retry is safe.

### 9.2 Simulator (required)

`SimulatedVasProvider` is deterministic and keyed on the destination's last
four digits so every path can be demonstrated on demand:

| Last four digits | Send | Requery sequence |
| --- | --- | --- |
| `0000` (and any unlisted) | `delivered` after 300 ms | `delivered` |
| `0001` | `rejected` (`INVALID_NUMBER`) | `rejected` |
| `0002` | `unknown` (timeout after write) | `pending`, then `delivered` |
| `0003` | `unknown` (timeout after write) | `pending`, then `rejected` |
| `0004` | `unknown` (HTTP 502) | `not_found` ×2, then `delivered` |
| `0005` | `unknown` | `pending` forever → `unresolved` at deadline |
| `0006` | `not_sent` (connection refused) twice, then `delivered` | — |
| `0007` | sleeps 20s (worker can be killed mid-call) | `delivered` |

The simulator records every call it receives so tests can assert how many
sends a purchase produced (I12). It is the default adapter when
`METER_AGENTS_SANDBOX=true`.

### 9.3 VTpass sandbox adapter (optional)

A thin adapter against the VTpass sandbox for a real-provider segment of the
demo. Map its documented response codes into §5.2 outcomes, with any code not
explicitly mapped falling to `unknown`. Use the purchase id to derive VTpass's
`request_id` (which requires a Lagos-time timestamp prefix; confirm the exact
format and the sandbox test numbers against current VTpass documentation before
implementing). The adapter's contract tests run against recorded fixtures, not
the live sandbox.

Stored provider outcomes are redacted: no API keys, no full raw bodies; phone
numbers are masked to `+234803****000` in `last_provider_outcome` and logs.

### 9.4 Timeline

`GET /v1/purchases/:id/timeline` and the `pnpm demo:timeline <purchase_id>`
script return one ordered list built from `authz.decisions`,
`agents.purchase_events`, and the ledger transactions they reference:

```text
12:04:01.112  decision   approved    agent:mtr_agt_7QK…  intent="Top up my line"
                         checks: credential ✓ scope ✓ mandate ✓ category ✓ per-tx ✓ …
12:04:01.140  ledger     reserve     ₦500.00  available → reserved     txn 0192…
12:04:01.402  purchase   pending_dispatch → dispatching               worker
12:04:16.410  provider   send → unknown (timeout after write)
12:04:16.431  purchase   dispatching → awaiting_confirmation
12:04:18.502  provider   requery → pending
12:04:22.611  provider   requery → delivered  ref=SIM-88213
12:04:22.640  ledger     capture     ₦500.00  reserved → provider_payable  txn 0192…
12:04:22.640  purchase   awaiting_confirmation → delivered
```

This is the artifact that answers "which agent bought what, and why" (PRD §6.2).

## 10. MCP server (`apps/mcp`)

A stdio MCP server built on the official TypeScript MCP SDK. It reads
`METER_API_URL` and `METER_AGENT_CREDENTIAL` from its environment and is a pure
client of §8.2. For the demo it is registered as a local MCP server in Claude
Desktop's MCP configuration. Adding the SDK follows the README's dependency policy:
no lifecycle scripts, nothing published in the last 7 days, its own commit.

### 10.1 Tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `get_spending_power` | none | Returns what the agent may spend right now and which limit binds. |
| `buy_airtime` | `network`, `phone`, `amount_naira`, `intent`, `confirm_duplicate?` | Generates a fresh idempotency key, calls `POST /v1/agent/purchases`, then polls the purchase for up to 8 seconds. Returns the final status if reached, otherwise `processing`. |
| `get_purchase` | `purchase_id` | Current status and, when terminal, amount charged or released. |
| `list_purchases` | `limit?` | Recent purchases with status. |

### 10.2 Tool contract written for models, not humans

Tool descriptions and results carry the operational rules an agent must follow:

- `buy_airtime`'s description states: if the result is `processing`, the money
  is held and the purchase is in progress; **do not call `buy_airtime` again**
  for the same request — call `get_purchase` later.
- Denials are returned as tool results, not transport errors, with the §6.3
  payload plus a one-sentence plain-language explanation, so the model can tell
  the user exactly which limit applied and when it resets.
- `intent` is required and is described as "why you are making this purchase,
  in the user's words where possible". It is recorded, never used for policy.
- Every result includes `purchase_id` so the conversation can refer back to it.

### 10.3 Security

The MCP process can do nothing the credential cannot. Credential scopes for a
demo agent are `{purchases:create, purchases:read}`; the MCP server never sees a
Clerk session and has no route to owner or operator endpoints.

## 11. Jobs

### 11.1 Workers

Two loops run in the existing worker process (`bootstrap/worker.ts`):

- `agents-finalizer`: claims `pending_dispatch`, `dispatching` (expired lease),
  and due `awaiting_confirmation` rows (§5.3, §5.4). Concurrency 4.
- `authz-hold-sweeper`: every 5 seconds, expires undispatched holds (§5.5).

Both are idempotent: every transition is guarded by
`where delivery_status = <expected>` and checks the affected row count. A lost
race is a no-op, not an error. Both shut down gracefully on `SIGTERM`: stop
claiming, finish or abandon (lease expiry) in-flight work.

### 11.2 Migration to the outbox

When W7-01/W7-03 land, TX1 additionally writes an `agents.purchase_authorized`
outbox event and the finalizer becomes a pg-boss `provider-finalization`
consumer. The state-table claim remains as the recovery sweep for expired
leases. No data migration is needed.

## 12. Testing

### 12.1 New mandatory financial invariants

Added to `test:financial` and the required `financial` CI job.

| ID | Invariant | Proof |
| --- | --- | --- |
| I9 | Mandate exposure never exceeds any limit, under concurrency | Testcontainers: 30 parallel purchases against one mandate with tight daily, lifetime, and in-flight limits; sum of approved amounts ≤ each limit; every rejection has a stable code |
| I10 | A hold finalizes at most once: captured + released = held, never both | Property test (fast-check) over interleaved finalizer, sweeper, revocation, and operator actions |
| I11 | An `unknown` outcome never captures or releases without a definitive provider answer or operator evidence | Simulator scenarios `0002`–`0005`; assert ledger unchanged while status is `awaiting_confirmation` or `unresolved` |
| I12 | The provider receives at most one send per purchase after write-ahead | Kill the worker during scenario `0007`; restart; simulator records exactly one send and ≥1 requery |
| I13 | A declined request writes no ledger rows and invokes no provider | Spy on the simulator; assert `ledger.transactions` count unchanged for each of the 13 denial codes |
| I14 | A credential revoked before an authorization commits cannot authorize | Race revocation against purchases; every purchase whose TX1 committed after the revocation commit was declined `CREDENTIAL_REVOKED` |
| I15 | Pre-dispatch expiry and revocation release exactly the held amount once | Sweeper + revocation racing the finalizer claim; balances reconcile to the journal |

### 12.2 Model-based test

A fast-check `commands` model drives the real API and worker with random
sequences of: create purchase, advance clock, run finalizer tick, run sweeper
tick, revoke credential, revoke mandate, operator resolve. The model tracks
expected exposure and balances. After every command, the real system must
match the model, and the existing eight ledger invariants must hold.

### 12.3 Other tests

- Unit: policy ordering and short-circuiting, exposure arithmetic, Lagos day
  boundary (23:59:59 and 00:00:00 WAT), token parsing and hashing, E.164
  normalization, outcome classification table (§5.2) for each adapter.
- Integration: every route's happy path and each denial code; idempotent
  replay; `IDEMPOTENCY_CONFLICT`; timeline completeness.
- MCP: an integration test starts the API and the MCP server, calls each tool
  through an in-process MCP client, and asserts results and side effects.

### 12.4 Stretch: human approval (AG-5)

Mandates gain `approval_threshold`. A purchase above it reserves funds, enters
`pending_approval` (canonical `authorized`), and is dispatched only after the
owner approves via `POST /v1/purchases/:id/approve`. It expires and releases
like any undispatched hold. The MCP tool returns `awaiting_owner_approval`.

## 13. Observability

- One `correlation_id` per purchase, generated in TX1, carried to ledger
  transactions, purchase events, provider requests (as a header where
  supported), and every log line.
- Metrics: authorization decisions by outcome and code; authorization latency
  p50/p95; purchases by `delivery_status`; time in `awaiting_confirmation`;
  count of `unresolved`; provider outcomes by kind.
- Alerts: any `unresolved` purchase; held value in `awaiting_confirmation` above
  a threshold; finalizer lag (oldest due row) above 60 seconds.

## 14. Tickets

Sizes follow the ticket breakdown's scale. Existing IDs are reused where the
work matches; new work uses new IDs.

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| L-01 | Transaction-scoped `reserve`/`capture`/`release` | S | — | Variants reject non-serializable transactions; existing suite green |
| AG2-01 | Credential store (0010, pulled forward, mandate-scoped) | S | — | Only a hash stored; token shown once |
| AG2-02 | `AgentCredentialGuard` and `AgentPrincipal` | S | AG2-01 | Machine requests authenticate; human sessions rejected on agent routes |
| AG3-01 | Mandate schema and owner CRUD | S | L-01 | Limits stored with checks; exposure readable |
| AG3-02 | Ordered policy evaluator + `authz.decisions` | M | AG3-01, AG2-02 | §6.1 order; every decision recorded with snapshot |
| W4-04 | Authorize command: TX1 end to end | M | AG3-02 | Approval reserves; every decline reserves nothing (I13) |
| VAS-01 | `VasProvider` port and simulator | S | — | All §9.2 scenarios reproducible; calls recorded |
| AGX-01 | Purchases table, state machine, events | S | W4-04 | Illegal transitions throw; every transition writes one event |
| AGX-02 | Finalizer: claim, write-ahead, send, record | M | AGX-01, VAS-01 | I11, I12 pass |
| AGX-03 | Requery schedule, deadline, `unresolved`, operator resolve | M | AGX-02 | Scenarios `0002`–`0005` resolve as specified |
| AG2-03 | Revocation with pre-dispatch expiry | S | AGX-01 | I14, I15 pass |
| AG5-03 | Hold sweeper | S | AGX-01 | Undispatched holds release exactly once |
| AGX-04 | Agent and owner HTTP routes, sandbox credit | M | W4-04 | §8 contract; denial payloads per §6.3 |
| AGX-05 | Timeline endpoint and `demo:timeline` script | S | AGX-03 | Output matches §9.4 shape |
| MCP-01 | `apps/mcp` stdio server and four tools | M | AGX-04 | Claude Desktop completes the §15 script |
| AGX-06 | Invariants I9–I15 and model-based test in `test:financial` | M | AGX-03, AG2-03 | Required CI job green |
| VAS-02 | VTpass sandbox adapter (optional) | S | VAS-01 | Contract tests pass on recorded fixtures |
| AG5-01 | Human approval (stretch) | M | AGX-02 | §12.4 |

### 14.1 Build order for a one-day demo cut

With coding agents, the demo cut is roughly one long day. Build in this order;
each step leaves the system working:

1. L-01 → AG2-01 → AG3-01 (schema, credentials, mandates)
2. AG3-02 → W4-04 → the I9 concurrency test (the core claim; prove it early)
3. VAS-01 → AGX-01 → AGX-02 → AGX-03 (delivery truth)
4. AGX-04 → MCP-01 (make it usable by a real LLM)
5. AGX-05, README, architecture diagram, then record

If time runs short, cut in this order: VAS-02, AG5-01, the model-based test
(keep I9–I15), AG5-03 sweeper, `list_purchases`, the duplicate guard. **Do not
cut** outcome classification, write-ahead dispatch, or I9: those are the
design.

## 15. Demo acceptance script

The demo is complete when this runs live, in one take, with Claude Desktop
using the MCP server:

1. Owner credits ₦10,000 (sandbox) and creates a mandate: per-tx ₦2,000, daily
   ₦5,000, velocity 5 per 10 minutes, airtime only. Issues a credential and
   configures the MCP server with it.
2. "Buy ₦500 MTN airtime for 0803 000 0000." → delivered; timeline shows
   reserve then capture.
3. "Buy ₦3,000 airtime for the same number." → declined `PER_TRANSACTION_LIMIT`;
   Claude explains the limit. Ledger unchanged.
4. "Buy ₦500 for 0803 000 0002." → Claude reports processing; timeline shows
   send timeout, requeries, then capture. Claude does not retry.
5. "Buy ₦500 for 0803 000 0003." → same start, ends released; balance restored.
6. Run the concurrency script: 20 parallel ₦500 purchases against the remaining
   daily budget. Show approvals sum ≤ the limit, the rest declined
   `DAILY_LIMIT` or `CONCURRENCY_LIMIT`, and `test:financial` green.
7. Start ₦500 for 0803 000 0007, kill the worker mid-call, restart it. Show one
   send, a requery, and exactly one capture.
8. Revoke the credential from the owner API. Claude's next attempt fails
   `CREDENTIAL_REVOKED`.

## 16. Completion criteria

- All tickets in the demo cut meet their "done when" conditions.
- `test:financial` includes I9–I15 and passes against PostgreSQL 18 in CI.
- Migrations 0010 and 0011 apply cleanly to a fresh database and to one at 0009.
- No external network call occurs inside a database transaction (enforced by
  code review and by the adapter being unreachable from `*InTransaction` code
  paths).
- The §15 script passes end to end.
- The README's first screen states what works today, links the demo recording,
  and shows the §2.2 flow diagram.
