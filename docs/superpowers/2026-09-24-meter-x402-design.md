# Meter x402 Payments Design

**Status:** Approved 2026-09-24: omnibus custody, `@noble/hashes` + `@noble/curves`, Base Sepolia as the only live network, finality at the `safe` block tag.

**Date:** 2026-09-24

**Related:** [agent mandates design](2026-09-24-meter-agent-mandates-design.md) · ticket breakdown AG-7 · [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) · [HTTP transport v2](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md) · [`exact` scheme on EVM](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)

## 1. Purpose

Let an agent pay for any x402-protected HTTP resource **per request**, in USDC,
under the same mandate that governs its airtime purchases, without the agent
ever holding a key.

Airtime proved the authority model against a provider with a fixed price and a
yes/no delivery. x402 is harder in the ways that matter:

- **The payment instrument is a bearer credential.** A signed EIP-3009
  authorization can be submitted on-chain by anyone. Signing it *is* spending,
  so it must happen only inside an approved, reserved authorization.
- **Delivery truth lives on a public ledger, not in a provider API.** Meter must
  learn the outcome from the chain, and must not believe the agent, the
  resource server or the facilitator about it.
- **Price is set by the counterparty at request time,** in a signed-by-nobody
  header. Policy has to bind the counterparty, the resource and the amount.
- **Reorgs and finality** replace "the provider said so".

### 1.1 In scope

- Meter as the **paying side** of x402 v2, `exact` scheme, EIP-3009 on EVM.
- Base Sepolia (`eip155:84532`) testnet USDC only, behind `METER_AGENTS_SANDBOX`.
- A USDC mandate category `x402` with counterparty and resource allowlists.
- Deterministic authorization signing, chain-watching finalization, reconciliation.
- An MCP tool `fetch_paid` that performs the whole 402 → pay → retry loop.
- A self-contained sandbox: simulated chain, a paywalled demo resource and a
  facilitator, so the whole loop runs offline and in CI; plus a live Base
  Sepolia mode against a real facilitator.
- Invariants I16–I20 in `test:financial`.

### 1.2 Out of scope

Meter as a facilitator or as a seller; Permit2 (`x402ExactPermit2Proxy`);
Solana, Stellar and mainnet; funding USDC from NGN (FX); per-owner on-chain
wallets; the `upto`/`defer` schemes.

## 2. How x402 v2 works (the parts we depend on)

```text
Agent ── GET /resource ─────────────────────────────▶ Resource server
      ◀─ 402  PAYMENT-REQUIRED: base64(PaymentRequired) ─┘
          { x402Version: 2, resource: {url,…}, accepts: [PaymentRequirements…] }
          PaymentRequirements = { scheme:"exact", network:"eip155:84532",
            amount:"<atomic>", asset:"0x036C…CF7e", payTo:"0x…",
            maxTimeoutSeconds, extra:{ name:"USDC", version:"2" } }

Agent ── GET /resource  PAYMENT-SIGNATURE: base64(PaymentPayload) ──▶
          { x402Version: 2, resource, accepted: <one PaymentRequirements>,
            payload: { signature, authorization:
              { from, to, value, validAfter, validBefore, nonce(bytes32) } } }
      Resource server ── /verify, /settle ──▶ Facilitator ── transferWithAuthorization ──▶ chain
      ◀─ 200  PAYMENT-RESPONSE: base64({ success, transaction, network, payer })
```

The signature is EIP-712 over USDC's `TransferWithAuthorization(address from,
address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32
nonce)` with domain `{ name, version, chainId, verifyingContract: asset }`.

The property this design rests on: **an EIP-3009 authorization can be executed
at most once (its nonce), and never after `validBefore`.** So after
`validBefore`, "not executed on-chain" is a definitive, permanent answer.

## 3. Architecture

```text
apps/mcp            fetch_paid tool: GET → 402 → POST /v1/agent/x402/payments → retry with PAYMENT-SIGNATURE
apps/server
  modules/core/authorization     unchanged policy engine; x402 is a new category
  modules/products/agents/x402   NEW  payment intents, signing, finalization
  adapters/chain                 NEW  ChainPort: authorizationState, balanceOf, getLogs
                                        · SimulatedChain (in-process EIP-3009 token)
                                        · BaseSepoliaRpc (JSON-RPC over fetch)
  adapters/signing               NEW  SignerPort: EIP-712 sign with the sandbox hot key
  sandbox/x402                   NEW  demo paywalled resource + simulated facilitator
