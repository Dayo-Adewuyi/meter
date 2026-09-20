# Meter Implementation Plan

**Status:** Draft for founder review

**Date:** 2026-09-20

**Owner:** Founder / CTO

**Scope:** Meter Core plus all six vertical products

**Related:** [`master PRD`](2026-09-20-meter-master-platform-prd.md) · [`technology architecture`](2026-09-20-meter-technology-architecture-design.md) · [`ticket breakdown`](2026-09-20-meter-ticket-breakdown.md)

---

## 1. Purpose and standing

This plan turns the master PRD and the architecture design into ordered,
acceptance-tested engineering work for Meter Core and the six verticals.

Two caveats are load-bearing:

1. PRD §23.7 sequences an implementation plan *after* a reviewed release-level
   Meter AI PRD. That PRD does not exist yet. Everything here for Stage 1 is
   derived from PRD §8 and §9.2 directly; expect the release PRD to change
   copy, capability edges, and priority within workstreams, not their order.
2. PRD §22 fixes expansion to evidence gates, not calendar promises. This plan
   therefore sizes work in **founder-weeks of engineering effort**, never in
   dates. Effort is a calibration input, not a commitment.

Per-workstream tickets live in the [ticket breakdown](2026-09-20-meter-ticket-breakdown.md).

### 1.1 How to read a workstream

Every workstream states what it delivers, which PRD requirement IDs it
satisfies, what it depends on, the deliberately minimal thing that is built,
what is explicitly deferred, and the acceptance conditions that close it. A
workstream is not done when the code exists. It is done when its acceptance
conditions pass in CI against a real PostgreSQL.

### 1.2 Sizing key

| Size | Founder-weeks |
| --- | ---: |
| S | under 1 |
| M | 1–2 |
| L | 2–4 |
| XL | 4–8 |

---

## 2. Current state

Delivered and verified in the repository today:

| Item | State |
| --- | --- |
| pnpm/Turbo monorepo, Node 24, TypeScript 7 | working |
| `apps/server` NestJS 12 + Fastify, API and worker bootstraps | boots, serves `/v1/health` |
| `apps/web` Next.js 16 static-export PWA | builds |
| `packages/contracts` money codec and canonical transaction model | 10 tests passing |
| `packages/config` typed environment validated at boot | working |
| `platform/database` Kysely + pg, serializable retry helper | 5 tests passing |
| `platform/jobs` pg-boss wiring, nine queue names | starts |
| `database/migrations` schemas, ledger, outbox | applied twice against PostgreSQL 18.6, idempotent |
| Ledger append-only rules, idempotency uniqueness | proven in SQL |
| Supply-chain controls | proven: script execution refused, cooldown enforced, frozen lockfile enforced |
| CI workflow, Dockerfile, Render manifest | written, not yet run in GitHub |

This satisfies architecture §26 step 1. Every module directory under
`modules/core` and `modules/products/ai` is empty.

### 2.1 What is not true yet

No identity, no funding, no quotes, no authorization, no provider call, no
capture, no settlement, no reconciliation, no UI beyond an application shell.
The ledger has tables and invariants but no commands. Nothing has touched real
money, and nothing should until Track A below clears.

---

## 3. Planning rules

1. **Core before vertical.** A vertical may only add the unit it meters and the
   evidence that it was delivered. If a vertical needs a new transaction state,
   a new money path, or a private definition of "captured", the design is wrong.
2. **Ledger commands are the only writer.** No module inserts entries or updates
   balances directly, in any stage.
3. **A stage does not start because the previous one shipped.** It starts when
   the previous exit gate is measured and passed (PRD §9).
4. **Engineering is not the critical path to real money.** Track A blockers gate
   every funded flow regardless of code readiness.
5. **Build the laziest thing that satisfies the acceptance condition**, record
   what was deferred in a `ponytail:` comment naming the upgrade trigger, and
   let measurement decide when to upgrade (architecture §24).
6. **Every financial workstream ships its invariant tests in the same PR.**
   Architecture §20.1 lists twelve mandatory financial tests; each workstream
   below names the ones it must make pass.

---

## 4. Critical path

```text
Track A (legal, partner, provider terms) ────────────────┐
                                                         │ gates all funded flow
W1 identity ──┬── W2 ledger ──┬── W4 authorization ──┬────┴── W8 funding
              │               │                     │
              └── W3 catalog/pricing ───────────────┤
                                                    │
                              W5 AI adapter ────────┴── W6 usage/capture
                                                         │
                              W7 outbox/worker ──────────┤
                                                         │
                              W9 settlement ─────────────┤
                                                         │
                              W10 reconciliation/ops ────┤
                                                         │
                              W11 refunds/support ───────┤
                                                         │
                              W12 PWA ───────────────────┴── W13 production
                                                                  │
                                                         W14 gates → beta → launch
```

W12 (PWA) runs in parallel from W3 onward against a mocked API; it is drawn
last only because it cannot be accepted before the commands it calls exist.

---

## 5. Track A — non-engineering blockers

These run in parallel with all engineering and gate the first real naira.
They are listed because no amount of correct code substitutes for them.

