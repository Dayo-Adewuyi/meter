# Meter Master Platform Product Requirements Document

**Status:** Draft for founder review  
**Date:** 2026-09-20  
**Owner:** Founder / Product  
**Market:** Nigeria first  
**Related document:** `Meter — Product Thesis.md`  
**Scope:** Long-term platform strategy with staged product requirements

---

## 1. Purpose of this document

This document evaluates whether Meter is feasible, scalable, and capable of becoming profitable, then defines the product requirements for the complete long-term platform.

It is a master PRD, not a release-level engineering specification. Meter AI, Meter Agents, Meter Providers, Meter Content, Meter Sessions, and Meter Physical are distinct product lines. Each product line must receive a separate delivery PRD and implementation plan only after it reaches its entry gate.

The approved strategy is to build a shared transaction core, launch one vertical at a time, and prevent expansion until the active vertical meets explicit retention, economics, reliability, and compliance thresholds.

## 2. Executive decision

### 2.1 Verdict

Meter is technically feasible and can scale, but the original thesis is too broad and relies on a Nigerian card-access problem that is no longer durable enough to be the primary wedge.

The viable company is not “a blockchain micropayment app for everything.” It is a prepaid usage network with:

- A regulated naira funding experience.
- A conventional, auditable internal ledger.
- A pricing, authorization, and metering control plane.
- Programmable settlement for providers, collaborators, agents, and devices.
- Vertical applications launched sequentially.

Meter can become profitable if it proves repeat paid usage, maintains positive contribution margin, and shifts its transaction mix over time from low-spend consumers toward higher-volume agents and providers. AI resale alone is unlikely to support a large company.

### 2.2 Feasibility scorecard

| Dimension | Assessment | Conditions |
| --- | --- | --- |
| Technical feasibility | High for AI, agents, providers, and content | Use an internal ledger and treat Arc/x402 as replaceable settlement adapters |
| Technical feasibility | Medium for sessions | Reliable session-state evidence and dispute controls are required |
| Technical feasibility | Low-to-medium for physical services | Requires certified hardware, an operator partner, offline recovery, and field support |
| Regulatory feasibility | Medium | Use licensed Nigerian partners; obtain written advice before storing or redeeming value |
| Consumer demand | Unproven | Must be demonstrated with funded behavior, not interview enthusiasm |
| Scalability | High at the software core | Vertical operations must remain separated and stage-gated |
| Profitability | Plausible | Positive unit economics before paid acquisition; B2B volume becomes material |
| Solo-founder feasibility | Medium for discovery and Stage 1 beta | Compliance, support, security, and provider operations require additional capacity before scale |

### 2.3 Thesis corrections

The following changes are required before using the thesis for fundraising, hiring, or delivery planning:

1. **Replace card exclusion as the primary wedge.** Several Nigerian banks resumed international naira-card transactions during 2025–2026. Meter should lead with pay-as-you-go access, one balance, model choice, localized workflows, and spending control.
2. **Do not describe each unit as an individual on-chain settlement.** The product should authorize instantly, record activity in an internal double-entry ledger, and batch external settlement where appropriate.
3. **Do not assume “prepaid service credits” avoid regulation.** Wallet creation, stored value, refunds, pooled funds, and cross-border settlement require legal analysis and licensed partners.
4. **Treat AI aggregation as a competitive market.** OpenRouter and other aggregators already offer prepaid usage, broad model access, budgets, and routing. Meter must win through consumer workflows, naira pricing, local distribution, trust, and provider-side network effects.
5. **Separate the verticals operationally.** Content, expert sessions, and physical services do not automatically follow from consumer AI. Each needs independent evidence and economics.
6. **Replace roadmap dates with evidence gates.** The next product begins only when the current one meets its approved gate.

## 3. Product vision and positioning

### 3.1 Vision

Enable any person or autonomous system to buy exactly the amount of a service it needs, while giving providers immediate, auditable, programmable revenue.

### 3.2 Positioning statement

> Meter is a prepaid usage network that lets people and autonomous software buy digital and real-world services by the unit, with transparent pricing, spending controls, and programmable provider settlement.

### 3.3 Durable customer promise

- Fund once in naira and use many supported services.
- Pay only for completed or verifiably consumed units.
- Know the exact price or enforceable maximum before use.
- Set hard limits for people, teams, agents, and devices.
- Receive itemized, auditable records for every charge.
- Allow providers and collaborators to receive their agreed shares.

### 3.4 Product principles

1. **Naira first.** Stablecoins and blockchains are infrastructure, not the consumer proposition.
2. **No surprise charges.** Every transaction has an exact price or a customer-approved maximum.
3. **The ledger is authoritative.** No product service or external callback may mutate balances directly.
4. **Regulated activities use regulated partners.** Product naming does not replace legal analysis.
5. **Blockchain is optional infrastructure.** It is used when it improves settlement or interoperability.
6. **Every vertical earns the right to exist.** No expansion occurs without passing its entry and exit gates.
7. **Margin before growth.** Paid acquisition begins only after the target cohort has positive contribution margin.
8. **Reversibility and auditability.** Financial operations are idempotent, traceable, and correctable through compensating entries.
9. **Minimum necessary data.** Personal and transaction data remain off-chain except where settlement requires otherwise.
10. **No hidden float economics.** Customer balances and provider payables never fund Meter operations.

## 4. Goals and non-goals

### 4.1 Company goals

- Prove that Nigerian users repeatedly fund and consume pay-as-you-go AI.
- Establish a reusable metering and settlement control plane.
- Enable agents to transact within explicit human-defined policies.
- Add third-party providers without degrading trust or financial integrity.
- Build a blended network in which B2B transaction volume improves platform economics.
- Expand to content, sessions, and physical services only when evidence supports them.

### 4.2 Stage 1 goals

