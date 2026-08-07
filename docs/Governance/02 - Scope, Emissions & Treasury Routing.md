# GOV / veGOV — Big Picture (Idea #2)

## Where this picks up

Continues `01 - veGOV Foundations.md`, which reframed the core question from "should we clone veCRV" to "what should one unit of veGOV actually represent," and proposed separating governance power / economic exposure / risk commitment instead of collapsing them into one token balance. This doc captures the next layer of open questions, raised before diving into implementation: token distribution, cross-protocol scope, emissions, and reserve-routing mechanics.

## 1. What replaces curator

The `curator` role (today: a single EOA per `Stablecoin.sol` and each adapter, timelock-guarded) becomes a contract controlled by a DAO-style mechanism — conceptually similar to how Aragon-style DAOs already operate (propose → vote → execute). The concrete execution mechanism (extend the existing `PendingAddress`/timelock pattern already in the codebase, adopt OZ Governor+TimelockController, or something bespoke) is explicitly **deferred** — not decided yet, and not the focus of this doc.

## 2. How to get GOV tokens (distribution)

Open question. Ideas raised so far:

- Start with a fixed initial supply (some amount `x`) distributed at genesis.
- Seed a Curve crypto pool, e.g. **GOV-USDU**, for price discovery and liquidity from day one.
- Possibly ongoing emissions on top of the initial distribution (see §5) as an incentive layer, not just a one-time sale.
- Idea #1's caution still applies: avoid a "buy GOV = own the reserve" narrative. Distribution should read as bootstrapping coordination capital, not selling equity.

## 3. What GOV / veGOV can do — cross-protocol scope

Important scope expansion versus Idea #1: GOV isn't necessarily scoped to a single stablecoin. The intent is a **shared governance token across a family of similarly-structured stablecoins** — USDU, EURU, CHFU, etc. — with one GOV/veGOV governing curator-equivalent decisions across all of them.

This means veGOV voting power and reserve-routing logic need to eventually resolve one of:

- **(a)** one global pool of voting power spent across N independent per-protocol proposal queues, or
- **(b)** N separate delegated sub-governances that all draw eligibility from the same underlying veGOV lock.

Not resolved yet — flagged as a decision to make explicitly, since it significantly changes the shape of the governor contract(s).

## 4. Voting weight: time-weighted vs pure accumulation

Still undecided between:

- **veGOV-style**: weight = f(amount locked, time locked) — Curve/Solidly-style.
- **Plain GOV accumulation**: weight = balance held (or staked), no time-lock requirement.

Underlying this is the four-dimension framing from Idea #1, still open:

1. **Capital commitment** — "I locked my GOV."
2. **Protocol contribution** — "I helped generate revenue."
3. **Risk commitment** — "I'm economically exposed to the protocol's success/failure."
4. **Time commitment** — "I'm committed for years."

Curve mostly conflates #1+#4 into one number. Nothing forces the same choice here — worth revisiting once cross-protocol scope (§3) is settled, since "time commitment to which protocol" gets murkier across a family of stablecoins.

## 5. Emissions as an incentive layer (Curve's model)

Curve emits new CRV every epoch (1 week) as gauge incentives — inflationary, on a decaying schedule. This is distinct from revenue-sharing (Idea #1's Model B) or buybacks (Model C): emissions **create new supply** to reward specific behavior, rather than routing existing revenue.

Where this could plug into adapters: a strategy adapter that

1. accepts USDC deposits,
2. runs a yield strategy (swaps, borrow, yield-spread capture, etc.),
3. farms yield from an external source,
4. routes that yield into the protocol reserve,
5. compensates the depositors who funded the adapter with newly-minted GOV.

This is structurally the same as Curve gauge emissions (reward LPs with new CRV for providing depth), applied to reserve-funding adapters instead of AMM pools. It gives GOV emissions a real utility hook — bootstrapping adapter TVL / reserve growth — instead of being a pure inflation giveaway, and ties emission volume to actual reserve contribution rather than an arbitrary schedule alone.

Open and unresolved: should the emission rate be a **fixed decaying schedule** (Curve-style, time-based — predictable, simple to reason about) or **performance-based** (scaled to yield actually delivered to the reserve — ties inflation to real value created, but adds a measurement/oracle surface)?

## 6. veGOV-directed reserve/revenue allocation

Extends Idea #1's "Model C" (reserve-backed buyback flywheel) into a concrete voting surface: veGOV votes on how protocol revenue is routed across competing destinations, e.g.:

| Route | Example split | Purpose |
|---|---|---|
| Reserve strengthening | 50% | stability capital backing the stablecoin(s) |
| Adapter incentives | 25% | bootstrap TVL/depth in yield adapters (possibly paid in new GOV, §5) |
| GOV buybacks | 15% | protocol becomes a natural buyer of its own governance asset — reflexive value accrual without a direct redemption promise |
| Operations | 10% | team/infra/ops costs |

Additional routes raised in conversation: Curve gauge incentives/bribes to deepen the GOV-USDU pool specifically, and lending adapters where users lock USDU for yield (a stablecoin-native yield product funded from the same revenue pool).

Idea #1's guardrail still applies: this routing power should stay bounded by hard limits / risk-council oversight so it can't be used to drain the reserve outright. This stays a Layer-1 (governance) decision, not something Layer-2 (Guardian) touches.

## 7. What this adds up to

> "We are building a programmable central bank with external monetary modules."

GOV/veGOV, in this framing, isn't governing one lever — it's governing all of them together, potentially across a family of stablecoins:

- **monetary expansion** (mint capacity, adapter approval — curator's current job)
- **risk exposure** (collateral/adapter risk parameters)
- **yield strategy** (which adapters run, how they're incentivized)
- **reserve allocation** (the routing table in §6)

Which is why Idea #1's closing question still stands as the one to resolve next: **what does one unit of veGOV actually represent** — and now, additionally, **across how many protocols does it represent it**.

## Explicitly deferred (raised earlier, parked for later)

- Lock representation: non-transferable balance (classic veCRV) vs veNFT (Solidly-style, echoing the NFT-position pattern already drafted for `BorrowMarketV1`).
- Decay curve shape: continuous linear decay vs discrete duration tiers.
- Governor execution mechanism: extend existing `PendingAddress`/timelock pattern vs OZ Governor+TimelockController vs bespoke.
- `BorrowMarketV1` specifics (collateral whitelisting mechanics) — separate module, not the focus of this governance discussion.