| ID | Blocker | Gates | PRD |
| --- | --- | --- | --- |
| A1 | Written legal advice: custody, credits, redemption, stablecoins, provider payments, consumer protection, privacy, tax | any real funding | §9.1, §14.2 |
| A2 | Licensed Nigerian payment/custody partner LOI or agreement | W8, all funded flow | §9.1, §14.1 |
| A3 | Model-provider commercial terms permitting managed-service or resale | W5 | §9.1 |
| A4 | 30 target-user interviews and funded-intent prototype test | Stage 0 exit | §9.1 |
| A5 | Release-level Meter AI PRD reviewed and approved | this plan's Stage 1 detail | §23.6 |
| A6 | Safeguarding structure confirmed (customer funds) | public launch | §14.1 |

**Stage 0 exit gate (PRD §9.1):** 30 funded beta users, ≥50% complete a second
paid session within 14 days, no unresolved fatal legal blocker, projected
contribution margin positive.

---

## 6. Stage 1 — Meter AI

Total estimated effort: **28–40 founder-weeks** to public-launch readiness,
excluding Track A elapsed time and beta duration.

### W1 — Identity, access, and account state

**Delivers:** Meter-owned identity with Clerk as a replaceable authenticator.

**Satisfies:** ID-01, ID-02, ID-03, ID-04 · **Depends on:** none · **Size:** M

**Build:**
- `identity.users` keyed by internal UUIDv7; `identity.external_identities`
  maps Clerk subject → internal id. Financial foreign keys use the internal id only.
- Clerk adapter behind an `AuthenticatorPort` interface in `adapters/auth`.
- Signed, replay-safe, idempotent Clerk webhooks through the shared webhook
  path (raw body, signature, timestamp window, unique external event id).
- Nest guard resolving request → internal user, roles, and account restriction state.
- `compliance.kyc_tiers` and `compliance.account_restrictions`; deny-by-default
  authorization checks read restriction state on every financial command.
- Operator actions (refund, limit change, freeze) record authenticated operator
  and reason in an append-only `operations.audit_log`.

**Ship lazily:** roles as a text column with a checked enum, not an RBAC engine.
Step-up auth via Clerk's own MFA, not a Meter-built challenge flow.

**Defer:** organizations and least-privilege roles (ID-05) to W-Agents-1;
KYB (ID-06) to W-Prov-1; sanctions screening (ID-07) to Stage 2 unless the
partner requires it earlier — confirm with A2.

**Acceptance:**
- A user signs in on a new device after the approved recovery flow.
- Funding or spend above a tier limit is blocked *before* authorization.
- A restricted account cannot authorize new spend; its history stays readable to staff.
- Replaying a Clerk webhook 100 times produces one identity mutation.

### W2 — Ledger commands and reservations

**Delivers:** the only code in Meter that moves money.

**Satisfies:** LED-01, LED-02, LED-03, LED-04, LED-05, AUTH-02 · **Depends on:** W1 · **Size:** L

**Build:**
- Account-class taxonomy: customer liability (available / reserved / pending),
  provider payable, Meter revenue, tax liability, external cash, reserves.
- Commands: `reserve`, `capture`, `release`, `reverse`, `refund`, `credit`,
  `debit`. Each takes an idempotency scope and key, runs in the `serializable`
  helper, writes journal + entries + balance projection + outbox in one transaction.
- Idempotency record returns the first result for a recognized retry.
- FX record preserving source amount, destination amount, quote, spread, source,
  timestamp, expiry (LED-05).
- Trial balance query by account class and asset.
- Projection rebuild routine: replay `ledger.entries` → `ledger.balances`.

**Ship lazily:** balances as a row-locked projection updated in the same
transaction, not an event-sourced read model. No partitioning (architecture §11.3).

**Defer:** provider holds and rolling reserves (LED-06) to W-Prov-3;
point-in-time statements (LED-07) to W10.

**Mandatory tests (architecture §20.1):** journal balances by asset; posted
entries cannot be edited or deleted; available balance cannot go negative;
concurrent authorizations cannot overspend; capture ≤ reservation; capture +
release = reservation; recognized retries create no value; projection rebuild
reproduces recorded balances.

**Acceptance:**
- fast-check property suite passes on conservation, rounding, and reversal.
- Testcontainers concurrency test: N parallel reservations against one balance
  never overspend and never deadlock beyond the retry bound.
- Trial balance produced by account class and currency.

### W3 — Catalog, price versions, quotes

**Delivers:** an enforceable maximum price before anything is reserved.

**Satisfies:** PRICE-01, PRICE-02, PRICE-03, PRICE-04 · **Depends on:** W1 · **Size:** M

**Build:**
- `catalog.services`, `catalog.capabilities`, `catalog.providers` — a customer
  capability ("summarize a document") is distinct from a provider model.
- `pricing.price_versions`, immutable, effective-dated. A transaction resolves
  forever to the version used at authorization.
- Quote calculation storing provider cost, Meter fee, tax, and FX basis so
  finance can reproduce the final price from stored inputs.
- `pricing.quotes` with hard maximum and configurable expiry; expired quotes
  cannot authorize.

**Ship lazily:** launch with 3–5 customer capabilities, not a model catalogue
(architecture §13.2). FX as a stored rate refreshed by a scheduled job, not a
live streaming rate.

