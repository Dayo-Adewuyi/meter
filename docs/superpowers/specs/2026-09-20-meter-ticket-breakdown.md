# Meter Ticket Breakdown

**Status:** Draft for founder review

**Date:** 2026-09-20

**Owner:** Founder / CTO

**Companion to:** [`implementation plan`](2026-09-20-meter-implementation-plan.md) · [`master PRD`](2026-09-20-meter-master-platform-prd.md) · [`technology architecture`](2026-09-20-meter-technology-architecture-design.md)

---

## 1. How to use this

One row is one pull request. A ticket that cannot be reviewed in a sitting is
split before it is started.

**Granularity is deliberately uneven.** Stage 1 and Stage 2 tickets are cut to
PR size because that work is knowable now. Stage 3–6 tickets are cut at feature
grain and marked provisional: their inputs — provider pilots, publisher
commitments, expert cohorts, an operator partner and certified hardware — do not
exist yet, and ticket-level precision there would be invented. Re-cut each of
those stages when its entry gate opens.

### 1.1 Sizing

| Size | Effort |
| --- | --- |
| XS | under half a day |
| S | half a day to one day |
| M | one to three days |
| L | three to five days |

Nothing larger than L exists. If a ticket grows past L in progress, split it and
record the split.

### 1.2 Conventions

- **ID** is `<workstream>-<nn>`. Stable once assigned; never renumber.
- **Deps** lists only hard blockers, not soft ordering preferences.
- **Done when** is the merge condition. Code existing is not the merge condition.
- Every ticket touching money merges with its tests in the same PR.
- A ticket marked **A2** / **A3** is blocked on a Track A external dependency
  (implementation plan §5) and cannot be started regardless of code readiness.

---

## 2. Stage 1 — Meter AI

### W1 — Identity, access, and account state

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W1-01 | `identity.users` and `identity.external_identities` migration | S | — | Internal UUIDv7 primary key; Clerk subject unique; table is the FK target for all financial tables |
| W1-02 | `AuthenticatorPort` interface and Clerk adapter | M | W1-01 | Token verification and user fetch behind the port; no Clerk type escapes `adapters/auth` |
| W1-03 | Request guard resolving internal user, roles, restriction state | M | W1-02 | Every authenticated route has internal user id, role, and restriction state; deny by default |
| W1-04 | Shared webhook verification middleware | M | — | Raw body preserved, signature verified, timestamp window enforced, external event id stored under unique constraint; reused unchanged by W8-03 |
| W1-05 | Clerk webhook handler for user lifecycle events | M | W1-04 | Create/update/delete applied idempotently; replay produces one mutation |
| W1-06 | `compliance.kyc_tiers` and tier limit lookup | S | W1-01 | Tier and partner-defined limits readable in one query on the authorization path |
| W1-07 | `compliance.account_restrictions` and restriction enforcement | S | W1-03 | Restricted account cannot authorize new spend; history stays readable to staff |
| W1-08 | `operations.audit_log` append-only plus operator action helper | S | W1-01 | Append-only enforced in SQL; helper records operator identity and reason |
| W1-09 | Step-up authentication on privileged operator routes | M | W1-08 | Refund, limit change, and freeze routes require step-up and record the operator |
| W1-10 | W1 acceptance tests | M | W1-05, W1-07 | Webhook replayed 100× produces one mutation; restricted account declined; over-tier spend blocked before authorization |

