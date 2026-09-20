# Meter Technology Architecture and Stack Decision

**Status:** Approved design, pending written review

**Date:** 2026-09-20

**Owner:** Founder / CTO

**Product scope:** Meter AI first; shared core for the long-term Meter platform

**Related PRD:** `docs/superpowers/specs/2026-09-20-meter-master-platform-prd.md`

---

## 1. Executive recommendation

Meter will use a TypeScript modular monolith backed by PostgreSQL.

The initial product consists of:

- A statically delivered Next.js PWA.
- A NestJS/Fastify API.
- A worker process built from the same server codebase.
- One PostgreSQL primary containing an append-only double-entry ledger and the product’s transactional state.
- PostgreSQL-backed jobs through a transactional outbox and pg-boss.
- Replaceable adapters for authentication, payments, KYC, AI providers, object storage, and Circle/Arc/x402 settlement.

This architecture optimizes for the actual constraints:

- A solo technical founder.
- A self-funded launch.
- A 200-funded-user Stage 1 target.
- Financial correctness and auditability.
- Fast product iteration.
- The ability to scale without a premature rewrite.

The stack deliberately excludes Kubernetes, microservices, Kafka, RabbitMQ, a mandatory Redis dependency, GraphQL, and blockchain-based customer accounting.

## 2. Decision summary

| Area | Decision |
| --- | --- |
| Architecture | Modular monolith |
| First client | Responsive PWA |
| Primary language | TypeScript |
| Runtime | Node.js 24 LTS |
| Web framework | Next.js 16.3 Active LTS and React 19.2 |
| API framework | NestJS 12 with Fastify |
| API protocols | Versioned REST/OpenAPI and Server-Sent Events |
| Primary database | PostgreSQL 18 |
| Query layer | Kysely with node-postgres |
| Database migrations | Reviewed SQL migrations |
| Financial system | Append-only double-entry ledger |
| Background jobs | Transactional outbox and pg-boss |
| Authentication | Clerk Pro passkeys and sessions |
| Authorization | Meter-owned policies and roles |
| Object storage | Cloudflare R2 |
| AI integration | Meter-owned interface over official provider SDKs |
| Blockchain integration | Circle SDK and viem behind an adapter |
| Hosting | Cloudflare, Render Frankfurt, and Neon Frankfurt |
| Observability | Pino, OpenTelemetry server traces/metrics, and Sentry |
| Test stack | Vitest, fast-check, Testcontainers, Playwright, and k6 |
| CI/CD | GitHub Actions and Docker |

## 3. Architecture goals

The architecture must:

- Let one founder deliver and operate Meter AI.
- Prevent double-spending, duplicate funding, duplicate capture, and unbalanced journals.
- Make every external callback and retry idempotent.
- Stream AI output without keeping long database transactions open.
- Support additional API instances and workers without changing the domain model.
- Keep AI, payment, KYC, storage, and chain providers replaceable.
- Maintain clear module ownership without requiring network boundaries.
- Keep baseline infrastructure below $160 per month through the closed beta.
- Provide an explicit path to the reliability targets in the master PRD.
- Defer operational systems until measured demand requires them.

## 4. Non-goals

The initial architecture will not include:

- Kubernetes or a service mesh.
- A service per domain module.
- Kafka, NATS, or RabbitMQ.
- Redis as a required source, queue, or lock manager.
- GraphQL.
- Event sourcing for the entire product.
- CQRS as a framework-wide pattern.
- Multi-region writes.
- A data warehouse.
- A proprietary identity system.
- A proprietary blockchain or token.
- On-chain customer balances.
- Native iOS or Android applications.
- A separate Go backend.

Go remains an option for a future measured workload such as high-volume physical telemetry. It is not part of the Stage 1 architecture.

## 5. System context

```text
Customer browser
      │
      ▼
Cloudflare: DNS, TLS, CDN, WAF, public rate limits
      │
      ├──────────────► Next.js PWA static assets
      │
      └──────────────► NestJS/Fastify API on Render Frankfurt
                              │
                              ├── REST commands and reads
                              ├── SSE AI streams
                              ├── signed webhook endpoints
                              └── internal operations endpoints
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
                    ▼                 ▼                 ▼
             Neon PostgreSQL     Worker process    Cloudflare R2
                Frankfurt          on Render          objects
                    │                 │
                    └────── transactional outbox ──────┘

External systems
├── Clerk authentication
├── licensed Nigerian payment/custody partner
├── KYC provider
├── direct AI providers
├── OpenRouter for long-tail experiments
├── Circle / Arc / x402
└── email and SMS providers
```