**Defer:** volume tiers and provider minimums (PRICE-06) to W-Prov-2. Full
four-primitive support (PRICE-05) — `fixed` and `measured` ship here;
`time_based` lands in Stage 5 and `composite` when a service needs it.

**Acceptance:**
- A historical transaction resolves to its authorization-time price version.
- Authorization cannot reserve more than the displayed maximum.
- An expired quote is rejected with a stable machine-readable error code.
- Finance reproduces a stored quote's final price from its recorded inputs.

### W4 — Authorization and budgets

**Delivers:** the deny-by-default decision that precedes every provider call.

**Satisfies:** AUTH-01, AUTH-02, AUTH-03 · **Depends on:** W2, W3 · **Size:** M

**Build:**
- Decision pipeline: authentication → restriction state → KYC tier limit →
  daily/monthly budget → available balance → risk rules → reserve.
- `authz.budgets` for daily and monthly hard limits; `authz.decisions` recording
  actor, reason code, price version, and resulting ledger reference.
- Decline paths return stable machine-readable codes and invoke no provider.
- Risk rules (OPS-05) as a small ordered rule list: velocity, funding age,
  device, usage anomaly.

**Ship lazily:** risk rules as plain functions over a summary query, not a rules
engine or an ML model. Budgets as columns, not a policy DSL — the DSL arrives
with agent policies in Stage 2.

**Acceptance:**
- Insufficient funds decline with **no provider invocation** (assert the adapter
  was never called).
- Concurrent requests cannot overspend one available balance.
- Requests over a daily or monthly limit decline before provider invocation.
- Authorization p95 under 500 ms excluding external KYC (PRD §13.1).

### W5 — AI provider adapter and streamed execution

**Delivers:** the first vertical's provider integration.

**Satisfies:** Stage 1 P0 AI capabilities · **Depends on:** W3, W4 · **Size:** L
**Blocked by:** A3

**Build:**
- `AIProvider` port (`quote`, `execute`, `normalizeUsage`, `health`) in
  `adapters/ai-providers`; provider SDK types never leave the adapter.
- One primary provider direct, one secondary direct for fallback and coverage.
  OpenRouter for long-tail experiments only.
- SSE streaming in `products/ai`: forward chunks without buffering the full
  response; no database transaction is open while the stream runs.
- Fallback permitted only within the original maximum price, data policy,
  capability, and user expectation.
- Per-provider timeouts, bounded retries with jitter, circuit breaker,
  concurrency cap, monthly budget cap, redacted logging.
- Provider health, cost, latency, success, and quality telemetry per model.

**Ship lazily:** circuit breaker as a counter with a cooldown timestamp in
memory per instance, not a distributed breaker. `ponytail:` comment naming the
upgrade trigger (more than two API instances with divergent breaker state).

**Acceptance:**
- A provider success response alone never authorizes a charge.
- Stream survives provider mid-stream failure with zero charge if no value was produced.
- Fallback outside the approved maximum or data policy is refused.
- Time-to-first-token measured separately for provider and customer (architecture §13.4).

### W6 — Usage verification and capture

**Delivers:** the money-taking half of the canonical flow.

**Satisfies:** USE-01, USE-02, USE-03, USE-04, USE-05 · **Depends on:** W2, W5 · **Size:** M

**Build:**
- `usage.records` storing provider request, response status, measured usage, and
  delivery evidence — enough for support to judge delivery without reading prompts.
- Normalization from provider-reported usage to Meter billable units.
- Capture command capped at the reservation; over-report is capped *and flagged*.
- Immediate release of unused reserve on capture or failure.
- Zero charge when delivery fails before value is produced.
- Partial capture only for independently verifiable partial delivery, with the
  delivered unit named on the receipt.

**Acceptance:**
- Over-reported provider usage is capped at the reserve and raises an alert.
- Failure before value produces full release and a recorded failure reason.
- Available balance updates once the transaction reaches a financial terminal state.
- Receipt identifies the delivered unit and partial amount for partial capture.

### W7 — Transactional outbox and worker processing

**Delivers:** committed financial state never loses its downstream work.

**Satisfies:** FUND-03, SET-04 (idempotent retry foundation) · **Depends on:** W2 · **Size:** M

**Build:**
- Outbox dispatcher: claim pending rows with `SKIP LOCKED`, publish to pg-boss,
  mark sent, bounded retries with exponential backoff and jitter.
- Handlers for the nine queues already named in `platform/jobs/queues.ts`.
- Every handler idempotent, with dead-letter behaviour and an operations-visible
  failure reason.
- Split API and worker into separate Render processes (architecture §22.3).

**Ship lazily:** one dispatcher loop polling on an interval, not `LISTEN/NOTIFY`.
`ponytail:` comment naming the upgrade trigger (dispatch latency above the
notification SLA).

**Acceptance:**
- Killing the worker mid-handler and restarting produces no duplicate effect.
- A handler failing its retry budget dead-letters with a readable reason.
- Job work stays under 20% of primary database CPU (architecture §12.3 trigger).

### W8 — Naira funding

**Delivers:** real money in.