### W2 — Ledger commands and reservations

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W2-01 | Account taxonomy and seeded chart of accounts | M | W1-01 | Customer available/reserved/pending liability, provider payable, Meter revenue, tax liability, external cash, and reserve classes exist and are seeded |
| W2-02 | `ledger.idempotency` records | M | W2-01 | Scope, key, request digest, and first result stored; recognized retry returns the original result |
| W2-03 | `postJournal` primitive | L | W2-02 | Validates balance by asset, writes transaction, entries, balance projection, and outbox row in one serializable transaction |
| W2-04 | `reserve` command | M | W2-03 | Moves available → reserved atomically; refuses to make available negative |
| W2-05 | `capture` command | M | W2-04 | Captures no more than the remaining reservation; over-request is capped, not rejected silently |
| W2-06 | `release` command | S | W2-04 | Returns unused reserve; capture + release equals the original reservation |
| W2-07 | `reverse` command | M | W2-03 | Writes a compensating journal linked by `reversal_of`; original is untouched |
| W2-08 | `refund` command | M | W2-05 | Ceiling is captured minus prior refunds; exceeding it is refused |
| W2-09 | `credit` and `debit` commands | S | W2-03 | Funding and controlled adjustment paths post balanced journals |
| W2-10 | FX record and rate capture | M | W2-03 | Source amount, destination amount, quote, spread, source, timestamp, and expiry stored; every conversion reconstructible |
| W2-11 | Trial balance by account class and asset | S | W2-01 | Finance can produce a trial balance for any period |
| W2-12 | Balance projection rebuild routine | M | W2-03 | Replaying `ledger.entries` reproduces `ledger.balances` exactly |
| W2-13 | fast-check property suite | L | W2-08 | Conservation, rounding, and reversal properties hold across generated inputs |
| W2-14 | Testcontainers concurrency suite | M | W2-04 | N parallel reservations against one balance never overspend and settle within the retry bound |
| W2-15 | Mandatory financial tests wired as a CI gate | M | W2-13, W2-14 | All eight applicable tests from architecture §20.1 run on every PR and block merge when red |

### W3 — Catalog, price versions, quotes

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W3-01 | `catalog.providers`, `catalog.services`, `catalog.capabilities` | S | W1-01 | A customer capability is representable independently of the provider model that serves it |
| W3-02 | `pricing.price_versions`, immutable and effective-dated | M | W3-01 | Updates to a published version are refused in SQL |
| W3-03 | FX rate store and scheduled refresh | M | W2-10 | Rate, source, and fetch time stored; refresh runs as a scheduled job |
| W3-04 | Quote calculation | L | W3-02, W3-03 | Provider cost, Meter fee, tax, and FX basis stored; finance reproduces the final naira price from stored inputs |
| W3-05 | `pricing.quotes` with hard maximum and expiry | M | W3-04 | Expired quote cannot authorize; rejection uses a stable machine-readable code |
| W3-06 | Seed the three to five launch capabilities | S | W3-02 | Launch capability set priced and active |
| W3-07 | W3 acceptance tests | M | W3-05 | Historical transaction resolves its authorization-time version; expired quote refused; stored price reproducible |

### W4 — Authorization and budgets

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W4-01 | `authz.budgets` daily and monthly limits | S | W1-06 | Limits readable and editable with an audited operator action |
| W4-02 | `authz.decisions` record | S | W1-08 | Actor, reason code, price version, and resulting ledger reference recorded per decision |
| W4-03 | Ordered decision pipeline with stable error codes | M | W4-02 | Checks run in the documented order; every decline returns a stable machine-readable code |
| W4-04 | Balance check and reserve integration | M | W4-03, W2-04 | Insufficient funds declines and reserves nothing |
| W4-05 | Daily and monthly limit enforcement | M | W4-01 | Over-limit requests decline before any provider invocation |
| W4-06 | Risk rules: velocity, funding age, device, usage anomaly | M | W4-03 | Rules run as ordered functions over a summary query; each can step up, decline, or flag for review |
| W4-07 | W4 acceptance tests | M | W4-05 | Spy proves the provider adapter is never called on decline; concurrent requests cannot overspend; authorization p95 under 500 ms excluding KYC |

### W5 — AI provider adapter and streamed execution

Blocked by **A3** (model-provider commercial terms).

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W5-01 | `AIProvider` port and shared fixtures | S | — | `quote`, `execute`, `normalizeUsage`, `health` defined; fixtures drive contract tests |
| W5-02 | Primary provider adapter | L | W5-01, A3 | All four port methods implemented; no provider SDK type leaves the adapter |
| W5-03 | Secondary provider adapter | M | W5-01, A3 | Fallback and capability coverage for the launch capability set |
| W5-04 | OpenRouter adapter for experiments only | S | W5-01 | Reachable behind a flag; excluded from customer-facing capabilities |
| W5-05 | Outbound call policy wrapper | L | W5-01 | Timeout, bounded retry with jitter, circuit breaker, concurrency cap, monthly budget cap, and redacted logging applied to every adapter call |
| W5-06 | SSE execution endpoint in `products/ai` | L | W5-02, W4-04 | Chunks forwarded without buffering the full response; no database transaction open while the stream runs |
| W5-07 | Fallback policy enforcement | M | W5-03, W5-06 | Fallback outside the original maximum price, data policy, or capability is refused |
| W5-08 | Provider telemetry by model | M | W5-05 | Cost, latency, success, quality, and normalized usage tracked per provider and model |
| W5-09 | W5 acceptance tests | M | W5-07 | Mid-stream provider failure charges zero when no value was produced; a provider success response alone never authorizes a charge |

