# Meter First-Ten and Ledger-Prerequisites Design

**Status:** Approved for implementation

**Date:** 2026-09-20

**Owner:** Founder / CTO

**Related:** [`technology architecture`](2026-09-20-meter-technology-architecture-design.md) · [`implementation plan`](2026-09-20-meter-implementation-plan.md) · [`ticket breakdown`](2026-09-20-meter-ticket-breakdown.md)

## 1. Purpose and scope

This design makes the ticket breakdown's first ten tickets implementable without
claiming a financial CI gate whose dependencies do not exist.

The original first-ten sequence contains `W2-15`, which depends on `W2-13` and
`W2-14`. The property suite in `W2-13` exercises command behavior introduced by
later ledger tickets, and the mandatory financial suite requires capture,
release, retry, and projection-rebuild behavior. The implementation scope is
therefore the original first ten plus the seven ledger prerequisites needed to
close those invariants:

- Original first ten: `W1-01`, `W2-01`, `W1-04`, `W1-02`, `W2-02`, `W1-03`,
  `W2-03`, `W2-04`, `W2-14`, and `W2-15`.
- Added prerequisites: `W2-05`, `W2-06`, `W2-07`, `W2-08`, `W2-09`, `W2-12`,
  and `W2-13`.

The work does not add KYC tiers, Clerk lifecycle webhook handlers, operator
audit logging, quotes, budgets, funding-provider integration, or settlement.
Those remain in their existing tickets.

## 2. Architecture

The implementation follows a domain-first modular structure. Domain and
application code owns Meter concepts and depends on explicit ports. PostgreSQL
repositories and external-provider adapters implement those ports. NestJS
modules assemble the dependencies without exposing provider SDK or database
types across module boundaries.

SQL constraints are the final defense for invariants that remain valid for all
callers. Application services provide stable domain errors, command
orchestration, and testable policies. Financial behavior is not hidden in
stored procedures, and no general-purpose ORM abstraction is added over
Kysely.

### 2.1 Identity boundary

The identity module owns:

- `identity.users`, keyed by PostgreSQL UUIDv7.
- `identity.external_identities`, which maps a provider and subject to one
  internal user.
- User status and Meter-owned roles needed by the authenticated principal.
- Repository and application interfaces for resolving the current user.

Financial tables refer to `identity.users.id`, never a Clerk subject. The
Clerk adapter implements `AuthenticatorPort`, which exposes token verification
and user retrieval through Meter-owned values. No Clerk SDK type leaves
`adapters/auth`.

The request guard denies by default. It verifies the bearer token, resolves the
external subject to an active internal user, loads roles and current account
restriction state, and attaches an immutable Meter principal to the request.
Missing credentials, unknown mappings, inactive users, restrictions, and
authentication-provider failures do not yield an authenticated principal.

### 2.2 Webhook boundary

Fastify preserves the exact request bytes before JSON parsing. A shared webhook
ingestion service accepts a provider-specific signature verifier, the raw body,
the provider event ID, and the provider timestamp.

The shared path:

1. Verifies the signature over the original bytes.
2. Enforces a configured replay window using an injected clock.
3. Computes a SHA-256 digest of the payload.
4. Inserts the provider and external event ID under a unique constraint.
5. Treats an existing event with the same digest as an acknowledged duplicate.
6. Rejects reuse of an event ID with a different digest as a security conflict.

Verification ports contain provider-specific header and signature rules. The
shared service is reusable without modification by the later Clerk and payment
webhook handlers. A webhook never mutates a ledger balance directly.

### 2.3 Ledger boundary

The ledger module is the only writer to `ledger.*`. It owns:

- The chart of accounts and account taxonomy.
- Idempotency claims and stored command results.
- The `postJournal` primitive.
- Reservation, capture, release, reverse, refund, credit, and debit commands.
- Balance projections and their rebuild operation.
- Ledger outbox events committed with financial state.

Every public financial command accepts an idempotency scope, key, and request
whose canonical digest is stored. A retry with the same digest returns the
first committed result. Reusing the key for a different request fails with a
stable conflict code.

## 3. Data model

### 3.1 Identity

`identity.users` stores the internal UUIDv7 ID, status, roles, and timestamps.
`identity.external_identities` stores provider, external subject, user ID, and
provider metadata. `(provider, external_subject)` is unique. Financial foreign
keys target the internal user table.

The guard reads account restrictions through the compliance boundary. Because
`W1-07` is outside this scope, the restriction reader has a PostgreSQL
implementation that reports unrestricted when no restriction table or record
exists and a test implementation for deny-path coverage. The later restriction
ticket replaces this compatibility behavior without changing the guard.

### 3.2 Webhook events

`operations.external_events` stores provider, external ID, payload digest,
provider event time, receive time, and processing state. The primary key is
`(provider, external_id)`. The payload itself is not persisted by the shared
deduplication layer.

### 3.3 Ledger accounts and assets

Accounts have a checked owner type, asset code, account class, purpose, normal
balance, and status. The initial taxonomy supports:

- Customer available, reserved, and pending liabilities.
- Provider payables.
- Meter revenue.
- Tax liabilities.
- External cash.
- Reserves.

System-owned accounts use stable seed identifiers so migrations are
deterministic. Customer accounts use internal Meter user IDs. Account uniqueness
prevents two active accounts for the same owner, asset, and purpose.

### 3.4 Idempotency and journals

`ledger.idempotency` stores scope, key, request digest, state, transaction ID,
serialized first result, and timestamps. A unique `(scope, key)` constraint
serializes competing claims.