**Satisfies:** FUND-01, FUND-02, FUND-03, FUND-04, FUND-05 · **Depends on:** W2, W7 · **Size:** L
**Blocked by:** A1, A2

**Build:**
- Payment partner adapter behind a Meter-owned `FundingPort`.
- Funding intents; balance becomes spendable **only** after a signed or
  independently verified success notification.
- Pending / available / reserved / restricted balance composition reported
  identically by UI and ledger.
- Collection fees shown before payment confirmation — total paid and value credited.
- Independent reconciliation against the partner API, never trusting the webhook alone.
- Partner-compliant refund or redemption of eligible unused value producing a
  compensating entry plus external reference.

**Defer:** USDC deposits (FUND-06) until legally and commercially approved —
gated on A1. Safeguarded-funds coverage reporting (FUND-07) to W10.

**Acceptance:**
- Replaying one funding callback 100 times creates exactly one credit.
- A webhook alone never moves a balance; the command path does.
- Funding above the account's tier limit is refused.
- Fee disclosure precedes authorization of the collection.

### W9 — Settlement and revenue split

**Delivers:** allocation of every captured naira.

**Satisfies:** SET-01 · **Depends on:** W6 · **Size:** M

**Build:**
- At capture, allocate provider payable, Meter revenue, tax liability, and
  explicit settlement cost. Allocations equal the captured amount exactly.
- `settlement.payables` per provider with state machine and external reference.
- Circle/Arc/x402 adapter interface defined but not wired to a live chain —
  core transaction records carry no chain-specific identifiers (SET-07).

**Defer:** collaborator splits (SET-02), batching (SET-03), payout routes
(SET-05), and statements (SET-06) to Stage 3 — there are no third-party
providers to pay in Stage 1. Meter is the only payee.

**Acceptance:**
- Allocations total the captured amount after taxes and explicit costs.
- Split allocation test passes with zero residue (architecture §20.1).

### W10 — Reconciliation and operations

**Delivers:** proof that internal and external positions agree.

**Satisfies:** OPS-01, OPS-02, FUND-07, LED-07 · **Depends on:** W8, W9 · **Size:** L

**Build:**
- Daily reconciliation job matching partner collections, internal liabilities,
  provider payables, and settlement accounts.
- Unmatched material items automatically stop affected settlement batches.
- Transaction timeline for support: quote → authorization → delivery → capture →
  refund → settlement, correlated by one correlation id.
- Safeguarded-funds coverage report; an exception stops new settlement.
- Point-in-time balances and statements regenerated from journals, never from
  cached totals.
- Exception queue with owner, age, and financial exposure.

**Ship lazily:** operations views as server-rendered pages behind an operator
role on the existing API, not a separate admin application.

**Acceptance:**
- Daily reconciliation completes before the next settlement cycle (PRD §13.1).
- A seeded mismatch stops the affected batch and appears in the exception queue.
- A statement regenerated from journals equals the recorded balance.

### W11 — Refunds, restrictions, disputes, support

**Delivers:** the controlled paths that touch money after the fact.

**Satisfies:** OPS-03, OPS-04, ID-03, ID-04 · **Depends on:** W10 · **Size:** M

**Build:**
- Refunds as reason-coded compensating entries; the original capture is never
  altered and stays linked to its refund.
- Refund cannot exceed captured value minus earlier refunds (architecture §20.1).
- Dispute records with status, owner, deadline, and financial exposure.
- Account restriction, freeze, closure with evidence preservation.
- Support impersonation that can read a timeline but **cannot authorize spend or
  mutate financial records** (architecture §14.3).
- Customer-initiated refund and support request from a transaction.

**Acceptance:**
- Support impersonation is proven unable to authorize spend (negative test).
- Refund over the captured-minus-refunded ceiling is refused.
- Every operator financial action records operator identity and reason.

### W12 — Meter AI PWA

**Delivers:** the customer surface.

**Satisfies:** Stage 1 P0 application capabilities · **Depends on:** W3 onward (mockable) · **Size:** L

**Build:**
- Mobile-first responsive shell; installable manifest; service worker caching
  the shell and public assets **only** — never balances, quotes, receipts, KYC,
  or authenticated responses (architecture §6.1).
- Onboarding and passkey sign-in via Clerk primitives.
- Naira top-up with fee disclosure.
- Text chat and document analysis; model recommendation plus manual selection.
- Exact or maximum naira charge shown before execution; explicit authorization step.
- SSE stream presentation with a visible running maximum.
- Balance (available / pending / reserved), history, itemized receipt.
- Daily and monthly limit management.
- Refund and support initiation from a transaction.

**Ship lazily:** no state-management library — server state through fetch plus
React state. No component library until a second consumer exists (this is why
`packages/ui` is still empty).

**Defer:** image generation, audio transcription, curated workflows, saved
templates, export and retention controls — all PRD §9.2 P1, after launch.

**Acceptance (PRD §21 product):**
- A qualified user can create, recover, fund, spend, review, and close an account.
- Every paid service shows an exact or maximum naira price before authorization.
- Failed delivery results in zero charge or a verifiable partial charge.
- Daily and monthly hard limits cannot be bypassed by concurrent requests.
- No financial business logic exists in the client.