- Reach at least 200 funded users.
- Achieve at least 30% four-week retention among funded users.
- Reach a median of at least 10 paid uses per funded active user per week.
- Maintain positive contribution margin after model, funding, FX, variable infrastructure, support, refund, and fraud costs.
- Demonstrate that the durable proposition is pay-as-you-go utility rather than a temporary card workaround.

### 4.3 Non-goals

Meter will not initially provide:

- Consumer-to-consumer transfers.
- General-purpose bank accounts, savings, yield, or investments.
- Lending, overdrafts, or negative balances.
- Speculative token trading.
- User-visible seed phrases.
- Anonymous high-limit accounts.
- A proprietary blockchain.
- Proprietary physical meters or hardware manufacturing.
- A medical or legal services marketplace.
- Multiple-country operations before Nigerian unit economics are proven.
- Simultaneous launches across the six product stages.

## 5. Platform and product structure

```text
Meter Core
├── Identity, KYC, and access control
├── Naira funding and regulated custody integration
├── Internal double-entry ledger
├── Catalog, quotes, and price versioning
├── Metering and usage verification
├── Budgets and authorization policies
├── Provider settlement and revenue splits
├── Risk, disputes, and reconciliation
├── Reporting and platform operations
└── Settlement adapters
    ├── Nigerian payment partners
    ├── Arc / Circle Gateway / Nanopayments
    └── x402

Vertical products
├── Meter AI
├── Meter Agents
├── Meter Providers
├── Meter Content
├── Meter Sessions
└── Meter Physical
```

Meter Core is not sold as an abstract platform during Stage 1. It exists to support Meter AI and becomes externally accessible as Meter Agents and Meter Providers mature.

## 6. Customer roles and jobs to be done

### 6.1 Consumer

**Profile:** A Nigerian student, developer, creator, knowledge worker, or small-business operator who uses AI but does not receive enough value from multiple recurring subscriptions.

**Jobs:**

- Access the right AI capability for a task without managing several subscriptions.
- Understand the cost in naira before using it.
- Prevent accidental or excessive spending.
- Review what was purchased and obtain help when delivery fails.
- Move from a free tier to occasional paid usage without a large commitment.

### 6.2 Agent developer or team administrator

**Profile:** A developer or team operating software that calls paid APIs or services.

**Jobs:**

- Give software purchasing authority without giving it unrestricted access to funds.
- Limit spend by time, service, provider, request, and environment.
- Audit which agent bought what and why.
- Revoke compromised credentials immediately.
- Use x402 endpoints without building settlement infrastructure.

### 6.3 Provider

**Profile:** A software company, API operator, publisher, creator, expert, or physical-service operator that sells a measurable unit.

**Jobs:**

- Define a billable unit and publish a price.
- Protect a service behind payment with minimal engineering work.
- Verify usage and understand earnings.
- Split revenue among rights holders.
- Resolve refunds and disputes.
- Withdraw earnings through a supported settlement route.

### 6.4 Operations and finance user

**Profile:** Meter staff responsible for support, finance, risk, compliance, and provider operations.

**Jobs:**

- Investigate a transaction without editing financial history.
- Freeze risk while preserving evidence.
- Reconcile every liability and settlement account.
- Issue refunds using controlled compensating entries.
- Export reports required by partners, auditors, and regulators.

## 7. Canonical transaction model

### 7.1 Standard flow

```text
1. Buyer requests a service.
2. Meter resolves the active service and price version.
3. Meter returns an exact price or estimate plus hard maximum.
4. Buyer authorizes the quoted maximum.
5. Authorization engine checks identity, balance, budgets, allowlists, and risk.
6. Ledger moves the maximum from available to reserved.
7. Provider performs the service while usage is measured.
8. Meter verifies completion or measured usage.
9. Ledger captures the final charge and releases unused reserve.
10. Settlement engine allocates provider payable, collaborator shares,
    Meter revenue, taxes, and external costs.
11. External payout or on-chain settlement executes immediately or in batch.
12. Reconciliation confirms internal and external positions.
```

### 7.2 Transaction states

Normal states:

`quoted → authorized → in_progress → captured → settlement_pending → settled`

Exceptional terminal states:

- `declined`
- `expired`
- `failed`
- `partially_captured`
- `reversed`
- `refunded`
- `disputed`

Every state transition must record actor, timestamp, reason, source event, idempotency key, price version, and associated ledger references.

### 7.3 Pricing primitives

| Primitive | Examples | Required authorization behavior |
| --- | --- | --- |
| Fixed | Article, export, generated image, machine cycle | Exact price reserved |
| Measured | Tokens, megabytes, litres, kWh | Maximum reserved; unused amount released |
| Time-based | Consultation minute, live stream minute | Maximum duration or spend reserved |
| Composite | Base fee plus token or time component | Base plus maximum variable amount reserved |

Price changes never alter an existing quote or authorization. A quote expires after its configured validity period and must be regenerated.

## 8. Core platform requirements

Priority definitions:

- **P0:** Required for the first public Meter AI release or financial safety.
- **P1:** Required before the next stage can launch or before material scale.
- **P2:** Valuable after repeatable product-market fit.

### 8.1 Identity, access, and compliance

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| ID-01 | P0 | Support account creation using passkey plus verified email or phone recovery | A user can sign in on a new device after completing the approved recovery flow |
| ID-02 | P0 | Assign a KYC tier and partner-defined limits to every account | Funding and spend above a tier limit are blocked before authorization |
| ID-03 | P0 | Support account restriction, freeze, closure, and evidence-preserving review | Restricted accounts cannot authorize new spend; historical records remain accessible to authorized staff |
| ID-04 | P0 | Require strong authentication for privileged operational actions | Refunds, limit changes, and freezes record the authenticated operator and reason |
| ID-05 | P1 | Support organizations, roles, and least-privilege permissions | Organization administrators can grant billing, developer, or read-only roles independently |
| ID-06 | P1 | Support KYB and beneficiary verification for providers | No provider can receive a payout before approval |
| ID-07 | P1 | Support sanctions and risk-screening results from approved partners | A matched account is placed in review without exposing screening details to unauthorized staff |