```

The agent never sees a private key. Meter signs **only** inside TX1, after
policy approval and reservation, and the signed payload is the product of the
purchase.

### 3.1 Custody model (decision)

**Omnibus hot wallet.** One Meter-controlled testnet address pays every x402
request; each owner's USDC is tracked in their `customer_available` ledger
account, exactly as NGN is. The on-chain wallet is Meter's operating float.

| Option | For | Against |
| --- | --- | --- |
| **Omnibus (chosen)** | One key, one float to reconcile; matches how the ledger already models custody | Counterparties see Meter, not the owner, as payer |
| Per-owner derived keys (HD) | Per-owner on-chain attribution | Per-owner float and gas funding; N reconciliations; more key material |
| Agent-held keys | Non-custodial | Mandates become unenforceable: the agent can sign anything |

Sandbox key from `METER_X402_SIGNER_KEY` (testnet only; boot refuses a key in
production). Production custody (KMS/HSM signer behind `SignerPort`) is a
Stage 2 gate item, not this design.

## 4. Payment lifecycle

### 4.1 Request (TX1, `POST /v1/agent/x402/payments`)

Input: the raw `PAYMENT-REQUIRED` header value, the resource URL and method the
agent is calling, `intent`, and an optional `max_amount`.

1. **Parse and select.** Decode base64 JSON; require `x402Version: 2`; pick the
   first `accepts` entry with `scheme:"exact"`, a supported `network`, and
   `asset` equal to that network's configured USDC contract. Anything else:
   `X402_UNSUPPORTED` (no policy evaluation, nothing recorded as a spend).
2. **Bind.** `resource.url` must match the URL the agent says it is calling
   (same origin and path); amount must be ≤ `max_amount` if given;
   `maxTimeoutSeconds` is clamped to `[30, 300]`.
3. **Policy** (existing evaluator, §6.1 of the mandates design) with
   `category = "x402"`, `amount = requirements.amount` (USDC has 6 decimals,
   which is already the ledger's atomic unit for `USDC`), and **two**
   destination checks: `payTo` must be in the mandate's allowed counterparties
   and the resource origin in its allowed origins, if either list is set.
4. **Reserve** as today, in the mandate's USDC accounts.
5. **Sign.** Build the authorization:
   - `from` = omnibus address, `to` = `payTo`, `value` = `amount`
   - `validAfter` = now − 60s (clock skew), `validBefore` = now + clamped timeout
   - `nonce` = `keccak256("meter.x402" ‖ payment_id)` — deterministic, so a
     retried TX1 or a replayed request can only ever produce the **same**
     authorization, never a second spendable one.
6. **Persist** the payment row (state `signed`) with the authorization fields
   and signature, in the same transaction.

Output: `202` with `payment_signature` (base64 `PaymentPayload`, ready for the
header), `payment_id`, `valid_before`. Idempotency and replay behave as for
airtime purchases.

Signing is a local CPU operation with no network I/O, so it is allowed inside
TX1 (the "no network call in a transaction" rule is untouched).

### 4.2 States

| state | meaning | ledger | canonical |
| --- | --- | --- | --- |
| `declined` | policy said no | nothing | `declined` |
| `signed` | authorization issued, not seen on-chain | reserved | `authorized` |
| `settled` | chain shows the nonce used, at the finality depth | captured → `provider_payable` | `captured` |
| `lapsed` | `validBefore` passed and the nonce is unused at finality | released | `expired` |
| `unresolved` | chain unreadable past the review deadline | reserved | `in_progress` |

```text
signed ──▶ settled      (authorizationState(from, nonce) = true at finality depth)
signed ──▶ lapsed       (now > validBefore + grace AND state = false at finality depth)
signed ──▶ unresolved   (RPC unavailable past deadline) ──▶ settled | lapsed (operator, with evidence)
```

There is no `unknown → guess` path. Before `validBefore`, an unused nonce means
"not yet"; after it, the same reading means "never".

### 4.3 Finalization worker

The finalizer gains an x402 claim loop with the same lease/SKIP LOCKED shape:

- Poll `authorizationState(omnibus, nonce)` for due `signed` rows. Cheap: one
  `eth_call` per payment; batched with `eth_call` multicall where available.
- **Finality.** Read at the `safe` block tag (Base publishes it); config
  `X402_CONFIRMATIONS` fallback for RPCs without it. A `true` read at `latest`
  only schedules a faster recheck.
- **Evidence.** On `settled`, fetch the `AuthorizationUsed(authorizer, nonce)`
  log and the `Transfer` in the same transaction; store tx hash, block number
  and the transferred `value`. If `value` ≠ signed value or `to` ≠ `payTo`,
  that is impossible for a correct token and raises a critical alert; the
  payment goes `unresolved` rather than captured.
- **Lapse grace.** Release only when the `safe` block's timestamp is past
  `validBefore` (chain time, not our clock) and the nonce is still unused.
- **Agent hint.** `POST /v1/agent/x402/payments/:id/settlement` accepts the
  `PAYMENT-RESPONSE` the agent received. It only moves `next_action_at` to now;
  it never changes state. The chain decides.

### 4.4 Reconciliation

Customer USDC in the ledger (available + reserved, all owners) is what the
omnibus must hold. A payment settled on-chain but not yet captured has already
left the wallet while still counting as reserved, so it is subtracted. Read at
the same `safe` block:

```text
expected = Σ customer USDC (available + reserved)
         − Σ value of AuthorizationUsed(omnibus, nonce) at safe whose payment is still `signed`