### W13 — Production infrastructure and observability

**Satisfies:** PRD §13.3, architecture §19, §21.2, §22.3 · **Depends on:** W7 · **Size:** M

**Build:**
- Separate API and worker services; at least two API instances.
- Neon paid plan with ≥7 days point-in-time recovery; nightly encrypted logical
  backup outside Neon; backup before every financial-schema deployment.
- Pino structured logs, OpenTelemetry server traces and metrics, Sentry.
- One correlation id across HTTP → quote → authorization → provider → usage →
  ledger → outbox → settlement → reconciliation.
- Alerts: authorization failure spikes, duplicate-event conflicts, ledger
  invariant violations, provider price/usage variance, provider timeouts, job
  dead letters, settlement failure, reconciliation gaps, database saturation,
  budget thresholds.
- Cost attribution per user, workflow, and provider; provider hard limits.

**Acceptance:**
- A single correlation id retrieves the full chain for one transaction.
- Logs contain no prompts, AI results, KYC data, secrets, or payment instruments.
- Critical financial incident acknowledgement path exercised within 15 minutes.

### W14 — Gates, concierge beta, public launch

**Depends on:** all of the above · **Size:** L (plus beta elapsed time)

**Pre-beta security gates (architecture §18.3):** threat model, secret rotation
process, signed webhook verification, ledger invariant suite, dependency and
vulnerability scanning, successful backup restoration.

**Pre-launch gates:** independent penetration test, OWASP ASVS review of core
journeys, incident-response exercise, partner and provider outage drills, DPIA,
production audit logging, restoration and reconciliation drill, SBOM and
container scan.

**Load testing (k6):** quote, authorization, history, webhook, and streaming paths.

**Recovery drill:** restore, replay outbox, rebuild projections, reconcile.
Spending stays paused until reconciliation succeeds.

**Stage 1 exit gate (PRD §9.2):** 200 funded users · ≥30% four-week funded-user
retention · median ≥10 paid uses per funded active user per week · positive
contribution margin · <2% payment-related support incidents · no unresolved
material compliance issue.

---

## 7. Stage 2 — Meter Agents

**Purpose:** controlled, auditable purchasing authority for software.

**Entry gate (PRD §9.3):** Stage 1 exit passed **and** 60 consecutive days with
zero unresolved ledger imbalance.

**Estimated effort:** 14–20 founder-weeks.

This is the first stage that forces real core work rather than a new surface.
Roughly 60% of it lands in `modules/core`, not `modules/products/agents`.

### Core work this stage forces

| WS | Delivers | Satisfies | Size |
| --- | --- | --- | --- |
| AG-1 | Organizations, workspaces, roles, least-privilege permissions | ID-05 | M |
| AG-2 | Scoped credential lifecycle: hashed, scoped, expiring, revocable; rotation and emergency freeze | AUTH-07, §18.2 | M |
| AG-3 | Policy engine: per-call, per-key, per-service, per-provider, daily, monthly, lifetime budgets | AUTH-04 | L |
| AG-4 | Provider and service allowlists | AUTH-05 | S |
| AG-5 | Human approval above a configured threshold; request parked until approval or expiry | AUTH-06 | M |
| AG-6 | Programmatic balances separate from consumer balances | FUND-02 extension | M |

**AG-3 is where a policy DSL finally earns its place.** Stage 1 budgets are two
columns. Seven independent limit dimensions with machine-readable denial reasons
is the measured need that justifies the abstraction — not before.

### Vertical work

| WS | Delivers | Size |
| --- | --- | --- |
| AG-7 | x402-compatible authorization and payment flow | L |
| AG-8 | Outbound webhooks with signature, retry, and replay tooling | M |
| AG-9 | Sandbox balances and endpoints | M |
| AG-10 | Transaction logs and downloadable audit records | S |
| AG-11 | Developer documentation and quickstart | M |

**x402 boundary:** the gateway translates an x402 payment requirement into a
Meter quote → authorization → reserve → capture. Chain identifiers stay in the
adapter. Customer balances are never on-chain (PRD §22, architecture §27).

**Ship lazily:** no client SDK in this stage — a documented REST surface plus
copy-pasteable examples. An SDK is Stage 3 work, when third-party providers
must integrate too.

**Security additions:** credential abuse and rotation tests, organization role
review, budget and allowlist bypass tests (architecture §18.3).

**Exit gate (PRD §9.3):** ≥10 active developer teams · ≥3 teams using Meter
weekly in production · ≥50,000 legitimate paid calls per month · <0.1%
unauthorized or duplicate charges · positive gross margin on agent transactions ·
≥60% of activated teams retained after eight weeks.

---

## 8. Stage 3 — Meter Providers

**Purpose:** third parties sell measurable units to Meter buyers.

**Entry gate (PRD §9.4):** Stage 2 exit passed **and** ≥5 prospective providers
have signed pilot commitments.

**Estimated effort:** 18–26 founder-weeks. This is the largest single stage:
it is the first time money flows *out* of Meter to parties who are not Meter.

### Core work this stage forces