### W6 — Usage verification and capture

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W6-01 | `usage.records` migration | S | W5-06 | Provider request, response status, measured usage, and delivery evidence stored without unnecessary prompt content |
| W6-02 | Usage normalization to billable units | M | W6-01 | Each provider's reported usage maps to Meter billable units through the adapter |
| W6-03 | Capture orchestration | M | W6-02, W2-05 | Normalize, cap, capture, release remainder, reach a financial terminal state |
| W6-04 | Over-report cap and alert | S | W6-03 | A provider reporting above the reservation is capped and raises an alert |
| W6-05 | Zero-charge failure path | S | W6-03 | Failure before value produces full release and a recorded failure reason |
| W6-06 | Partial capture with verifiable partial delivery | M | W6-03 | Receipt names the delivered unit and the partial amount |
| W6-07 | W6 acceptance tests | M | W6-06 | Capture never exceeds reservation; capture plus release equals reservation; over-report capped and alerted |

### W7 — Transactional outbox and worker processing

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W7-01 | Outbox dispatcher with `SKIP LOCKED` claim | M | W2-03 | Claims pending rows, publishes to pg-boss, marks sent, retries with exponential backoff and jitter |
| W7-02 | Queue registration for the nine queues | S | W7-01 | Every queue named in `platform/jobs/queues.ts` has a registered consumer |
| W7-03 | Handler base: idempotency, retry budget, dead letter | M | W7-02 | Each handler is idempotent, bounded, and dead-letters with an operations-visible reason |
| W7-04 | Split API and worker Render services | S | W7-03 | Two processes deploy from one image with different commands |
| W7-05 | W7 acceptance tests | M | W7-03 | Killing the worker mid-handler and restarting produces no duplicate effect; dead-letter reason is readable |

### W8 — Naira funding

Blocked by **A1** (legal advice) and **A2** (licensed partner).

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W8-01 | `FundingPort` interface and sandbox adapter | M | A2 | Partner sandbox reachable behind a Meter-owned port |
| W8-02 | `funding.intents` and create-intent command | M | W8-01 | Intent records amount, fees, and partner reference before any payment |
| W8-03 | Partner webhook handler | M | W1-04, W8-02 | Reuses shared verification unchanged; external event id stored under a unique constraint |
| W8-04 | Verified event to credit command via outbox | M | W8-03, W7-03 | A webhook never moves a balance directly; the command path does |
| W8-05 | Balance composition accessor and API | M | W2-11 | Pending, available, reserved, and restricted reported identically by ledger and API |
| W8-06 | Fee disclosure before confirmation | S | W8-02 | Total paid and value credited shown before the collection is authorized |
| W8-07 | Independent reconciliation against the partner API | M | W8-04 | Funding state verified against the partner, not only against its webhook |
| W8-08 | Refund and redemption of eligible unused value | M | W2-08 | Produces a compensating entry plus an external reference |
| W8-09 | Tier limit enforcement on funding | S | W1-06 | Funding above the account tier is refused |
| W8-10 | W8 acceptance tests | M | W8-07 | One callback replayed 100× creates exactly one credit |

### W9 — Settlement and revenue split

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W9-01 | Allocation at capture | M | W6-03 | Provider payable, Meter revenue, tax liability, and explicit settlement cost total the captured amount exactly |
| W9-02 | `settlement.payables` and state machine | M | W9-01 | Payable states and external references tracked per provider |
| W9-03 | Chain adapter interface, unwired | S | — | Interface defined; no chain-specific identifier appears in a core transaction record |
| W9-04 | W9 acceptance tests | S | W9-01 | Split allocation leaves zero residue |