## 6. Deployable units

### 6.1 Web PWA

The PWA is a static Next.js application delivered through Cloudflare.

Responsibilities:

- Onboarding and authentication UI.
- Funding initiation.
- AI task, chat, and document workflows.
- Quote review and authorization.
- Stream presentation.
- Balance, limit, receipt, and history views.
- Refund and support initiation.
- Installable PWA manifest and application shell.

Restrictions:

- It contains no financial business logic.
- It never accesses PostgreSQL directly.
- It never stores authentication secrets or provider credentials.
- Its service worker caches the application shell and public assets only.
- It does not cache balances, quotes, receipts, KYC data, AI results, or authenticated API responses.
- It does not use Next.js Server Actions for product commands.

Next.js publishes first-party PWA guidance for manifests, service workers, installation, and security. Static export is compatible with an external API boundary. See [Next.js PWA guidance](https://nextjs.org/docs/app/guides/progressive-web-apps).

### 6.2 API process

The API is a NestJS application using the Fastify adapter.

Responsibilities:

- Verify authentication tokens.
- Apply Meter authorization and account restrictions.
- Generate and expire quotes.
- Reserve, capture, release, reverse, and refund through the ledger.
- Orchestrate streamed AI requests.
- Receive and verify external webhooks.
- Expose versioned operational APIs.
- Generate OpenAPI documentation.

The API is stateless outside PostgreSQL and external object storage. It can run multiple replicas without sticky sessions.

### 6.3 Worker process

The worker uses the same server modules through a separate bootstrap entry point.

Responsibilities:

- Process verified payment events.
- Reconcile funding and settlement.
- Finalize provider usage.
- Retry outbound webhooks.
- Execute scheduled jobs.
- Send notifications.
- Apply retention policies.
- Generate finance and operations reports.

During the concierge beta, API and worker may run in one container. They must run as separate processes before broad public launch.

## 7. Repository structure

```text
meter/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   ├── lib/
│   │   └── public/
│   └── server/
│       └── src/
│           ├── bootstrap/
│           │   ├── api.ts
│           │   └── worker.ts
│           ├── modules/
│           │   ├── identity/
│           │   ├── compliance/
│           │   ├── funding/
│           │   ├── ledger/
│           │   ├── catalog/
│           │   ├── pricing/
│           │   ├── authorization/
│           │   ├── ai/
│           │   ├── usage/
│           │   ├── settlement/
│           │   ├── reconciliation/
│           │   ├── risk/
│           │   └── support/
│           ├── adapters/
│           │   ├── auth/
│           │   ├── payments/
│           │   ├── kyc/
│           │   ├── ai-providers/
│           │   ├── storage/
│           │   └── settlement/
│           └── platform/
│               ├── database/
│               ├── jobs/
│               ├── telemetry/
│               └── security/
├── packages/
│   ├── contracts/
│   ├── ui/
│   ├── config/
│   └── testing/
├── database/
│   ├── migrations/
│   └── seeds/
├── infra/
│   ├── render.yaml
│   ├── cloudflare/
│   └── monitoring/
├── docs/
├── pnpm-workspace.yaml
└── turbo.json
```

### Repository rules

- `packages/contracts` contains browser-safe Zod request, response, and event schemas.
- Database models and provider SDK types never enter browser packages.
- Server modules expose application interfaces, not their tables.
- An adapter translates an external provider into a Meter-owned interface.
- Cross-module access occurs through application interfaces or committed events.
- Circular module dependencies are prohibited.
- Dependency direction is domain/application to ports, then infrastructure adapters to ports.

## 8. Module boundaries

| Module | Owns | May depend on |
| --- | --- | --- |
| Identity | Internal users, sessions mapping, organizations, roles | Clerk adapter |
| Compliance | KYC state, limits, restrictions, screening references | Identity, KYC adapter |
| Funding | Funding intents, verified payment events, refund initiation | Compliance, ledger, payment adapter |
| Ledger | Accounts, journals, entries, balances, reservations | PostgreSQL only |
| Catalog | Services, providers, capabilities, availability | Provider metadata adapters |
| Pricing | Price versions, quote calculation, FX inputs, quote expiry | Catalog, FX adapter |
| Authorization | Balance, budget, limit, allowlist, and risk decision | Compliance, pricing, ledger, risk |
| AI | Provider selection, streaming, fallback, provider health | Catalog, authorization, provider adapters |
| Usage | Delivery evidence, normalized usage, capture request | AI, ledger |
| Settlement | Provider payables, splits, holds, payout batches | Ledger, provider and chain adapters |
| Reconciliation | Internal-to-external matching and exceptions | Controlled financial projections |
| Risk | Velocity, device, funding, usage, and provider rules | Identity and transaction summaries |
| Support | Cases, dispute evidence, controlled operations | Read-only timelines and approved commands |

The ledger module exposes commands. Other modules cannot insert ledger entries or update balances directly.

## 9. API design

### 9.1 Protocols

- REST/JSON for commands and ordinary reads.
- OpenAPI as the published client contract.
- Server-Sent Events for AI output and long-running progress.
- Signed HTTPS webhooks for external callbacks.
- No GraphQL during Stage 1.
- No client-facing gRPC.

### 9.2 Versioning

- Public routes begin under `/v1`.
- Compatible additions remain within a major version.
- Field removal or semantic changes require a new version or a deprecation period.
- Webhook payloads contain an explicit schema version.
- Database schema version is never exposed as API version.

### 9.3 Command rules

- Every financial command requires an idempotency key.
- The API returns the first command result for a recognized retry.
- Validation happens before domain work.
- Authorization happens before provider invocation.
- External network calls never occur within a database transaction.
- Machine-readable error codes are stable even when message copy changes.

## 10. Financial data architecture

### 10.1 Ledger tables

```text
ledger.accounts
├── id UUIDv7
├── owner_type
├── owner_id
├── asset_code
├── account_type
├── normal_balance
├── status
└── created_at

ledger.transactions
├── id UUIDv7
├── transaction_type
├── idempotency_scope
├── idempotency_key
├── state
├── effective_at
├── external_reference
├── reversal_of
└── metadata

ledger.entries
├── transaction_id
├── sequence
├── account_id
├── direction
├── amount_atomic NUMERIC(38,0)
├── asset_code
└── created_at

ledger.balances
├── account_id
├── posted_amount NUMERIC(38,0)
├── reserved_amount NUMERIC(38,0)
└── version
```

`ledger.entries` are the accounting source of truth. `ledger.balances` is an atomically updated projection for low-latency authorization.

### 10.2 Invariants

- Every posted journal balances by asset.
- Posted ledger entries are immutable.
- Corrections use linked compensating journals.
- Available spend cannot be negative.
- Capture cannot exceed the remaining reservation.
- Captured plus released value equals the original reservation.
- Refunded value cannot exceed captured value minus earlier refunds.
- Split allocations equal the distributable provider amount.
- Every external event identifier is unique within its provider scope.
- Rebuilding balance projections from entries produces identical balances.

### 10.3 Money representation

- Amounts use atomic integers.
- Naira uses kobo.
- USDC uses its configured base-unit scale.
- PostgreSQL stores amounts as `NUMERIC(38,0)`.
- TypeScript uses `bigint` inside the server.
- JSON transports monetary values as decimal strings.
- JavaScript `number` is prohibited for monetary values.
- An asset registry contains code, exponent, state, and settlement properties.
- FX records preserve source amount, destination amount, exact quote, spread, source, timestamp, and expiry.
- Rounding occurs only at named pricing and settlement boundaries.

### 10.4 Reservation accounting

```text
Customer available liability
        │ reserve maximum
        ▼
Customer reserved liability
        │
        ├── capture
        │   ├── provider payable
        │   ├── Meter revenue
        │   ├── tax liability
        │   └── explicit settlement cost
        │
        └── release unused amount
            ▼
Customer available liability
```

Reservation records, entries, balance projections, and outgoing events commit in one PostgreSQL transaction.

### 10.5 Transaction isolation

Financial commands use PostgreSQL `SERIALIZABLE` isolation:

1. Resolve or create the idempotency record.
2. Lock or conditionally update the balance projection.
3. Verify available funds, limits, and current restriction state.
4. Write the journal and balanced entries.
5. Update the balance projection.
6. Write the outbox event.
7. Commit.
8. Retry serialization failures with bounded exponential backoff and jitter.

Kysely exposes explicit serializable transactions while retaining SQL-like queries. See the [Kysely repository and transaction API](https://github.com/kysely-org/kysely).

## 11. PostgreSQL organization and optimization

### 11.1 Schemas

```text
identity.*
compliance.*
funding.*
ledger.*
catalog.*
pricing.*
authorization.*
usage.*
settlement.*
operations.*
jobs.*
```

Schema ownership documents domain boundaries. Financial schemas receive restricted production permissions from the first real-money release.

### 11.2 Index strategy

- Index foreign keys used for lookup.
- Add unique indexes for idempotency keys, provider event IDs, and payment references.
- Match compound indexes to observed access patterns:
  - `(account_id, created_at DESC)`
  - `(customer_id, state, expires_at)`
  - `(provider_id, settlement_state, captured_at)`
  - `(status, next_attempt_at)`
- Use keyset pagination for histories.
- Reject unbounded operational queries.
- Review `EXPLAIN ANALYZE` for high-frequency queries.
- Enable `pg_stat_statements`.
- Configure statement, lock, idle transaction, and total transaction timeouts.

### 11.3 Deliberate omissions

- Do not partition tables at launch.
- Do not add a read replica at launch.
- Do not use a separate analytics database at launch.
- Do not use database triggers for broad business workflows.
- Use constraints or narrowly scoped deferred checks for financial invariants.

Partitioning begins only when table size, vacuum behavior, or retention operations show a measurable problem. Reporting moves to a replica only when it affects financial-write latency.

PostgreSQL 18 is the current supported major version. It adds asynchronous I/O improvements, UUIDv7 generation, and skip-scan improvements. See the [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html).

## 12. Jobs and asynchronous work

### 12.1 Transactional outbox

Every domain action that requires later work writes an outbox record in the same database transaction as its domain and ledger state.

```text
Command
   ↓
PostgreSQL transaction
   ├── domain changes
   ├── ledger changes
   └── outbox event
            ↓
        pg-boss worker
            ↓
 external call / notification / settlement
```

This prevents committed financial state from losing its required downstream event.

### 12.2 Initial queues

- `payment-webhook`
- `funding-reconciliation`
- `provider-finalization`
- `settlement`
- `notification`
- `refund`
- `risk-review`
- `data-retention`
- `daily-reconciliation`

Every handler is idempotent and has bounded retries, exponential backoff, dead-letter behavior, and an operations-visible reason for failure.

pg-boss is backed by PostgreSQL and uses `SKIP LOCKED` to coordinate multiple workers. It avoids a separate queue datastore during the self-funded stage. See [pg-boss](https://pgboss.io/introduction).

### 12.3 Queue migration trigger

A dedicated queue system is evaluated when job work consumes more than 20% of primary database CPU, job maintenance affects transactional query latency, or a workload requires capabilities that pg-boss cannot supply. The replacement depends on the measured need:

- Temporal for durable multi-step workflows.
- A Redis-compatible queue for high-rate ephemeral work.
- Kafka-compatible infrastructure for high-volume retained event streams with many independent consumers.

No replacement is selected in advance.

## 13. AI orchestration

### 13.1 Provider interface

```ts
interface AIProvider {
  quote(request: QuoteInput): Promise<ProviderQuote>;
  execute(request: ExecutionInput): AsyncIterable<ProviderEvent>;
  normalizeUsage(result: ProviderResult): VerifiedUsage;
  health(): Promise<ProviderHealth>;
}
```

Provider SDK objects and error types remain inside the adapter.

### 13.2 Initial provider strategy

- Integrate one primary provider directly.
- Integrate one secondary provider directly for fallback and capability coverage.
- Use OpenRouter for long-tail access and experiments only.
- Launch with 3–5 customer capabilities rather than dozens of model choices.
- Track provider cost, latency, success, quality, and normalized usage independently.

Direct-provider traffic should dominate after validation because aggregator fees reduce contribution margin.

### 13.3 Streamed execution

1. Resolve an active catalog and price version.
2. Create a quote with an enforceable maximum.
3. Reserve the maximum through the ledger.
4. Open the provider stream.
5. Forward chunks through SSE without buffering the full response.
6. Record non-financial telemetry asynchronously.
7. Normalize and verify final usage.
8. Capture the final amount.
9. Release unused reserve.
10. Return the financial terminal state to the client.

Provider fallback is allowed only when it fits the original maximum price, data policy, capability, and user expectation. A provider success response does not by itself authorize a charge.

### 13.4 AI performance measurements

- Quote latency.
- Authorization latency.
- Provider connection latency.
- Time to provider first token.
- Time to customer first token.
- Provider completion time.
- Capture completion time.
- Cost and token usage by model and workflow.

## 14. Authentication and authorization

### 14.1 Authentication

Clerk manages:

- Passkeys.
- Session issuance and verification.
- Account recovery.
- Authentication UI primitives.
- Authentication event webhooks.

Clerk Pro is selected because managed passkeys cost less than building and operating secure recovery as a solo founder. Clerk currently publishes Pro pricing starting at $20 per month when billed annually. See [Clerk pricing](https://clerk.com/pricing).

### 14.2 Meter identity mapping

- Every Meter user receives an internal UUIDv7.
- Clerk IDs are stored in an external identity mapping table.
- Financial foreign keys use the internal user ID.
- Replacing Clerk does not require rewriting the ledger.
- Authentication webhooks are signed, replay-safe, and idempotent.

### 14.3 Authorization

Meter owns:

- User, organization, and operations roles.
- KYC tiers and limits.
- Account restriction state.
- Daily and monthly budgets.
- Provider and service allowlists.
- Agent credential scopes.
- Refund, payout, and manual-adjustment permissions.

Authorization is deny-by-default. Support impersonation cannot authorize spending or mutate financial records.

## 15. External integration security

### 15.1 Inbound webhooks

Every webhook handler:

1. Preserves the raw body.
2. Verifies the provider signature.
3. Enforces the provider timestamp or replay window.
4. Stores the external event ID under a unique constraint.
5. Returns success for a recognized duplicate.
6. Queues verified processing.
7. Reconciles independently against the provider API.

A verified webhook enters the command path. It cannot update a balance directly.

### 15.2 Outbound calls

Every external adapter applies:

- Connection and response timeouts.
- Bounded retries with jitter.
- Circuit breaking.
- Idempotency keys where supported.
- Per-provider concurrency limits.
- Cost and monthly budget limits.
- Redacted structured logging.

External calls never occur while a database transaction is open.

## 16. Object and document storage

Cloudflare R2 stores uploaded documents and generated artifacts through its S3-compatible API.

Rules:

- The API issues user-scoped, short-lived signed URLs.
- New uploads enter a quarantine prefix.
- File type, size, and content are validated independently of browser metadata.
- Processing uses isolated jobs with strict time and memory limits.
- Objects have retention and deletion policies.
- Public buckets are prohibited for customer content.
- Object identifiers reveal no customer information.
- Database records remain the source of authorization for object access.

R2 includes 10 GB-month of standard storage in its free allowance and does not charge internet egress. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## 17. Cache strategy

Cacheable:

- Public catalog entries.
- Provider health.
- Non-sensitive feature configuration.
- Short-lived reference data.

Never used as financial truth:

- Available or reserved balance.
- Authorization results.
- Final price.
- KYC or account restriction state.
- Settlement state.

Redis is added only when measured hot-read load, cross-instance rate limiting, or ephemeral coordination justifies another system. Cloudflare and PostgreSQL cover the initial needs.

## 18. Security architecture

### 18.1 Trust boundaries

Untrusted inputs include:

- Browser and service-worker requests.
- Payment, KYC, and provider webhooks.
- Uploaded files.
- AI provider responses.
- Agent requests.
- Blockchain events.

An input becomes trusted for a specific purpose only after authentication, signature or proof verification, replay checks, authorization, and validation. No external system is a financial authority.

### 18.2 Core controls

- TLS for all network traffic.
- Managed encryption at rest for PostgreSQL and R2.
- Application-level encryption for selected KYC references and provider secrets.
- Deployment secret managers for credentials.
- MFA and step-up authentication for operations and finance.
- Least-privilege production access.
- Immutable security and financial audit records.
- Hashed, scoped, expiring, and revocable agent credentials.
- File quarantine and content validation.
- Data minimization in logs, analytics, and support tools.
- Explicit prompt and response retention rules.
- Dependency, source, container, and infrastructure scanning.

### 18.3 Stage security gates

Before concierge beta:

- Threat model.
- Secret rotation process.
- Signed webhook verification.
- Ledger invariant suite.
- Dependency and basic vulnerability scanning.
- Successful backup restoration.

Before public launch:

- Independent penetration test.
- OWASP ASVS review of core journeys.
- Incident-response exercise.
- Partner and provider outage drills.
- Data Privacy Impact Assessment.
- Production audit logging.
- Restoration and reconciliation drill.
- Software bill of materials and container scan.

Before agents or providers:

- Credential abuse and rotation tests.
- Organization role review.
- Budget and allowlist bypass tests.
- Provider over-reporting simulation.
- Payout hold and recovery tests.

## 19. Observability

### 19.1 Signals

- Pino structured JSON logs.
- OpenTelemetry server traces and metrics.
- Sentry browser and server exceptions.
- Product and financial metrics derived from first-party events.

OpenTelemetry JavaScript currently marks Node traces and metrics stable while browser instrumentation remains experimental. Server instrumentation is therefore authoritative. See [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/).

### 19.2 Correlation

One correlation ID connects:

- HTTP request.
- Quote.
- Authorization.
- Provider request.
- Usage record.
- Ledger transaction.
- Outbox jobs.
- Settlement.
- Reconciliation exception.

Logs exclude prompts, AI results, KYC data, secrets, and full payment instruments.

### 19.3 Alerts

Alert on:

- Authorization failure spikes.
- Duplicate-event conflicts.
- Ledger invariant violations.
- Provider price or usage variance.
- Provider timeout and failure spikes.
- Job dead letters.
- Settlement failure.
- Reconciliation gaps.
- Database saturation or connection exhaustion.
- Infrastructure and provider budget thresholds.

## 20. Testing strategy

| Layer | Tool | Coverage |
| --- | --- | --- |
| Domain | Vitest | Pricing, limits, splits, state machines |
| Property | fast-check | Ledger conservation, rounding, reversal, concurrency properties |
| Database integration | Testcontainers and PostgreSQL 18 | Transactions, locks, constraints, migrations |
| Adapter contract | Vitest and provider sandbox fixtures | Payment, AI, KYC, storage, settlement normalization |
| API integration | Nest test harness | Authentication, validation, idempotency, error mapping |
| Browser | Playwright | Onboarding, funding, AI use, limits, receipt, refund initiation |
| Load | k6 | Quote, authorization, history, webhook, and streaming paths |
| Recovery | Isolated restore scripts | Restore, outbox replay, projection rebuild, reconciliation |
| Security | CodeQL and dependency/container scanners | Known vulnerabilities and unsafe patterns |

Playwright performs browser actions with automatic actionability checks and isolated tests, making it suitable for Meter’s critical PWA journeys. See [Playwright testing](https://playwright.dev/docs/writing-tests).

### 20.1 Mandatory financial tests

- Every posted journal balances by asset.
- Posted entries cannot be edited or deleted.
- Available balance cannot become negative.
- Concurrent authorizations cannot overspend.
- Capture cannot exceed reservation.
- Capture plus release equals the original reservation.
- Refund cannot exceed captured value after previous refunds.
- Splits equal the distributable amount.
- Recognized retries cannot create value.
- FX rounding cannot create unaccounted value.
- Replayed webhooks converge on the same final state.
- Projection rebuild produces the recorded balances.

## 21. Reliability and recovery

### 21.1 Targets

| Measure | Target before public launch |
| --- | --- |
| Ledger availability | 99.95% monthly |
| Financial idempotency | 100% for recognized retries |
| Authorization latency | p95 below 500 ms, excluding KYC |
| Duplicate customer charges | Fewer than 1 per 100,000 transactions |
| Customer charge above approved maximum | Zero tolerance |
| Unexplained ledger imbalance | Zero tolerance |
| Recovery point objective | Five minutes or less |
| Recovery time objective | Two hours or less |

### 21.2 Backup plan

- Neon paid database for real-money environments.
- At least seven days of point-in-time recovery.
- Nightly encrypted logical backup outside Neon.
- Backup before every financial-schema deployment.
- Monthly restore into an isolated database.
- Ledger projection rebuild and partner reconciliation after restoration.
- Spending remains paused until reconciliation succeeds.

Neon offers usage-based compute and configurable restore windows, allowing early-stage cost control while preserving an upgrade path. See [Neon pricing explanation](https://neon.com/blog/new-usage-based-pricing).

## 22. Deployment architecture

### 22.1 Environments

| Environment | Form |
| --- | --- |
| Local | Docker Compose with PostgreSQL 18 and mocked providers |
| Test | Disposable Testcontainers PostgreSQL |
| Preview | Static preview and temporary Neon branch |
| Staging | Created for release candidates and partner certification; suspended when unused |
| Production | Cloudflare, Render, Neon, and managed providers |

The self-funded company does not pay for multiple permanently idle environments.

### 22.2 CI/CD pipeline

```text
Pull request
    ↓
format, lint, type-check
    ↓
unit and property tests
    ↓
PostgreSQL integration tests
    ↓
migration apply and rollback test
    ↓
dependency and container scan
    ↓
preview deployment
    ↓
Playwright critical journeys
    ↓
manual production approval
    ↓
expand-compatible migration
    ↓
rolling application deployment
    ↓
smoke tests and reconciliation check
    ↓
old-schema cleanup in a later release
```

Financial schema changes use expand-and-contract migrations. Destructive migrations cannot depend on simultaneous application deployment.

### 22.3 Production upgrade before public funding

- Separate API and worker processes.
- Run at least two API instances.
- Use a database plan with the required restore window and security controls.
- Enable encrypted external backups.
- Exercise restoration and reconciliation.
- Enable cost alerts and provider hard limits.
- Pass load, failover, security, and incident-response tests.

## 23. Cost model

Variable AI, payment, FX, KYC, email, and SMS charges are excluded. They must be measured and allocated per transaction.

| Stage | Fixed monthly infrastructure target |
| --- | ---: |
| Development and unfunded prototype | $0–$30 |
| Concierge beta with real money | $50–$90 |
| Closed beta up to 200 funded users | $80–$160 |
| Early public launch | $200–$500 |
| 10,000 recurring users | Approximately $500–$2,000 |

### 23.1 Representative closed-beta budget

| Service | Approximate monthly cost |
| --- | ---: |
| Render API | $7–$25 |
| Render worker | $0 while combined, then $7–$25 |
| Neon database and restore history | $20–$50 |
| Clerk Pro | Approximately $20 |
| Cloudflare and R2 | Usually within free allowance |
| Monitoring and transactional email | Free tiers initially |
| Off-site backup and domain | Under $10 |
| Contingency | $10–$20 |

Render currently publishes a 512 MB service at $7 and a 1 CPU/2 GB service at $25 per month. See [Render pricing](https://render.com/pricing).

### 23.2 Cost controls

- Every provider has monthly budget and alert thresholds.
- AI calls require a successful reservation.
- Retry counts are bounded.
- Prompts and responses are excluded from logs.
- Trace sampling favors failures and rare flows.
- R2 objects have lifecycle rules.
- Preview resources expire automatically.
- Database branches are deleted after review.
- AI, payment, KYC, and support cost are attributed by user, workflow, and provider.
- Capacity increases follow measured demand.

## 24. Scaling plan

Meter scales in this order:

1. Remove slow queries and unnecessary provider work.
2. Tune API and worker concurrency.
3. Add stateless API replicas.
4. Increase PostgreSQL compute.
5. Isolate heavy job classes.
6. Add a reporting replica.
7. Add Redis for a measured cache or coordination requirement.
8. Extract a module with a demonstrated independent boundary.
9. Add Go for a measured CPU-intensive workload.
10. Add retained event-stream infrastructure only when PostgreSQL queues constrain the product.

### 24.1 Operational thresholds

| Signal | Action |
| --- | --- |
| API CPU above 65% or event-loop delay above 50 ms for 15 minutes | Add or enlarge API instances |
| API p95 excluding providers above 250 ms | Profile application and database paths |
| Database CPU above 70% for 30 minutes | Optimize queries, then increase compute |
| Common database queries above 50 ms p95 | Review plans and indexes |
| Jobs exceed 20% of database CPU | Isolate job storage or adopt a dedicated queue |
| Reporting affects write latency | Add replica or analytics store |
| One provider workload dominates a worker | Split that worker class |
| Object or log growth exceeds retention assumptions | Apply lifecycle and sampling changes |

### 24.2 Service extraction conditions

A module becomes a service candidate only when at least one condition is sustained:

- It consumes more than 40% of API or worker resources.
- It needs a materially different security or availability boundary.
- It deploys independently much more often than the core.
- Its failures repeatedly threaten financial authorization.
- Its throughput or connection model is unsuitable for the primary process.
- A dedicated team owns it.

Likely future candidates are AI orchestration, the x402 gateway, provider webhook ingestion, physical telemetry ingestion, and analytics. The ledger is the last component to split.

## 25. Alternatives considered

### 25.1 Go backend from launch

Advantages:

- Lower memory footprint.
- Strong raw concurrency and predictable latency.
- Suitable for high-rate ingestion.

Rejected for Stage 1 because:

- It creates two application languages.
- It slows shared-contract and product iteration.
- Node provider SDK coverage is broader.
- Expected Stage 1 load does not require it.
- The founder’s NestJS experience provides faster delivery.

Go remains available for a measured future ingestion or compute boundary.

### 25.2 Supabase/serverless-first

Advantages:

- Very fast prototype setup.
- Integrated auth, database, storage, and functions.
- Low initial cost.

Rejected as the core architecture because:

- Financial logic would fragment across functions, policies, and triggers.
- Transaction boundaries become less explicit.
- Debugging and local parity are harder.
- Core authorization becomes more vendor-shaped.

Managed PostgreSQL remains desirable; the application and ledger boundaries remain Meter-owned.

### 25.3 Microservices and event streaming

Advantages:

- Independent scaling and deploys.
- Strong isolation for mature teams.
- Natural organizational boundaries.

Rejected because:

- Meter has one founder and one initial product.
- Network failure becomes part of every business operation.
- Distributed transactions complicate the ledger.
- Observability and deployment costs rise sharply.
- There is no measured scaling need.

### 25.4 Self-hosted PostgreSQL

Rejected for real-money production because backups, failover, patching, monitoring, and recovery would consume founder time and introduce avoidable risk.

## 26. Delivery sequence

1. Establish monorepo, CI, typed configuration, and local PostgreSQL.
2. Implement internal identity mapping and authorization foundation.
3. Implement append-only ledger, reservations, and invariant tests.
4. Implement catalog, price versions, quotes, and expiry.
5. Implement the primary AI adapter and streamed execution.
6. Implement PWA onboarding, chat, balance, limits, and receipts.
7. Integrate the payment partner’s sandbox.
8. Implement transactional outbox and worker processing.
9. Implement reconciliation and operations views.
10. Implement refunds, restrictions, and support tooling.
11. Provision production infrastructure and observability.
12. Pass security, recovery, concurrency, and load gates.
13. Run the concierge beta.
14. Harden for public launch only after beta evidence passes the PRD gates.

## 27. Architecture decision records

The following decisions are fixed by this design:

- Meter uses a TypeScript modular monolith for Stage 1.
- The initial client is a PWA.
- The PWA does not contain server business logic.
- PostgreSQL is the transactional and financial source of truth.
- Ledger entries are append-only and double-entry.
- Money is represented as atomic integers.
- Financial commands use explicit idempotency and serializable transactions.
- The job system begins with PostgreSQL and pg-boss.
- Clerk handles authentication; Meter handles authorization.
- AI, payment, KYC, storage, and chain integrations use Meter-owned adapters.
- Circle/Arc/x402 do not define customer balances.
- The system starts in one region.
- Infrastructure is managed rather than self-hosted.
- Scaling and extraction are triggered by measurements.

## 28. CTO operating rule

Measure four sources of latency and cost independently:

1. Browser and network.
2. Meter API and PostgreSQL.
3. External AI and payment providers.
4. Asynchronous settlement and reconciliation.

Optimize the layer consuming the customer’s actual time or Meter’s actual money. During Stage 1, model providers are likely to dominate AI latency and cost; NestJS and PostgreSQL are unlikely to be the bottleneck.

## 29. Source references

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [NestJS 12 migration and runtime requirements](https://docs.nestjs.com/migration-guide)
- [Next.js releases](https://nextjs.org/blog)
- [Next.js PWA guidance](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [PostgreSQL 18 documentation](https://www.postgresql.org/docs/18/)
- [Kysely](https://github.com/kysely-org/kysely)
- [pg-boss](https://pgboss.io/introduction)
- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)
- [Playwright testing](https://playwright.dev/docs/writing-tests)
- [Render pricing](https://render.com/pricing)
- [Render regions](https://render.com/docs/regions)
- [Neon usage-based pricing and restore windows](https://neon.com/blog/new-usage-based-pricing)
- [Clerk pricing](https://clerk.com/pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)

---

## Approval record

The founder approved the architecture approach, system shape, technology stack, repository structure, ledger model, deployment and cost model, scaling thresholds, security controls, testing strategy, and delivery sequence on 2026-09-20. This written document remains subject to final founder review.