| WS | Delivers | Satisfies | Size |
| --- | --- | --- | --- |
| PR-1 | Provider KYB and beneficiary verification; no payout before approval | ID-06 | L |
| PR-2 | Volume tiers and provider minimums | PRICE-06 | M |
| PR-3 | Provider holds and rolling reserves; held earnings visible but not withdrawable | LED-06 | M |
| PR-4 | Collaborator splits, percentage and fixed, totalling the distributable amount exactly | SET-02 | M |
| PR-5 | Settlement batching that never merges internal ownership | SET-03 | M |
| PR-6 | Idempotent settlement retry that cannot duplicate a payout | SET-04 | M |
| PR-7 | Payout routes: bank, approved USDC, partner-managed, filtered by jurisdiction and verification status | SET-05 | L |
| PR-8 | Provider statements reconciling to ledger accounts and payout references | SET-06 | M |
| PR-9 | Signed or authenticated provider usage events; unverifiable events cannot create captures | USE-06 | M |
| PR-10 | Usage, latency, and price variance anomaly detection with automatic disable or hold | USE-07 | M |
| PR-11 | Risk- and dispute-based payout holds recording rule, amount, duration, release condition | OPS-06 | M |
| PR-12 | Partner, accounting, tax, audit, and regulatory exports reproducing ledger totals | OPS-07 | M |
| PR-13 | Sanctions and risk screening from approved partners | ID-07 | M |

### Vertical work

| WS | Delivers | Size |
| --- | --- | --- |
| PR-14 | Provider portal: service and versioned price management | L |
| PR-15 | Hosted payment protection plus x402 integration for provider endpoints | L |
| PR-16 | Provider SDK | L |
| PR-17 | Sandbox and integration diagnostics | M |
| PR-18 | Earnings, refunds, disputes, statements UI | M |
| PR-19 | Provider health, failure, fraud, and dispute monitoring | M |

**Pre-stage security gates (architecture §18.3):** provider over-reporting
simulation, payout hold and recovery tests.

**The hard problem in this stage is trust asymmetry.** A provider reports its
own usage. PR-9 and PR-10 exist because a provider's success response is not
financial authority — the same rule already applied to AI providers in W5, now
applied to parties Meter does not control.

**Exit gate (PRD §9.4):** ≥20 approved providers · ≥10 earning monthly · ≥25%
of transaction value from third-party services · median integration ≤1 working
day · provider-side payment success ≥99.5% · no provider above 40% of
third-party transaction value.

---

## 9. Stage 4 — Meter Content

**Purpose:** individual premium content units bought by people and agents.

**Entry gate (PRD §9.5):** Stage 3 exit passed **and** 5 publishers committed to
a structured pilot with defined content and promotion.

**Estimated effort:** 10–14 founder-weeks.

### Core work this stage forces

| WS | Delivers | Size |
| --- | --- | --- |
| CT-1 | **Entitlements** — account-bound or time-limited rights to access a purchased unit | L |
| CT-2 | Publisher-configured free allowance and optional bundles | M |

CT-1 is the one genuinely new core concept in this stage. Every prior vertical
captures and ends; content captures and then must *keep answering* "may this
account access this unit?" for the entitlement's lifetime. It belongs in
`modules/core/entitlements`, not in the content vertical — Sessions and Physical
will both want it.

### Vertical work

| WS | Delivers | Size |
| --- | --- | --- |
| CT-3 | Publisher CMS plugin and API | L |
| CT-4 | Preview plus exact-price purchase flow | M |
| CT-5 | Agent-readable price and license metadata | M |
| CT-6 | x402 access for approved crawlers and agents | M |
| CT-7 | Contributor and rights-holder splits (reuses PR-4) | S |
| CT-8 | Publisher analytics by content, buyer type, and revenue | M |
| CT-9 | Refunds for unavailable or materially misrepresented content | S |

**Pricing primitive:** `fixed`. No new primitive needed.

**Exit gate (PRD §9.5):** ≥10,000 paid unlocks in pilot · ≥15% of buyers
repurchase within 30 days · publisher revenue materially exceeds publisher
integration and support cost · evidence of incremental revenue rather than
lower-value subscription substitution · no unresolved licensing or
crawler-enforcement blocker.

---

## 10. Stage 5 — Meter Sessions

**Purpose:** time-based billing for tutoring, coaching, support, consultation,
and live creators.

**Entry gate (PRD §9.6):** Stage 3 exit passed **and** ≥20 experts have
completed a manual billing pilot.

**Estimated effort:** 12–16 founder-weeks.

**Explicitly excluded from first release:** healthcare and legal marketplaces.
A verified platform in either may use Meter only after separate professional,
privacy, and liability review (PRD §9.6).

### Core work this stage forces

| WS | Delivers | Satisfies | Size |
| --- | --- | --- | --- |
| SE-1 | `time_based` pricing primitive end-to-end: quote, reserve maximum duration or spend, capture actual, release remainder | PRICE-05 | M |
| SE-2 | Long-running authorization: a reservation that stays open for the length of a session, not a request | — | L |

SE-2 is the real engineering content of this stage. Every prior vertical holds a
reservation for seconds. A session holds one for an hour across disconnects.
This forces: reservation expiry policy, mid-session top-up or hard stop, and
recovery when the client vanishes without ending the session.