### 8.2 Funding and balance management

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| FUND-01 | P0 | Accept naira funding through a licensed partner | Balance becomes spendable only after a signed or independently verified success notification |
| FUND-02 | P0 | Separate pending, available, reserved, and restricted balances | UI and ledger report the same balance composition after every transaction |
| FUND-03 | P0 | Make duplicate funding callbacks idempotent | Replaying the same callback 100 times creates one credit only |
| FUND-04 | P0 | Display collection fees before payment confirmation | User sees total paid and value credited before authorizing the collection |
| FUND-05 | P0 | Support partner-compliant refund or redemption of eligible unused value | Approved refund produces a compensating ledger entry and external reference |
| FUND-06 | P1 | Support USDC deposits only where legally and commercially approved | Unsupported jurisdictions and account tiers cannot access the option |
| FUND-07 | P1 | Reconcile safeguarded funds to customer liabilities | A daily report proves coverage or automatically stops new settlement when an exception exists |

### 8.3 Ledger and accounting

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| LED-01 | P0 | Record every financial event using balanced double-entry journals | The sum of debits and credits equals zero for every posted journal |
| LED-02 | P0 | Prohibit destructive mutation of posted journal entries | Corrections use linked compensating entries |
| LED-03 | P0 | Require unique idempotency keys for all financial commands | A recognized retry returns the original result without reposting |
| LED-04 | P0 | Separate customer liabilities, provider payables, Meter revenue, taxes, reserves, and external cash accounts | Finance can produce a trial balance by account class and currency |
| LED-05 | P0 | Store source amount, settlement amount, currency, and applied FX rate | Every conversion can be reconstructed from its recorded inputs |
| LED-06 | P1 | Support provider holds and rolling reserves | Held earnings cannot be withdrawn but remain visible and auditable |
| LED-07 | P1 | Produce point-in-time balances and statements | A statement can be regenerated from journals without relying on cached totals |

### 8.4 Catalog, quotes, and pricing

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| PRICE-01 | P0 | Maintain immutable, versioned prices | A historical transaction always resolves to the price version used at authorization |
| PRICE-02 | P0 | Return exact or estimated naira price plus enforceable maximum | Authorization cannot reserve more than the displayed maximum |
| PRICE-03 | P0 | Include provider cost, Meter fee, applicable taxes, and FX basis in internal quote calculation | Finance can reproduce the final price from stored inputs |
| PRICE-04 | P0 | Expire quotes after a configurable validity period | An expired quote cannot authorize a transaction |
| PRICE-05 | P1 | Support fixed, measured, time-based, and composite prices | Each pricing primitive passes end-to-end authorization and capture tests |
| PRICE-06 | P1 | Support provider-specific minimums and volume tiers | The applied tier is visible in the provider statement |

### 8.5 Authorization and budgets

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| AUTH-01 | P0 | Check available balance before service delivery | Insufficient funds result in a decline and no provider invocation |
| AUTH-02 | P0 | Reserve the maximum approved charge atomically | Concurrent requests cannot overspend the same available balance |
| AUTH-03 | P0 | Enforce daily and monthly user spending limits | Requests exceeding either limit are declined before provider invocation |
| AUTH-04 | P1 | Enforce per-call, key, service, provider, and lifetime agent limits | A request violating any active policy is denied with a machine-readable reason |
| AUTH-05 | P1 | Support provider and service allowlists | Agent credentials cannot purchase from an unlisted target |
| AUTH-06 | P1 | Require human approval above a configured threshold | The request remains unexecuted until approval or expiry |
| AUTH-07 | P1 | Support credential revocation and emergency organization freeze | Revoked credentials fail on their next authorization attempt |

### 8.6 Usage, delivery, and capture

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| USE-01 | P0 | Record provider request, response status, measured usage, and delivery evidence | Support can determine whether billable value was delivered without viewing unnecessary prompt content |
| USE-02 | P0 | Capture no more than the reserved maximum | An over-reported provider charge is capped and flagged |
| USE-03 | P0 | Release unused reserve immediately after final capture or failure | Available balance updates once the transaction reaches its financial terminal state |
| USE-04 | P0 | Charge zero when delivery fails before value is produced | Full reserve is released and failure is recorded |
| USE-05 | P0 | Permit partial capture only for independently verifiable partial delivery | The receipt identifies the delivered unit and partial amount |
| USE-06 | P1 | Verify signed or authenticated provider usage events | Unverifiable events cannot create captures |
| USE-07 | P1 | Detect abnormal usage, latency, and price variance | Anomalous services can be automatically disabled or held for review |

### 8.7 Settlement, splits, and payouts

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| SET-01 | P0 | Calculate provider payable and Meter revenue at capture | Allocations equal the captured amount after taxes and explicit costs |
| SET-02 | P1 | Support percentage and fixed collaborator splits | Split allocations total the distributable provider amount exactly |
| SET-03 | P1 | Batch external settlement without combining internal ownership | Every batch amount maps to its underlying payables |
| SET-04 | P1 | Retry failed settlements idempotently | Retrying cannot produce a duplicate payout |
| SET-05 | P1 | Support bank, approved USDC, and partner-managed payout routes | Provider can use only routes allowed for its jurisdiction and verification status |
| SET-06 | P1 | Provide provider statements for gross value, refunds, fees, taxes, holds, and net payout | Statement totals reconcile to ledger accounts and payout references |
| SET-07 | P1 | Maintain a replaceable Arc/Circle/x402 adapter | Core transaction records do not depend on chain-specific identifiers |

### 8.8 Reconciliation, risk, disputes, and support