### W10 — Reconciliation and operations

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W10-01 | Daily reconciliation job | L | W8-07, W9-02 | Partner collections, internal liabilities, provider payables, and settlement accounts matched daily |
| W10-02 | Exception queue and automatic batch stop | M | W10-01 | Unmatched material items stop affected settlement batches and surface with owner, age, and exposure |
| W10-03 | Transaction timeline by correlation id | M | W13-04 | Quote, authorization, delivery, capture, refund, and settlement retrievable as one timeline |
| W10-04 | Safeguarded-funds coverage report | M | W10-01 | Daily report proves coverage or stops new settlement |
| W10-05 | Point-in-time statements from journals | M | W2-12 | Statement regenerated from journals equals the recorded balance, with no reliance on cached totals |
| W10-06 | Operator views behind an operator role | L | W10-03 | Server-rendered pages on the existing API; no separate admin application |
| W10-07 | W10 acceptance tests | M | W10-02 | A seeded mismatch stops the affected batch and appears in the exception queue |

### W11 — Refunds, restrictions, disputes, support

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W11-01 | Reason-coded refund command | M | W2-08 | Original capture unchanged and linked to its refund; ceiling enforced |
| W11-02 | Dispute records | M | W10-03 | Status, owner, deadline, and financial exposure visible |
| W11-03 | Restriction, freeze, and closure with evidence preservation | M | W1-07 | Restricted accounts cannot authorize; records remain accessible to authorized staff |
| W11-04 | Support impersonation scope | M | W1-09 | Impersonation reads a timeline and cannot authorize spend or mutate financial records |
| W11-05 | Customer-initiated refund and support request | M | W11-01 | Initiated from a transaction in the PWA |
| W11-06 | W11 acceptance tests | S | W11-04 | Negative test proves impersonation cannot authorize spend; refund ceiling enforced |

### W12 — Meter AI PWA

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W12-01 | App shell, manifest, service worker | M | — | Service worker caches shell and public assets only; no balance, quote, receipt, KYC, or authenticated response is cached |
| W12-02 | Passkey onboarding and recovery | M | W1-02 | A user creates an account and recovers on a new device |
| W12-03 | Top-up flow with fee disclosure | M | W8-06 | Total paid and value credited shown before authorizing the collection |
| W12-04 | Capability picker with recommendation and manual selection | M | W3-06 | User can accept the recommendation or choose explicitly |
| W12-05 | Quote review and explicit authorization step | M | W3-05 | Exact or maximum naira charge shown before execution; authorization is a deliberate action |
| W12-06 | Stream presentation with running maximum | L | W5-06 | Output streams while the approved maximum stays visible |
| W12-07 | Balance view | S | W8-05 | Available, pending, and reserved shown and matching the ledger |
| W12-08 | History and itemized receipt | M | W6-06 | Receipt identifies the delivered unit and final charge |
| W12-09 | Limit management | S | W4-01 | Daily and monthly limits viewable and editable |
| W12-10 | Refund and support initiation from a transaction | S | W11-05 | Reachable from any eligible transaction |
| W12-11 | Document analysis upload path | L | W5-06 | Upload enters a quarantine prefix, type and content validated independently of browser metadata, access via short-lived signed URL |
| W12-12 | Playwright critical journeys | L | W12-10 | Onboarding, funding, AI use, limits, receipt, and refund initiation pass |
| W12-13 | Client purity check | S | W12-05 | A test or lint rule fails the build if monetary arithmetic or `number` money appears in the client |

### W13 — Production infrastructure and observability

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W13-01 | Split services and two API instances | S | W7-04 | API and worker run as separate services; at least two API instances serve traffic |
| W13-02 | Neon paid plan, PITR, external encrypted backup | M | — | Seven days point-in-time recovery plus a nightly encrypted logical backup outside Neon |
| W13-03 | OpenTelemetry traces and metrics, Sentry | M | — | Server traces and metrics exported; browser and server exceptions captured |
| W13-04 | Correlation id propagation | M | W13-03 | One id spans HTTP, quote, authorization, provider request, usage, ledger, outbox, settlement, and reconciliation |
| W13-05 | Alert rules | M | W13-03 | All ten alert conditions from architecture §19.3 fire and route |
| W13-06 | Cost attribution and provider hard limits | M | W5-08 | Cost attributed by user, workflow, and provider; provider hard limits enforced |
| W13-07 | Log redaction test | S | W13-03 | Test fails if prompts, AI results, KYC data, secrets, or payment instruments reach logs |