### Vertical work

| WS | Delivers | Size |
| --- | --- | --- |
| SE-3 | Expert onboarding; payment link and embedded checkout | M |
| SE-4 | Rate, minimum charge, maximum session charge, cancellation policy | M |
| SE-5 | Pre-session authorization | S |
| SE-6 | Timer synchronized with session state; pause, resume, reconnect, end | L |
| SE-7 | Automatic stop when the approved limit is reached | M |
| SE-8 | Session evidence and itemized receipt | S |
| SE-9 | Cancellation, no-show, refund, and dispute handling | M |
| SE-10 | Expert earnings and payout (reuses PR-7, PR-8) | S |

**Ship lazily for SE-6:** the **server** clock is authoritative and the billable
clock advances only on heartbeats the server receives. A client-authoritative
timer is a billing dispute generator. Use a pg-boss scheduled job per active
session to enforce the cap, not a persistent socket per session.
`ponytail:` comment naming the upgrade trigger (scheduled-job latency visible to
customers at the cap boundary).

**Exit gate (PRD §9.6):** ≥50 active experts · ≥500 completed paid sessions ·
>70% of funded sessions complete successfully · dispute rate <2% · experts paid
faster or with fewer collection failures than before · positive contribution
margin after manual support.

---

## 11. Stage 6 — Meter Physical

**Purpose:** one metered physical service on existing certified hardware and
operator telemetry. Shared compound electricity is the leading hypothesis.

**Entry gate (PRD §9.7):** a qualified operator partner, compliant hardware,
written sector guidance, pilot economics, and one committed site.

**Estimated effort:** 16–24 founder-weeks, plus hardware and site lead time that
is not engineering effort.

**Hard constraint:** Meter will not manufacture hardware or directly control
safety-critical equipment without an approved hardware and operator interface
(PRD §9.7). Meter issues a *cutoff instruction*; the operator's certified
equipment acts on it.

### Core work this stage forces

| WS | Delivers | Size |
| --- | --- | --- |
| PH-1 | Signed, timestamped usage ingestion with device key management and rotation | L |
| PH-2 | Offline event buffering and idempotent recovery (PRD §10.6) | XL |
| PH-3 | Prepaid balance with a consumption limit and low-balance alerting | M |
| PH-4 | Tamper, drift, and anomaly detection | L |

**PH-2 is the hardest single workstream in the entire plan.** A meter that loses
connectivity for hours must, on reconnect, submit buffered readings that produce
exactly the right charge — no duplicates, no gaps, correct ordering, against a
balance that may have been spent elsewhere meanwhile. The existing idempotency
and outbox machinery is necessary but not sufficient: it must additionally
tolerate *retroactive* usage arriving after the balance moved.

Plan for it explicitly: buffered readings reconcile against a per-device
monotonic sequence and a device-local cumulative total, and a reading that would
overdraw a spent balance creates a recorded debt with an operator-visible
exception rather than a silent failure or a negative balance.

**Calibration is not optional.** A physical meter drifts, a clock skews, and a
tariff has boundaries the model will not guess. PH-1 stores the raw device
reading *and* the calibrated billable quantity separately, with the calibration
factor, its source, and its effective period recorded — so a disputed charge can
be recomputed from the raw reading, and a recalibration does not rewrite history.
PH-4's drift detection is meaningless without that stored baseline.

### Vertical work

| WS | Delivers | Size |
| --- | --- | --- |
| PH-5 | Operator, site, and tariff onboarding | L |
| PH-6 | Device and certified meter registration | M |
| PH-7 | Safe cutoff instruction path to operator equipment | L |
| PH-8 | Operator dashboard, settlement, and site reports | L |
| PH-9 | Manual fallback and evidence-based disputes | M |

**Architecture note:** PRD §24 and architecture §24.2 both flag high-volume
physical telemetry ingestion as the most likely first service extraction and the
first plausible case for Go. Do not pre-build it. Extract only when ingestion
sustains >40% of API or worker resources, per architecture §24.2.

**Exit gate (PRD §9.7):** ≥1 live pilot site and 50 paying users · usage variance
within the hardware partner's tolerance · collection leakage lower than the
operator's prior method · offline recovery produces no duplicate charges ·
installation, support, and integration costs recoverable within 12 months ·
applicable utility, payment, safety, and consumer requirements documented and satisfied.

---

## 12. Machine-to-machine commerce

Not a product and not a workstream (PRD §9.8). It is Meter Agents policies
applied to Meter Physical telemetry. A device marketplace may be *proposed* only
after independent devices repeatedly buy or sell through those existing products.
No engineering is planned for it here.

---

## 13. Cross-cutting tracks

These run continuously; they are not phases.

### 13.1 Testing ladder

Every workstream adds to the layer it touches (architecture §20).

| Layer | Tool | Added by |
| --- | --- | --- |
| Domain | Vitest | every workstream |
| Property | fast-check | W2, W6, W9, PR-4, PH-2 |
| Database integration | Testcontainers + PostgreSQL 18 | W2, W4, W7, W8 |
| Adapter contract | Vitest + provider sandbox fixtures | W5, W8, PR-9, PH-1 |
| API integration | Nest test harness | W4, W6, W8, AG-3 |
| Browser | Playwright | W12, SE-6 |
| Load | k6 | W14, AG-7 |
| Recovery | isolated restore scripts | W13, W14, PH-2 |
| Security | CodeQL, dependency and container scanners | CI, always |