on-chain balanceOf(omnibus) at safe  −  expected  =  float
```

A negative float (the wallet holds less than customers are owed) pages. A
positive float is Meter's own money, e.g. testnet USDC funded out of band. It also scans `AuthorizationUsed` logs from the
omnibus address for **nonces Meter never issued**: proof the signing key was
used outside the policy path (key compromise) → page, and stop signing.

## 5. Mandate, policy and ledger changes

- **Origins reuse `allowed_destinations`.** A destination is a phone number for
  airtime and a resource origin (`https://host[:port]`) for x402; one list, one
  check (6).
- **`allowed_counterparties text[]`** (new, nullable): lower-cased `payTo`
  addresses, checked alongside the destination when set.
- **Duplicate key.** The duplicate guard (check 8) keys on destination + amount.
  For x402 that would block legitimate repeated calls to one origin at one
  price, so `PolicyRequest` gains an optional `duplicateKey`: the full resource
  URL (method + URL, query included) for x402, the destination for airtime.
- **A mandate has one asset.** Airtime requires `NGN`; `x402` requires `USDC`.
  A USDC mandate uses the owner's USDC accounts (`ensureCustomerAccounts`
  already takes the asset). Sandbox funding: `POST /v1/sandbox/credit` gains
  `asset`.
- **USDC system accounts.** Migration 0012 seeds `external_cash` and
  `provider_payable` for USDC, and capture resolves `provider_payable` by the
  reservation's asset instead of the NGN constant.

## 6. MCP: `fetch_paid`

| Input | |
| --- | --- |
| `url` | https only (http allowed for `localhost` in sandbox) |
| `method`, `body`, `headers` | forwarded; `authorization`/`cookie` headers are refused |
| `max_amount_usdc` | hard ceiling for this call |
| `intent` | as for `buy_airtime` |

Behaviour: request → if not 402, return the response; if 402, decode
`PAYMENT-REQUIRED`, show nothing to the model yet, call
`POST /v1/agent/x402/payments`, retry **once** with `PAYMENT-SIGNATURE`,
forward any `PAYMENT-RESPONSE` to Meter as a hint, and return status, a
truncated body, the price paid and `payment_id`. Denials come back as tool
results with the §6.3 explanation, as for airtime. It never retries a paid
request: a second 402 after paying is returned to the model with the
`payment_id` so it can check status instead of paying twice.

## 7. Sandbox

- **SimulatedChain:** an in-process EIP-3009 token (balances, `authorizationState`,
  EIP-712 recovery, `transferWithAuthorization` with `validAfter`/`validBefore`
  and nonce checks) plus a block clock with a configurable `safe` lag. It is the
  `ChainPort` in tests and the default in sandbox.
- **Demo resource:** `GET /v1/sandbox/x402/oracle?q=…` answers 402 with real v2
  requirements, verifies via the simulated facilitator, settles on the
  simulated chain and returns a result with `PAYMENT-RESPONSE`. Fault switches
  mirror the airtime simulator: settle late, never settle, settle after
  `validBefore` (must fail on-chain), return 200 without settling.
- **Live mode:** `METER_X402_CHAIN=base-sepolia` uses JSON-RPC and a real
  facilitator against testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## 8. Dependencies (decision)

EIP-712 needs keccak-256 and secp256k1 signatures with a recovery id. Node's
`crypto` has neither keccak (its `sha3-256` is FIPS SHA-3, a different padding)
nor recoverable ECDSA. Proposed: **`@noble/hashes` and `@noble/curves`**:
audited, zero-dependency, no install scripts, and the primitives every
mainstream EVM library is built on. ABI encoding and JSON-RPC are small enough
to write by hand (~150 lines, with test vectors from the EIP-712 and EIP-3009
references). `viem`/`ethers` are rejected: 10–50× the surface for four
functions. Added in its own commit per the dependency policy.

## 9. Invariants (added to `test:financial`)