| ID | Priority | Requirement | Acceptance condition |
| --- | --- | --- | --- |
| OPS-01 | P0 | Reconcile partner collections, internal liabilities, provider payables, and settlement accounts daily | Unmatched material items stop affected settlement batches automatically |
| OPS-02 | P0 | Provide a transaction timeline to authorized support staff | Timeline includes quote, authorization, provider delivery, capture, refund, and settlement events |
| OPS-03 | P0 | Issue refunds through reason-coded compensating entries | Original capture remains unchanged and linked to the refund |
| OPS-04 | P0 | Track disputes and supporting evidence | Dispute status, owner, deadlines, and financial exposure are visible |
| OPS-05 | P0 | Apply velocity, funding, device, and usage risk rules | High-risk attempts can be stepped up, declined, or placed under review |
| OPS-06 | P1 | Hold provider payouts based on risk or dispute thresholds | Hold actions record rule, amount, duration, and release condition |
| OPS-07 | P1 | Export partner, accounting, tax, audit, and regulatory reports | Exports reproduce ledger totals for the requested period |

## 9. Product stages

### 9.1 Stage 0 — Validation and compliance setup

**Purpose:** Determine whether funded demand and a workable regulated structure exist before building the full product.

Required activities:

- Interview at least 30 target users who paid for or attempted to pay for AI.
- Test a prototype showing exact naira prices and spending limits.
- Run a concierge beta with 30–50 real funded users.
- Attribute purchase motivation across savings, model choice, naira pricing, non-recurring access, and control.
- Obtain written legal advice covering custody, credits, redemption, stablecoins, provider payments, consumer protection, privacy, and tax.
- Secure a letter of intent or commercial agreement with an appropriately licensed Nigerian partner.
- Confirm that selected model providers permit the proposed managed-service or resale model.

**Exit gate:** At least 30 funded beta users, at least 50% complete a second paid session within 14 days, no unresolved fatal legal blocker, and projected contribution margin is positive at the proposed prices.

### 9.2 Stage 1 — Meter AI

**Purpose:** Prove repeat consumer demand for one naira-funded, pay-as-you-go AI workspace.

P0 capabilities:

- Mobile-first responsive application.
- Passkey account creation and recovery.
- KYC tier and partner-defined limits.
- Naira top-up.
- Text chat and document analysis at launch.
- Model recommendation and manual model selection.
- Exact or maximum naira charge before execution.
- Automatic fallback only within price and data-policy constraints.
- Available balance, pending balance, history, and itemized receipt.
- Daily and monthly hard spending limits.
- Refund and support request initiation.
- Provider cost, latency, success, and quality telemetry.

P1 capabilities after initial launch:

- Image generation.
- Audio transcription.
- Curated coding, research, writing, and business workflows.
- Saved preferences and reusable task templates.
- Export and controlled conversation retention.

**Exit gate:**

- At least 200 funded users.
- At least 30% four-week funded-user retention.
- Median of at least 10 paid uses per funded active user per week.
- Positive contribution margin.
- Fewer than 2% payment-related support incidents.
- No unresolved material compliance issue.

### 9.3 Stage 2 — Meter Agents

**Purpose:** Let developers give software controlled, auditable purchasing authority.

Capabilities:

- Organization workspaces and roles.
- Programmatic balances and scoped credentials.
- Per-call, daily, monthly, and lifetime budgets.
- Provider and service allowlists.
- Maximum price, rate, and concurrency policies.
- Human approval above threshold.
- x402-compatible authorization and payment flow.
- Webhooks, transaction logs, and downloadable audit records.
- Sandbox balances and endpoints.
- Key rotation, revocation, and emergency freeze.

**Entry gate:** Meter AI has passed its exit gate and the platform has operated with zero unresolved ledger imbalance for 60 consecutive days.

**Exit gate:**

- At least 10 active developer teams.
- At least three teams use Meter weekly in production.
- At least 50,000 legitimate paid calls per month.
- Fewer than 0.1% unauthorized or duplicate charges.
- Positive gross margin on agent transactions.
- At least 60% of activated teams retained after eight weeks.

### 9.4 Stage 3 — Meter Providers

**Purpose:** Allow third-party tools and APIs to sell units to Meter buyers.

Capabilities:

- Provider KYB and beneficiary verification.
- Service and versioned price management.
- Hosted payment protection, SDK, and x402 integration.
- Usage-event ingestion and verification.
- Sandbox and integration diagnostics.
- Earnings, holds, refunds, disputes, and statements.
- Revenue splits among verified beneficiaries.
- Payout-route management.
- Provider health, failure, fraud, and dispute monitoring.

**Entry gate:** Meter Agents has passed its exit gate and at least five prospective providers have signed pilot commitments.

**Exit gate:**

- At least 20 approved providers.
- At least 10 providers earn revenue every month.
- At least 25% of transaction value comes from third-party services.
- Median integration time is no more than one working day.
- Provider-side payment success is at least 99.5%.
- No provider exceeds 40% of third-party transaction value.

### 9.5 Stage 4 — Meter Content

**Purpose:** Enable people and agents to buy individual premium content units.

Capabilities:

- Publisher CMS plugin and API.
- Preview plus exact-price purchase.
- Account-bound or time-limited entitlements.
- Agent-readable price and license metadata.
- x402 access for approved crawlers and agents.
- Contributor and rights-holder splits.
- Publisher analytics by content, buyer type, and revenue.
- Publisher-configured free allowance and optional bundles.
- Refunds for unavailable or materially misrepresented content.

**Entry gate:** Meter Providers has passed its exit gate and five publishers have committed to a structured pilot with defined content and promotion.

**Exit gate:**

- At least 10,000 paid unlocks during the pilot.
- At least 15% of buyers purchase again within 30 days.
- Publisher revenue materially exceeds publisher integration and support costs.
- Evidence shows incremental revenue rather than only lower-value substitution for subscriptions.
- No unresolved licensing or crawler-enforcement blocker.