### W14 — Gates, concierge beta, public launch

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| W14-01 | Threat model | M | — | Documented and reviewed before beta |
| W14-02 | Secret rotation process and runbook | S | — | Rotation exercised once end to end |
| W14-03 | Backup restoration drill | M | W13-02 | Restore into an isolated database succeeds |
| W14-04 | k6 load suite | L | W12-06 | Quote, authorization, history, webhook, and streaming paths measured against §13.1 targets |
| W14-05 | Recovery drill | L | W14-03 | Restore, outbox replay, projection rebuild, and reconciliation complete; spending stays paused until reconciliation succeeds |
| W14-06 | Independent penetration test and remediation | L | W12-12 | High-severity findings resolved |
| W14-07 | OWASP ASVS review of core journeys | M | W14-06 | Core journeys reviewed and gaps closed |
| W14-08 | Incident response exercise | M | W13-05 | Runbooks exercised; critical financial acknowledgement inside 15 minutes |
| W14-09 | Data Privacy Impact Assessment | M | A1 | Completed and approved |
| W14-10 | SBOM and container scan in CI | S | — | Generated per release and scanned |
| W14-11 | Concierge beta operations tooling | M | W10-06 | Cohort tracking and manual intervention paths ready |
| W14-12 | Stage 1 exit gate instrumentation | M | W13-06 | Funded users, retention, uses per active user, contribution margin, and support incident rate all measurable from first-party events |

---

## 3. Stage 2 — Meter Agents

Entry gate: Stage 1 exit passed and 60 consecutive days with zero unresolved
ledger imbalance. Core tickets (AG1–AG6) precede vertical tickets (AG7–AG11).

### AG-1 — Organizations, workspaces, roles

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG1-01 | `identity.organizations` and membership migration | S | W1-01 | A user belongs to zero or more organizations with a role |
| AG1-02 | Role and permission model, least privilege | M | AG1-01 | Billing, developer, and read-only roles grantable independently |
| AG1-03 | Organization scoping on every financial read and command | L | AG1-02 | No cross-organization read or command is possible; proven by negative tests |
| AG1-04 | Organization administration UI | M | AG1-02 | Administrators can invite, assign roles, and revoke |
| AG1-05 | AG-1 acceptance tests | M | AG1-03 | Role separation and cross-organization isolation hold |

### AG-2 — Scoped credential lifecycle

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG2-01 | Credential store: hashed, scoped, expiring | M | AG1-01 | Only a hash is stored; scope and expiry are enforced at authentication |
| AG2-02 | Credential authentication path | M | AG2-01 | Machine requests authenticate without a browser session |
| AG2-03 | Rotation and revocation | M | AG2-02 | Revoked credentials fail on their next authorization attempt |
| AG2-04 | Emergency organization freeze | S | AG2-03 | One action halts all credentials for an organization |
| AG2-05 | AG-2 acceptance tests | M | AG2-04 | Credential abuse, rotation, and revocation scenarios pass |

### AG-3 — Policy engine

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG3-01 | Policy schema: per-call, per-key, per-service, per-provider, daily, monthly, lifetime | L | AG2-01 | Seven limit dimensions expressible and stored |
| AG3-02 | Policy evaluation in the authorization pipeline | L | AG3-01, W4-03 | Evaluation is ordered, deny-by-default, and short-circuits on first denial |
| AG3-03 | Machine-readable denial reasons | M | AG3-02 | Every denial names the violated dimension and limit |
| AG3-04 | Policy administration UI and API | M | AG3-01 | Policies editable with an audited action |
| AG3-05 | AG-3 acceptance tests | L | AG3-03 | Each dimension independently blocks; bypass attempts fail |

### AG-4 — Allowlists

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG4-01 | Provider and service allowlist storage and evaluation | S | AG3-02 | Credentials cannot purchase from an unlisted target |
| AG4-02 | AG-4 acceptance tests | XS | AG4-01 | Bypass attempt denied with a machine-readable reason |

### AG-5 — Human approval threshold

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG5-01 | Parked-request state and storage | M | AG3-02 | Request above threshold remains unexecuted pending approval or expiry |
| AG5-02 | Approval and rejection actions with audit | M | AG5-01 | Approver identity and reason recorded |
| AG5-03 | Expiry of unapproved requests | S | AG5-01 | Unapproved requests expire and release any hold |
| AG5-04 | AG-5 acceptance tests | S | AG5-03 | No execution occurs before approval; expiry releases cleanly |