| ID | Invariant | Proof |
| --- | --- | --- |
| I16 | Meter signs an authorization only for an approved, reserved payment, for exactly the reserved value and the requirement's `payTo`/`asset` | Property test over random requirements and policy outcomes; every signature recovers to the omnibus and its fields equal the reservation |
| I17 | Each payment id yields at most one distinct authorization | Retries, replays and concurrent TX1s: all returned payloads identical; nonce is a function of payment id |
| I18 | A hold is released only when chain time is past `validBefore` and the nonce is unused at finality | Simulated chain with reorgs and `safe` lag; release before that never happens; late settlement attempts fail on-chain |
| I19 | A hold is captured only on an on-chain `AuthorizationUsed` at finality, for the signed value | Agent/facilitator/resource lies (200 without settling, forged `PAYMENT-RESPONSE`) never capture |
| I20 | Omnibus on-chain balance reconciles to the ledger; any foreign nonce is detected | Reconciliation job over random settle/lapse/deposit sequences, plus an injected out-of-band transfer |

Plus unit vectors: EIP-712 digest against the published EIP-712 "Mail" example
and a USDC `TransferWithAuthorization` fixture; signature recovery round-trip;
base64 header codecs against the spec's examples.

## 10. Tickets

| ID | Ticket | Size | Done when |
| --- | --- | --- | --- |
| X-01 | `@noble/*` dependency commit; keccak/EIP-712/ABI helpers with vectors | S | Vectors pass |
| X-02 | `SignerPort` + sandbox signer; `ChainPort` + `SimulatedChain` | M | Simulated token passes EIP-3009 conformance tests |
| X-03 | Migration: `agents.x402_payments`, mandate allowlists, USDC funding | S | Applies cleanly on 0011 |
| X-04 | TX1: parse/select/bind, policy, reserve, deterministic sign | M | I16, I17 |
| X-05 | Finalizer: settle/lapse at finality, evidence, unresolved | M | I18, I19 |
| X-06 | Reconciliation + foreign-nonce detection | S | I20 |
| X-07 | Sandbox paywalled resource + simulated facilitator | M | Full loop offline |
| X-08 | MCP `fetch_paid` | M | Claude completes the §11 script |
| X-09 | Base Sepolia RPC adapter + live facilitator mode | M | One real testnet payment settles and captures |
| X-10 | Owner UI: USDC covenants, origin/counterparty allowlists, x402 chronicle | M | Visible end to end |

Cut order if time is short: X-10, X-09 (keep the simulated chain), reconciliation
alerts (keep the invariant test). Do not cut deterministic nonces, finality, or
chain-time lapse: those are the design.

## 11. Demo script

1. Owner credits 25 USDC (sandbox) and draws a USDC covenant: per payment 0.50,
   per day 5.00, origins `http://localhost:3001`.
2. "What does the oracle say about Lagos weather?" Claude calls `fetch_paid`;
   the resource answers 402 for 0.10 USDC; Meter signs; the retry returns 200.
   The chronicle shows reserve → signed → `AuthorizationUsed` at block N → capture.
3. A resource on an origin not in the covenant → `DESTINATION_NOT_ALLOWED`;
   nothing signed.
4. Fault "never settles": Claude reports it paid but got no data; after
   `validBefore` the hold is released, and the chronicle shows why it was safe.
5. Fault "200 without settling": the agent got data, the chain shows nothing,
   Meter does not capture; after `validBefore` it releases. The seller lost
   out, not the owner.
6. Revoke the seal; the next `fetch_paid` fails `CREDENTIAL_REVOKED` before any
   signature exists.

## 12. Decisions

All approved 2026-09-24: omnibus custody (§3.1); `@noble/hashes` + `@noble/curves` (§8);
Base Sepolia as the only live network; finality read at the `safe` block tag,
with `X402_CONFIRMATIONS` only as a fallback for RPCs without it.

## 13. As built (2026-09-24)

All tickets X-01 to X-10 are implemented. Where the build differs from the text above:

- **Requery input.** `ChainPort` reads by (authorizer, nonce); nothing else needed it.
- **Origins** live in `allowed_destinations` (§5); `allowed_counterparties` is the only new mandate column.
- **Read order.** The finalizer reads the safe head *before* the nonce state, so an
  "unused" reading always covers every block up to the head used to judge a lapse.
  Reading the other way round could miss a use landing between the two reads.
- **Who runs the loops.** The simulated chain lives in the API process's memory
  (the sandbox resource settles on it there), so in sandbox the API runs the x402
  loops; against Base Sepolia the worker does.
- **Sandbox faucet.** After a restart, or when another process (`demo:setup`)
  credits USDC, the simulated chain mints the shortfall into the omnibus. Live
  chains get the under-backing alert instead.
- **Live USDC funding** is refused by the sandbox credit route (`FUND_ON_CHAIN`):
  the ledger may only be credited against USDC actually sent to the omnibus.
- **Evidence** is the USDC `Transfer` log in the same transaction as
  `AuthorizationUsed`; a mismatch with what was signed sends the payment to
  `unresolved` with a fatal alert rather than capturing it.