### 9.6 Stage 5 — Meter Sessions

**Purpose:** Provide time-based billing for tutoring, coaching, technical support, creative consultation, and live creators.

Capabilities:

- Expert onboarding and payment link or embedded checkout.
- Rate, minimum charge, maximum session charge, and cancellation policy.
- Pre-session authorization.
- Timer synchronized with session state.
- Pause, resume, reconnection, and end controls.
- Automatic stop when the approved limit is reached.
- Session evidence and itemized receipt.
- Cancellation, no-show, refund, and dispute handling.
- Expert earnings and payout.

Healthcare and legal marketplaces are excluded from the first release. A verified healthcare or legal platform may later use Meter only after separate professional, privacy, and liability review.

**Entry gate:** Meter Providers has passed its exit gate and at least 20 experts have completed a manual billing pilot.

**Exit gate:**

- At least 50 active experts.
- At least 500 completed paid sessions.
- More than 70% of funded sessions complete successfully.
- Dispute rate remains below 2%.
- Experts receive funds faster or experience fewer collection failures than before.
- Contribution margin remains positive after manual support.

### 9.7 Stage 6 — Meter Physical

**Purpose:** Prove one metered physical service using existing certified hardware and operator telemetry.

The first release supports exactly one service category. Shared compound electricity is the leading hypothesis, subject to partner discovery and regulatory review.

Capabilities:

- Operator, site, and tariff onboarding.
- Device or certified meter registration.
- Signed, timestamped usage ingestion.
- Prepaid balance and consumption limit.
- Low-balance alerts and safe cutoff instruction.
- Offline event buffering and idempotent recovery.
- Tamper, drift, and anomaly detection.
- Operator dashboard, settlement, and site reports.
- Manual fallback and evidence-based disputes.

Meter will not manufacture hardware or directly control safety-critical equipment without an approved hardware and operator interface.

**Entry gate:** A qualified operator partner, compliant hardware, written sector guidance, pilot economics, and one committed site are in place.

**Exit gate:**

- At least one live pilot site and 50 paying users.
- Usage variance stays within the hardware partner’s accepted tolerance.
- Collection leakage is lower than the operator’s prior method.
- Offline recovery produces no duplicate charges.
- Installation, support, and hardware integration costs are recoverable within 12 months.
- Applicable utility, payment, safety, and consumer requirements are documented and satisfied.

### 9.8 Machine-to-machine commerce

Machine commerce is not a separate initial product. It combines Meter Agents policies with signed Meter Physical telemetry. A device marketplace may be proposed only after independent devices repeatedly buy or sell services through those existing products.

## 10. Critical user journeys

### 10.1 Consumer onboarding and first funded use

1. User creates an account using a passkey and recovery channel.
2. Meter explains pricing, data handling, refund rights, and account limits.
3. User completes the KYC steps required for the requested funding tier.
4. User selects a funding method and sees fee plus credited value.
5. Funding remains pending until partner confirmation is verified.
6. User chooses a task and receives a naira quote.
7. Meter reserves the approved maximum, performs the service, captures the final charge, and releases the remainder.
8. User receives the result and an itemized receipt.

**Success condition:** A new user can complete the journey without seeing a seed phrase, gas fee, token amount, or chain selection.

### 10.2 Failed AI request

1. User authorizes a quoted maximum.
2. Primary provider fails before delivering value.
3. Meter may use an approved fallback only if its maximum cost and data policy fit the authorization.
4. If fallback is unavailable or also fails, Meter releases the full reserve.
5. User sees no charge and a retry option.

### 10.3 Agent purchase

1. Agent requests a protected resource.
2. Provider returns machine-readable price and payment requirements.
3. Meter checks key status, allowlist, balance, per-call maximum, rate, and remaining budgets.
4. If policy permits, Meter signs or produces the approved payment authorization.
5. Provider verifies payment and returns the resource.
6. Meter logs policy evaluation, purchase, usage, and settlement result.
7. Threshold exceptions wait for human approval and expire without spending.

### 10.4 Provider payout

1. Captured transactions create provider payables and split allocations.
2. Refund exposure, holds, and minimum payout rules are applied.
3. Eligible payables join a settlement batch.
4. External payout executes through the approved route.
5. Reconciliation matches batch amount, beneficiaries, fees, and ledger entries.
6. Provider statement shows gross value through net settlement.

### 10.5 Session reaching its limit

1. Buyer authorizes a maximum amount or duration.
2. Timer begins only when both parties enter the billable session state.
3. Meter warns both parties before the limit.
4. At the limit, billing stops and the product ends or pauses the session according to disclosed policy.
5. Final elapsed billable time is captured and remaining reserve released.

### 10.6 Offline physical usage recovery

1. Approved device records signed, monotonic usage events while offline.
2. Device reconnects and uploads ordered events with unique identifiers.
3. Meter verifies signature, sequence, tariff version, prior checkpoint, and duplication status.
4. Meter captures only authorized usage and flags amounts exceeding the offline policy.
5. Operator and customer receive the reconciled reading and charge.

## 11. Customer experience requirements

- All customer-facing monetary values default to naira.
- Every purchase screen displays the unit, price basis, estimate if applicable, and hard maximum.
- The balance screen distinguishes available, pending, reserved, refunded, and restricted amounts.
- Receipts identify service, provider, unit consumed, price version, final amount, and refund status.
- The interface must not suggest that stablecoin balances appreciate or constitute an investment.
- Enabling automatic top-up requires explicit, revocable consent and a visible maximum.
- Default automatic top-up is off.
- Marketing consent is separate from service and data-processing consent.
- Refund and complaint entry points are available from the affected transaction.
- Destructive account actions explain consequences and required financial settlement.
- Accessibility target is WCAG 2.2 AA for core web journeys.
- Low-bandwidth journeys avoid unnecessary media and resume safely after interruption.

## 12. Data, privacy, and AI requirements