### AG-6 — Programmatic balances

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG6-01 | Organization-owned ledger accounts | M | AG1-01, W2-01 | Organization balances separate from consumer balances in the chart of accounts |
| AG6-02 | Funding and allocation to programmatic balances | M | AG6-01, W8-04 | Organizations fund and allocate to credentials or workspaces |
| AG6-03 | AG-6 acceptance tests | S | AG6-02 | Balance composition reconciles across consumer and organization accounts |

### AG-7 to AG-11 — Vertical work

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| AG7-01 | x402 payment-requirement parsing and response | L | AG3-02 | An x402 challenge maps to a Meter quote |
| AG7-02 | x402 authorize, reserve, capture flow | L | AG7-01, W6-03 | Full canonical flow driven from an x402 request |
| AG7-03 | Chain identifier containment audit | S | AG7-02 | No chain-specific identifier appears in a core transaction record |
| AG7-04 | AG-7 acceptance and load tests | L | AG7-02 | x402 path passes k6 at target rate with correct financial outcomes |
| AG8-01 | Outbound webhook delivery with signing | M | W7-03 | Signed, retried, replay-safe delivery to developer endpoints |
| AG8-02 | Webhook management and replay tooling | M | AG8-01 | Developers can inspect, retry, and rotate secrets |
| AG9-01 | Sandbox balances and endpoints | M | AG6-01 | Sandbox spend cannot touch production accounts |
| AG9-02 | Sandbox parity tests | M | AG9-01 | Sandbox and production flows diverge only in settlement |
| AG10-01 | Transaction logs and downloadable audit records | S | AG1-03 | Organization can export which credential bought what and why |
| AG11-01 | Developer documentation and quickstart | M | AG7-02 | A developer completes a first paid call from documentation alone |
| AG11-02 | Documented REST surface and examples | M | AG11-01 | No client SDK; copy-pasteable examples cover the primary flows |

---

## 4. Stages 3–6 — provisional

**These tickets are cut at feature grain and will be re-cut when each stage's
entry gate opens.** Their inputs do not exist yet: signed provider pilots,
publisher commitments, an expert cohort, an operator partner with certified
hardware. Sizes here are planning inputs, not estimates to hold anyone to.

### 4.1 Stage 3 — Meter Providers

Core tickets first; the vertical cannot ship before them.

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| PR1-01 | Provider KYB data model and workflow | L | W1-01 | No provider can receive a payout before approval |
| PR1-02 | Beneficiary verification | M | PR1-01 | Payout beneficiaries verified and linked to an approved provider |
| PR2-01 | Volume tiers and provider minimums | M | W3-02 | Applied tier visible in the provider statement |
| PR3-01 | Provider holds and rolling reserves | M | W2-01 | Held earnings visible and auditable but not withdrawable |
| PR4-01 | Percentage and fixed collaborator splits | M | W9-01 | Split allocations total the distributable amount exactly, zero residue |
| PR5-01 | Settlement batching preserving internal ownership | M | W9-02 | Every batch amount maps to its underlying payables |
| PR6-01 | Idempotent settlement retry | M | PR5-01 | Retrying a failed settlement cannot duplicate a payout |
| PR7-01 | Payout route abstraction | L | PR1-02 | Bank, approved USDC, and partner-managed routes behind one port |
| PR7-02 | Jurisdiction and verification route filtering | M | PR7-01 | A provider sees only routes permitted for its status |
| PR8-01 | Provider statements | M | PR5-01 | Gross value, refunds, fees, taxes, holds, and net payout reconcile to ledger accounts |
| PR9-01 | Signed provider usage event ingestion | M | W1-04 | Unverifiable events cannot create captures |
| PR10-01 | Usage, latency, and price variance detection | M | W13-05 | Anomalous services auto-disabled or held for review |
| PR11-01 | Risk and dispute payout holds | M | PR3-01 | Hold records rule, amount, duration, and release condition |
| PR12-01 | Partner, accounting, tax, audit, regulatory exports | M | W10-05 | Exports reproduce ledger totals for the requested period |
| PR13-01 | Sanctions and risk screening integration | M | W1-06 | A matched account enters review without exposing screening detail to unauthorized staff |
| PR14-01 | Provider portal: service management | L | PR1-01 | Providers define services and billable units |
| PR14-02 | Provider portal: versioned price management | L | W3-02 | Providers publish immutable price versions |
| PR15-01 | Hosted payment protection for provider endpoints | L | AG7-02 | A provider protects an endpoint without building settlement |
| PR15-02 | Provider-side x402 integration | L | PR15-01 | x402 challenge issued and settled through Meter |
| PR16-01 | Provider SDK | L | PR15-01 | Median integration under one working day in pilot |
| PR17-01 | Sandbox and integration diagnostics | M | AG9-01 | A provider can self-diagnose a failed integration |
| PR18-01 | Earnings, refunds, disputes, statements UI | M | PR8-01 | Providers self-serve their financial position |
| PR19-01 | Provider health, failure, fraud, dispute monitoring | M | PR10-01 | Provider-side payment success measurable against the 99.5% gate |
| PR-SEC | Over-reporting simulation and payout hold/recovery tests | L | PR11-01 | Both security gates from architecture §18.3 pass |