`ledger.transactions` records transaction type, state, effective time,
correlation ID, optional external reference, optional `reversal_of`, and
metadata. Idempotency is not inferred solely from this table.

`ledger.entries` remains append-only. Each positive atomic entry names its
account, asset, and debit or credit direction. A deferred database constraint
trigger validates that every completed journal balances per asset. Direct
updates and deletes raise errors rather than silently reporting success.

### 3.5 Balances and reservations

`ledger.balances` is an atomically maintained projection. Its signed posted
amount follows each account's normal balance. Available customer liability
cannot fall below zero.

`ledger.reservations` records the original amount, captured amount, released
amount, state, and the available/reserved accounts involved. Checked arithmetic
ensures captured plus released never exceeds the original amount. Capture and
release lock the reservation before calculating the remaining ceiling.

Refund totals are derived under lock from prior refund transactions linked to
the capture. A refund above captured value minus previous refunds fails without
writing a journal.

## 4. Command flow

Every ledger command runs through the existing bounded `SERIALIZABLE` helper:

1. Canonicalize and hash the request.
2. Claim the idempotency key or load the existing claim.
3. Return the stored result for an identical completed claim.
4. Reject a digest conflict.
5. Lock all affected accounts and balance rows in stable UUID order.
6. Validate command-specific funds and ceilings.
7. Build entries and call `postJournal`.
8. Validate positive amounts, account/entry asset agreement, and balance by
   asset.
9. Insert the transaction and append-only entries.
10. Update projections and reservation state.
11. Insert the outbox event.
12. Store the first command result and commit.

The transaction contains no external network call. PostgreSQL serialization
failures and deadlocks receive bounded exponential backoff with jitter.
Constraint failures, domain declines, and idempotency conflicts do not retry.

### 4.1 Command semantics

- `credit` moves value from external cash to customer available liability.
- `debit` performs the controlled inverse and refuses insufficient available
  value.
- `reserve` moves customer available liability to customer reserved liability
  and creates a reservation.
- `capture` consumes no more than the remaining reservation. A request above
  the remaining amount is capped and reports the requested and captured values.
- `release` returns unused reserved value to available value.
- `reverse` writes an exact compensating journal linked to the original; the
  original remains untouched.
- `refund` compensates a capture up to captured value minus previous refunds.
- Projection rebuild truncates and recomputes only the derived balance
  projection from immutable entries inside an exclusive maintenance operation.

## 5. Error model

Application errors carry stable codes and safe public messages. The initial
codes distinguish unauthenticated, unknown identity, inactive account,
restricted account, invalid webhook signature, expired webhook, webhook event
conflict, idempotency conflict, invalid journal, insufficient funds,
reservation exhausted, refund ceiling exceeded, and non-reversible transaction.

Database error details and provider errors are retained in structured internal
logs but are not returned to callers. Unexpected authentication failures deny
the request. Unexpected financial failures roll back the entire command.

## 6. Testing strategy

### 6.1 Unit tests

Unit tests cover canonical request hashing, account taxonomy, debit/credit
projection rules, journal balancing, command validation, authentication result
mapping, principal creation, and webhook timestamp policy.

### 6.2 PostgreSQL integration tests

Integration tests run reviewed migrations against PostgreSQL 18 and verify:

- UUIDv7 identity keys and external-subject uniqueness.
- Account taxonomy and deterministic system seed data.
- Append-only entries reject updates and deletes.
- Unbalanced journals cannot commit.
- An identical command retry returns the first result without new value.
- Conflicting idempotency requests fail.
- Journal, projections, reservations, and outbox commit atomically.
- Available value never becomes negative.
- Capture, release, reversal, and refund ceilings hold.
- Rebuilding projections reproduces recorded balances exactly.

Tests isolate state with per-test databases or schemas and deterministic
fixtures. Assertions inspect both the returned result and all affected
financial records.

### 6.3 Property and concurrency tests

fast-check generates command sequences and verifies conservation, balance by
asset, exact integer arithmetic, ceiling enforcement, and reversal without
residue.

Testcontainers runs parallel reservations against one funded balance. The sum
of successful reservations must not exceed the initial available amount;
failed attempts use a stable insufficient-funds code; retries terminate within
the configured bound; and no duplicate journal or outbox event is produced.

### 6.4 CI gate

A dedicated `test:financial` command runs migrations and the mandatory
financial suite against PostgreSQL on every pull request. The gate covers the
eight invariants enabled by this scope: balanced journals, immutable entries,
non-negative availability, concurrency safety, capture ceiling, capture plus
release equality, retry idempotency, and projection rebuild equality.

Ordinary unit tests, type checking, builds, and migration idempotency remain
separate visible CI steps.

## 7. Delivery constraints

- Existing staged scaffold changes are preserved.
- New migrations are additive; already-applied migration files are not edited.
- Money remains `bigint` in server code, decimal strings at JSON boundaries,
  and `NUMERIC(38,0)` in PostgreSQL.
- No provider SDK type crosses an adapter boundary.
- No external network call occurs inside a database transaction.
- No vertical product receives a private ledger path.
- No KYC, pricing, funding, or settlement behavior is pulled forward beyond
  what is required to verify this scope.

## 8. Completion criteria

The scope is complete when all 17 tickets' acceptance conditions that fall
within this design pass, the financial CI command is mandatory, migrations are
idempotent against PostgreSQL 18, all packages type-check and build, and the
full test suite passes from a clean process.