- Collect only data required for service delivery, compliance, security, and support.
- State the lawful basis and retention rule for each data category.
- Complete a Data Privacy Impact Assessment before public launch.
- Determine and complete applicable NDPC registration and compliance obligations.
- Encrypt sensitive data in transit and at rest.
- Keep KYC documents with the licensed or approved specialist partner when possible.
- Do not store raw prompts and responses by default longer than required for the chosen user experience and provider terms.
- Let users understand which provider receives their content before use.
- Offer deletion and export controls subject to financial-record retention obligations.
- Never place prompts, personal information, KYC data, session content, or physical-service identity on a public chain.
- Contractually prohibit model providers from training on Meter customer content unless the user explicitly selects a service whose disclosed terms allow it.
- Redact unnecessary sensitive fields from support and analytics tools.
- Maintain an incident response process with partner, customer, and regulatory notification paths.

## 13. Non-functional requirements

### 13.1 Reliability and integrity

| Measure | Target |
| --- | --- |
| Ledger availability | 99.95% monthly |
| Financial-command idempotency | 100% for recognized retries |
| Authorization latency | p95 below 500 ms, excluding external KYC |
| Daily reconciliation | Complete before the next settlement cycle |
| Unexplained ledger imbalance | Zero tolerance |
| Duplicate customer charges | Fewer than 1 per 100,000 transactions |
| Provider payout success | At least 99.5% |
| Critical financial incident acknowledgement | Within 15 minutes |
| Customer charge above approved maximum | Zero tolerance |

### 13.2 Security

- Apply least privilege to services, staff, providers, and agent credentials.
- Store secrets in a managed secret system and rotate them on policy or incident.
- Require multi-factor authentication for operations, finance, and provider administration.
- Maintain immutable security and financial audit logs.
- Run dependency, static, dynamic, and infrastructure security checks before release.
- Commission an independent penetration test before broad public funding access.
- Rate-limit authentication, funding, quoting, authorization, and provider endpoints.
- Maintain tested backup, restoration, disaster recovery, and key-recovery procedures.
- Separate production access from support visibility.

### 13.3 Observability

- Correlate a transaction across quote, authorization, provider request, usage, ledger, settlement, and reconciliation.
- Alert on authorization failure spikes, provider price variance, duplicate callbacks, ledger exceptions, payout failures, and reconciliation gaps.
- Exclude prompts, KYC records, and secrets from logs.
- Preserve metrics needed to reproduce stage gates and unit economics.

## 14. Compliance and operating model

### 14.1 Preferred funds structure

- A licensed Nigerian partner receives and safeguards customer funds.
- Meter maintains a synchronized sub-ledger and service-authorization layer.
- Customer funds are segregated from Meter operating funds.
- Customer refund and redemption rights are documented and implemented.
- Meter does not offer lending, yield, investment, or speculative token services.
- Customer balances and prices remain naira-denominated.
- USDC is used only in approved infrastructure and settlement flows.
- KYC, sanctions, transaction monitoring, limits, and reporting responsibilities are contractually assigned.

### 14.2 Required pre-launch opinions and agreements

Before public funding, Meter must possess:

- Written Nigerian legal advice on payments licensing and stored value.
- Partner agreement confirming custody, safeguarding, KYC, refunds, complaints, reconciliation, incident handling, and wind-down responsibilities.
- Written advice on digital assets and cross-border stablecoin settlement.
- Tax and accounting policy for top-ups, unused value, provider earnings, Meter revenue, VAT, FX, and withholding obligations.
- Privacy assessment under the Nigeria Data Protection Act and applicable NDPC guidance.
- Consumer terms covering price display, delivery, refund, complaint, suspension, and closure.
- Model-provider terms permitting the intended service and data flow.

### 14.3 Regulatory boundary

Calling a balance “credits” is not itself a compliance strategy. CBN materials assign wallet creation, e-money issuance, and pool-account management to regulated entities and require stored-value structures to be tied to appropriately safeguarded funds. Meter must obtain product-specific advice rather than infer permission from general guidance.

## 15. Business model and unit economics

### 15.1 Recommended pricing

| Product | Initial pricing hypothesis |
| --- | --- |
| Meter AI | 20–25% markup on wholesale model cost or an explicit fixed workflow price |
| Meter Agents | 5–8% of transaction value; optional organization plan after validation |
| Meter Providers | 6–10% of transaction value |
| Meter Content | 10% of purchase value |
| Meter Sessions | 8% of session value |
| Meter Physical | 2–4% of collections plus operator software fee |
| Naira funding | Transparent pass-through of unavoidable collection costs |

Volume discounts may not reduce price below cost-to-serve unless the founder approves a measured, time-limited acquisition experiment.

### 15.2 Stage 1 illustrative unit economics

For a user spending ₦5,000 per month:

| Item | Illustrative value |
| --- | ---: |
| Customer consumption | ₦5,000 |
| Underlying model cost at 80% of retail | ₦4,000 |
| Gross service margin | ₦1,000 |
| Funding and FX cost | ₦100–₦250 |
| Variable infrastructure, support, refund, and fraud allowance | ₦100–₦200 |
| Illustrative contribution margin | ₦550–₦800 |

These figures are planning assumptions. Meter must measure actual token mix, media generation, FX, funding route, support, refund, and fraud costs by cohort.

### 15.3 Financial definitions

```text
Net revenue
= customer charges
− provider and model obligations
− refunds and discounts

Contribution margin
= net revenue
− payment and FX costs
− chain and settlement costs
− variable infrastructure
− fraud and chargeback losses
− variable support costs

Operating profit
= contribution margin
− payroll
− compliance and legal
− fixed infrastructure
− sales and administration
```

Break-even transaction value:

```text
monthly fixed operating cost ÷ blended contribution-margin rate
```