The twelve mandatory financial tests (architecture §20.1) are a permanent CI
gate from W2 onward. A red financial test blocks merge; it is never skipped.

### 13.2 Security gate schedule

| Gate | Before |
| --- | --- |
| Threat model, secret rotation, signed webhook verification, ledger invariant suite, dependency scanning, backup restoration | concierge beta |
| Penetration test, OWASP ASVS review, incident-response exercise, outage drills, DPIA, production audit logging, restoration and reconciliation drill, SBOM, container scan | public launch |
| Credential abuse and rotation, org role review, budget and allowlist bypass, provider over-reporting simulation, payout hold and recovery | Stage 2 and Stage 3 |
| Device key compromise, replay, and tamper simulation | Stage 6 |

### 13.3 Supply-chain policy (standing)

Already enforced and verified in the repository: no dependency lifecycle scripts
execute at install, nothing published within 7 days resolves, the lockfile is
frozen in CI, actions are pinned by commit SHA, base images by digest, and pnpm
itself by corepack hash. Adding a dependency that needs a build script requires
reading that script and allowlisting the package in its own reviewed commit.

### 13.4 Cost control (standing)

Infrastructure ceilings by stage (architecture §23): $50–90/month at concierge
beta, $80–160 to 200 funded users, $200–500 at early public launch. Every
provider carries a monthly budget and alert threshold; AI calls require a
successful reservation first; preview resources and database branches expire
automatically.

### 13.5 Scaling triggers (standing)

Do not act before the measurement (architecture §24.1). In order: remove slow
queries → tune concurrency → add API replicas → increase database compute →
isolate job classes → reporting replica → Redis for a measured need → extract a
module → Go for a measured CPU workload → retained event streams. The ledger is
the last component ever split.

---

## 14. Effort summary

| Phase | Effort | Gated by |
| --- | ---: | --- |
| Stage 1 — Meter AI (W1–W14) | 28–40 fw | Track A |
| Stage 2 — Meter Agents | 14–20 fw | Stage 1 exit + 60 clean ledger days |
| Stage 3 — Meter Providers | 18–26 fw | Stage 2 exit + 5 provider pilots |
| Stage 4 — Meter Content | 10–14 fw | Stage 3 exit + 5 publisher pilots |
| Stage 5 — Meter Sessions | 12–16 fw | Stage 3 exit + 20 expert pilots |
| Stage 6 — Meter Physical | 16–24 fw | operator, hardware, guidance, site |

Stages 4 and 5 both depend only on Stage 3 and may be ordered by evidence rather
than by this list. Stage 6 is independent of 4 and 5 once Stage 3 has passed.

These are one-founder figures. They assume no parallel staffing, and they
exclude Track A elapsed time, beta duration, partner integration lead time, and
hardware procurement.

---

## 15. Risks in this plan

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Track A slips | Correct code cannot take real money | Sequence W1–W7 and W12 to be provable with mocked providers; only W8 hard-blocks |
| Release PRD changes Stage 1 scope | Workstream contents shift | Order is derived from data dependencies, not copy; expect churn inside workstreams, not between them |
| Stage 2 arrives before core is ready | Agent policies bolted onto two budget columns | AG-1..AG-6 are core work and are listed first for that reason |
| PH-2 offline recovery underestimated | Duplicate or missing physical charges | Sized XL, given its own invariant tests, and gated behind a pilot site |
| Provider self-reported usage trusted | Silent overcharging at scale | USE-06, USE-07, PR-9, PR-10; a success response is never financial authority |
| Solo-founder concentration | Every stage serialises | Effort is stated in founder-weeks so staffing decisions are explicit |
| Effort figures read as dates | Calendar commitments the gates do not support | PRD §22: evidence gates, not calendar promises |

---

## 16. Open decisions needing founder input

1. **Release-level Meter AI PRD (A5).** This plan assumes PRD §9.2 P0 scope
   verbatim. Confirm or supersede before W12 detail is fixed.
2. **Primary and secondary AI providers.** W5 cannot start without A3, and the
   fallback design depends on which two providers permit resale.
3. **Payment partner.** W8's adapter shape, funding latency, refund mechanics,
   and safeguarding model all follow from A2.
4. **Stage 4 vs Stage 5 ordering.** Both unlock at Stage 3 exit. Decide by which
   pilot cohort materialises, not by this document's order.
5. **Sanctions screening timing (ID-07).** Deferred to Stage 2 here; the payment
   partner may require it at Stage 1.
6. **Entitlements ownership (CT-1).** Planned as core. Confirm before Stage 4,
   because Sessions and Physical both depend on that choice.

---

## Approval record

Drafted 2026-09-20 against the master PRD and technology architecture of the
same date. Not yet reviewed. PRD §23.7 expects this plan to follow an approved
release-level Meter AI PRD; it was produced ahead of that document at the
founder's direction and should be re-read against it once approved.