### 4.2 Stage 4 — Meter Content

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| CT1-01 | `core/entitlements` data model | L | W2-01 | Account-bound and time-limited entitlements representable |
| CT1-02 | Entitlement grant at capture | M | CT1-01, W6-03 | A successful capture grants its entitlement in the same transaction |
| CT1-03 | Entitlement check API | M | CT1-01 | "May this account access this unit?" answered for the entitlement lifetime |
| CT1-04 | Entitlement expiry and revocation | M | CT1-03 | Expiry and refund-driven revocation both work |
| CT2-01 | Publisher free allowance and bundles | M | CT1-02 | Publisher-configured allowance consumed before charging |
| CT3-01 | Publisher CMS plugin | L | CT1-03 | A publisher protects content without custom integration |
| CT3-02 | Publisher API | L | CT3-01 | Programmatic content and price management |
| CT4-01 | Preview and exact-price purchase flow | M | W12-05 | Buyer sees preview and exact price before authorizing |
| CT5-01 | Agent-readable price and license metadata | M | CT4-01 | An agent can discover price and licence terms programmatically |
| CT6-01 | x402 access for approved crawlers and agents | M | AG7-02, CT5-01 | Approved agents buy access without a browser |
| CT7-01 | Contributor and rights-holder splits | S | PR4-01 | Reuses provider split machinery unchanged |
| CT8-01 | Publisher analytics | M | CT4-01 | Revenue by content, buyer type, and period |
| CT9-01 | Refunds for unavailable or misrepresented content | S | W11-01 | Refund revokes the entitlement |

### 4.3 Stage 5 — Meter Sessions

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| SE1-01 | `time_based` pricing primitive | M | W3-04 | Quote reserves maximum duration or spend; capture bills actual; remainder released |
| SE1-02 | `composite` primitive if a session needs a base fee | M | SE1-01 | Base plus maximum variable amount reserved |
| SE2-01 | Long-lived reservation model | L | W2-04 | A reservation survives for the length of a session, not a request |
| SE2-02 | Reservation expiry and mid-session top-up or hard stop | L | SE2-01 | An exhausted reservation stops the session or accepts an authorized top-up |
| SE2-03 | Abandoned-session recovery | L | SE2-02 | A client that vanishes without ending the session settles correctly from the server clock |
| SE3-01 | Expert onboarding | M | PR1-01 | Experts onboard through the provider KYB path |
| SE3-02 | Payment link and embedded checkout | M | SE1-01 | A buyer authorizes before a session starts |
| SE4-01 | Rate, minimum charge, maximum charge, cancellation policy | M | SE1-01 | Expert-configured and enforced at authorization |
| SE5-01 | Pre-session authorization | S | SE3-02 | No session starts unauthorized |
| SE6-01 | Server-authoritative billable clock | L | SE2-01 | The billable clock advances only on heartbeats the server receives |
| SE6-02 | Pause, resume, reconnect, end controls | L | SE6-01 | State transitions recorded with actor and timestamp |
| SE7-01 | Automatic stop at the approved limit | M | SE6-01 | Session ends at the cap without exceeding the authorized maximum |
| SE8-01 | Session evidence and itemized receipt | S | SE7-01 | Receipt shows billable minutes and their basis |
| SE9-01 | Cancellation, no-show, refund, dispute handling | M | W11-02 | Policy-driven outcomes with compensating entries |
| SE10-01 | Expert earnings and payout | S | PR7-01 | Reuses provider payout routes unchanged |