| Monthly fixed cost | Blended contribution margin | Break-even monthly transaction value |
| ---: | ---: | ---: |
| ₦5 million | 20% | ₦25 million |
| ₦10 million | 12% | ₦83.3 million |
| ₦15 million | 8% | ₦187.5 million |

### 15.4 Scale scenarios

These scenarios are directional and exclude fixed operating costs:

| Scenario | Monthly transaction value | Contribution margin | Monthly contribution |
| --- | ---: | ---: | ---: |
| Early consumer validation | ₦25 million | 20% | ₦5 million |
| Mixed consumer and agent network | ₦100 million | 12% | ₦12 million |
| Provider-led network | ₦500 million | 8% | ₦40 million |
| Scaled multi-vertical network | ₦2 billion | 8% | ₦160 million |

### 15.5 Economic guardrails

- Stage 1 reaches positive per-user contribution margin before paid growth.
- No segment remains below 10% contribution margin for more than two consecutive months without written founder approval and a dated experiment.
- Promotional credits are reported separately from organic consumption.
- Provider earnings are liabilities, not Meter revenue.
- Revenue is recognized when service delivery is completed, not when a user tops up.
- Customer balances and provider payables do not fund operating expenses.
- FX exposure is minimized through frequent conversion and matched assets and liabilities.
- Meter maintains refund, chargeback, and fraud reserves based on observed losses.
- Unused balances follow partner, accounting, and consumer-protection policy and are never assumed to be free revenue.

## 16. Metrics and instrumentation

### 16.1 North-star metric

**Monthly retained transacting accounts generating positive contribution margin.**

An account is retained when it completes at least one paid transaction in the current month and at least one earlier month. An account is contribution-positive when its direct revenue exceeds all attributable variable costs.

### 16.2 Supporting metrics

| Area | Metrics |
| --- | --- |
| Acquisition | Verified sign-ups, funding conversion, customer acquisition cost |
| Activation | First funded use within 24 hours, time to first value |
| Engagement | Paid units per account, spend, transaction frequency |
| Retention | Week-1, week-4, and month-3 funded-user retention |
| Economics | Transaction value, take rate, gross margin, contribution margin, payback period |
| Reliability | Quote, authorization, provider, capture, and payout success rates |
| Trust | Refund rate, dispute rate, support contacts per 1,000 transactions |
| Risk | Fraud loss, chargebacks, blocked attempts, reconciliation exceptions |
| Supply | Active providers, concentration, integration time, provider retention |
| Settlement | Settlement delay, payout failures, unmatched balances |

Metrics are segmented by product, cohort, provider, service, funding method, acquisition channel, KYC tier, and price version.

### 16.3 Required product events

- `account_created`
- `kyc_started`
- `kyc_completed`
- `funding_started`
- `funding_confirmed`
- `funding_failed`
- `quote_presented`
- `quote_accepted`
- `authorization_approved`
- `authorization_declined`
- `service_started`
- `service_completed`
- `service_failed`
- `charge_captured`
- `reserve_released`
- `refund_requested`
- `refund_completed`
- `dispute_opened`
- `provider_settlement_created`
- `provider_settlement_completed`
- `reconciliation_exception_created`

Analytics events contain internal identifiers and classifications, not raw prompts, secrets, or unnecessary personal data.

## 17. Rollout strategy

### Phase A — Concierge validation

- 30–50 invited users.
- Manual top-up verification where permitted by the partner.
- Limited text models and a small number of repeatable workflows.
- Daily review of use, margin, refunds, and motivation.

### Phase B — Closed beta

- Up to 200 funded users.
- Automated partner funding and internal ledger.
- Text chat, document analysis, limits, receipts, and support.
- No paid acquisition.

### Phase C — Public Meter AI launch

- Open onboarding within approved KYC and risk limits.
- Public pricing and reliability status.
- Controlled referral program only after positive cohort contribution.
- Media-generation features added independently based on margin and demand.

### Phase D — Agent and provider expansion

- Invite-only Meter Agents.
- Provider sandbox before production approval.
- Third-party transaction share becomes a board-level or founder-level metric.

Later product stages follow the gates in Section 9 and do not receive committed delivery dates in advance.

## 18. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Users prefer free tiers or subscriptions | High | Test funded repeat behavior before broad build or acquisition |
| Nigerian international payment access continues improving | Medium | Lead with pay-as-you-go choice, workflows, and control rather than card exclusion |
| OpenRouter or major vendors localize | High | Differentiate through consumer experience, naira pricing, local distribution, and provider network |
| AI resale margin is too thin | High | Enforce margin floors, route by cost and quality, price workflows, grow B2B volume |
| Stored balances create licensing exposure | Critical | Use a licensed partner and written legal advice before public funding |
| FX movement erases margin | High | Short quote validity, price versioning, matched positions, frequent settlement |
| Variable charges create distrust | High | Display estimate, hard maximum, unit evidence, and itemized receipt |
| Providers over-report usage | High | Independent measurement, signed events, anomaly detection, and payout holds |
| Model terms or prices change | High | Multi-provider routing, versioned catalog, and contract monitoring |
| Circle, Arc, or x402 becomes unsuitable | Medium | Maintain a chain-agnostic ledger and replaceable adapters |
| Sensitive customer content leaks | Critical | Data minimization, encryption, retention controls, provider disclosure, incident response |
| Fraud consumes model or promotional credits | High | Staged KYC, velocity checks, device risk, funding confirmation, delayed payouts |
| Physical telemetry is inaccurate | Critical | Certified partners, signed readings, tolerance rules, and evidence-based disputes |
| Vertical expansion overwhelms the team | High | Enforce entry and exit gates; create separate PRDs and accountable owners |

## 19. Kill and pivot criteria

Meter must reconsider the consumer AI wedge if, after a properly recruited 90-day beta:

- Fewer than 100 users fund an account.
- Fewer than 30% of funded users remain active after four weeks.
- Median usage remains below five paid actions per active week.
- Contribution margin remains below 10% after pricing and routing optimization.
- More than 20% of funded users request refunds of unused balances.
- The leading purchase motivation is a temporary card limitation rather than durable pay-as-you-go value.

Meter must pause the broader platform if:

- A compliant custody and refund structure cannot be secured economically.
- Provider terms prevent resale at viable margins.
- The ledger and reconciliation process cannot maintain complete financial integrity.
- Third-party provider demand remains weak after Meter AI and Meter Agents pass their gates.

If consumer retention is weak but agent usage is strong, Meter will pivot toward B2B agent budgets and payment infrastructure instead of continuing consumer acquisition.

## 20. Dependencies

### External dependencies

- Licensed Nigerian collection, custody, KYC, and payout partner.
- At least two model or AI-service providers with commercially permitted use.
- Reliable FX quotation and settlement route.
- Circle Gateway, Arc, or another approved settlement route when external programmable settlement is required.
- x402-compatible tooling for agent flows.
- Email, phone, passkey, observability, and customer-support providers.
- Hardware and operator partner before Meter Physical.

### Internal capabilities required before scale

- Founder/product owner.
- Financial-ledger engineering ownership.
- Backend and security capability.
- Web/mobile product capability.
- Finance and reconciliation operations.
- Compliance and legal counsel.
- Customer support and risk operations.
- Provider partnerships and onboarding.

One person may cover multiple roles during validation, but finance/reconciliation and security controls require independent review before broad public access.

## 21. Release acceptance

The first public Meter AI release is acceptable only when all conditions below are satisfied:

### Product

- A qualified user can create, recover, fund, spend, review, and close an account.
- Every paid service shows an exact or maximum naira price before authorization.
- Failed delivery results in zero charge or a verifiable partial charge.
- Daily and monthly hard limits cannot be bypassed by concurrent requests.
- Users can initiate support and eligible refund requests from a transaction.

### Financial integrity

- All financial events post balanced journals.
- Duplicate partner and provider callbacks do not duplicate value.
- Available, pending, reserved, provider payable, and Meter revenue accounts reconcile.
- A full transaction can be reconstructed from source event to settlement.
- Disaster recovery restores the ledger without missing or duplicated journals.

### Compliance

- Required legal, tax, privacy, consumer, provider, and partner documents are approved.
- KYC tiers and transaction limits are enforced.
- Customer and provider funds are safeguarded according to the partner structure.
- Data-retention, deletion, access, and incident procedures are operational.

### Reliability and security

- Core service targets in Section 13 are met during beta load testing.
- High-severity penetration-test findings are resolved.
- Alerts and incident runbooks have been exercised.
- Refund, provider failure, partner outage, chain outage, and reconciliation exception drills pass.

### Economics

- Real beta usage demonstrates positive contribution margin for the intended launch cohort.
- Pricing reflects current provider cost, funding cost, FX, refund, fraud, support, and infrastructure allowances.
- Promotional spend and organic spend are reported separately.

## 22. Decisions fixed by this PRD

- Meter launches in Nigeria with Meter AI.
- The company uses a shared-core, sequential-vertical strategy.
- Naira is the customer-facing unit of account.
- A licensed partner is the preferred holder of regulated customer funds.
- An internal double-entry ledger is the product source of financial truth.
- External settlement may be batched.
- Arc, Circle, and x402 are adapters rather than core-domain dependencies.
- Medical, legal, lending, investment, P2P transfer, and proprietary hardware products are excluded from initial scope.
- Expansion is controlled by evidence gates, not calendar promises.

## 23. Immediate next actions

1. Replace the thesis statements identified in Section 2.3.
2. Conduct Stage 0 interviews and funded-intent testing.
3. Commission the required Nigerian payments, digital-assets, privacy, consumer, and tax review.
4. Shortlist licensed custody and payment partners.
5. Confirm model-provider commercial terms.
6. Produce a release-level Meter AI PRD using the Stage 1 scope in this document.
7. Build an implementation plan only after the Meter AI release PRD is reviewed and approved.

## 24. Reference sources

- [Circle: Nanopayments](https://www.circle.com/nanopayments)
- [Circle: Nanopayments powered by Gateway live on mainnet](https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet)
- [Circle: Arc mainnet launch](https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet)
- [Central Bank of Nigeria: Payment service providers and frameworks](https://www.cbn.gov.ng/PaymentsSystem/PSPs.html)
- [Central Bank of Nigeria: PSP licensing framework](https://www.cbn.gov.ng/out/2020/ccd/categorization%20of%20psps.pdf)
- [Central Bank of Nigeria: Stored value and prepaid guidance in Rule Book Volume 1](https://www.cbn.gov.ng/out/2020/fmd/cbn%20rule%20book%20volume%201.pdf)
- [Nigeria Data Protection Commission: Nigeria Data Protection Act 2023](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023)
- [Nigeria Data Protection Commission: GAID 2025](https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf)
- [FCCPC: Consumer Protection Exposure Drafts, April 2026](https://fccpc.gov.ng/wp-content/uploads/2026/04/FCCPC-Consumer-Protection-Exposure-Notice.pdf)
- [OpenRouter pricing](https://openrouter.ai/pricing)
- [Paystack pricing](https://paystack.com/pricing)
- [Flutterwave Nigeria pricing](https://flutterwave.com/ng/pricing)
- [Access Bank: Naira card global spending FAQ](https://www.accessbankplc.com/access/media/documents/FAQs-Guide-Naira-Card-for-Global-Spending-min-1.pdf)
- [Fidelity Bank: International transactions on naira debit cards](https://www.fidelitybank.ng/fidelity-bank-resumes-international-transactions-on-naira-debit-cards/)

---

## Approval record

The founder approved the strategy, customer scope, architecture, staged product definition, business model, compliance posture, metrics, and kill criteria during the design review on 2026-09-20. The written PRD remains subject to final founder review.