### 4.4 Stage 6 — Meter Physical

| ID | Ticket | Size | Deps | Done when |
| --- | --- | --- | --- | --- |
| PH1-01 | Device identity and key registration | M | W1-01 | Each device has a registered key with a rotation path |
| PH1-02 | Signed, timestamped reading ingestion | L | PH1-01 | Unsigned or stale readings are refused |
| PH1-03 | Raw reading and calibrated quantity stored separately | M | PH1-02 | Calibration factor, its source, and effective period stored; a disputed charge recomputable from the raw reading |
| PH1-04 | Recalibration without rewriting history | M | PH1-03 | A new calibration applies forward only |
| PH2-01 | Per-device monotonic sequence and cumulative total | L | PH1-02 | Gaps and duplicates detectable from the device's own sequence |
| PH2-02 | Offline buffer ingestion and ordering | L | PH2-01 | Buffered readings submitted on reconnect land in correct order |
| PH2-03 | Retroactive usage against a moved balance | L | PH2-02, W2-05 | A reading that would overdraw creates a recorded debt and an operator exception, never a silent failure or negative balance |
| PH2-04 | Offline recovery invariant suite | L | PH2-03 | Replayed offline batches produce no duplicate charges under generated interleavings |
| PH3-01 | Prepaid balance and consumption limit | M | W2-04 | Consumption limited by prepaid balance |
| PH3-02 | Low-balance alerting | S | PH3-01 | Customer alerted before cutoff |
| PH4-01 | Tamper, drift, and anomaly detection | L | PH1-03 | Drift measured against the stored calibration baseline |
| PH5-01 | Operator, site, and tariff onboarding | L | PR1-01 | Tariffs versioned like any other price |
| PH6-01 | Device and certified meter registration | M | PH1-01 | Only approved hardware registers |
| PH7-01 | Safe cutoff instruction path | L | PH3-01 | Meter issues an instruction; operator equipment acts on it |
| PH8-01 | Operator dashboard, settlement, and site reports | L | PR8-01 | Operator self-serves its financial position |
| PH9-01 | Manual fallback and evidence-based disputes | M | PH1-03 | A disputed charge resolves from the stored raw reading |
| PH-SEC | Device key compromise, replay, and tamper simulation | L | PH4-01 | Security gate passes before a live site |

---

## 5. Counts

| Stage | Tickets | Grain |
| --- | ---: | --- |
| Stage 1 — Meter AI | 119 | PR-sized |
| Stage 2 — Meter Agents | 35 | PR-sized |
| Stage 3 — Meter Providers | 24 | feature, provisional |
| Stage 4 — Meter Content | 13 | feature, provisional |
| Stage 5 — Meter Sessions | 15 | feature, provisional |
| Stage 6 — Meter Physical | 17 | feature, provisional |
| **Total** | **223** | |

---

## 6. First ten tickets

Everything below is startable today. Nothing here is blocked on Track A, and
together they close architecture §26 steps 2 and 3.

| Order | Ticket | Why first |
| --- | --- | --- |
| 1 | W1-01 | Every financial foreign key points at it |
| 2 | W2-01 | The chart of accounts shapes every later command |
| 3 | W1-04 | Shared webhook verification; W1-05 and W8-03 both depend on it |
| 4 | W1-02 | Unblocks the guard and the PWA sign-in |
| 5 | W2-02 | Idempotency must exist before the first command, not after |
| 6 | W1-03 | Nothing authenticated works without it |
| 7 | W2-03 | `postJournal` is the single writer every command routes through |
| 8 | W2-04 | First real command; proves the transaction shape end to end |
| 9 | W2-14 | Concurrency test before more commands are built on the pattern |
| 10 | W2-15 | Makes the financial invariants a permanent CI gate from here on |

Order 9 and 10 come before the remaining ledger commands deliberately. The
concurrency and invariant harness is cheaper to build against two commands than
against nine, and every later command inherits it.
