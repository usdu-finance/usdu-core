# GOV Pool Seeding, Minting Adapter & veGOV Structure (Idea #4)

## Where this picks up

Continues `01 - veGOV Foundations.md`, `02 - Scope, Emissions & Treasury Routing.md`, and `03 - Protocol Architecture & Aragon Reuse.md`. Doc `03` concluded: reuse the existing Aragon OSx DAO core (`curator == aragonDao`), and build a custom veGOV-weighted plugin to replace `AragonMultiSig` as the thing authorized to create/execute proposals — while leaving several questions explicitly open: lock representation, decay curve shape, whether `AragonVetoMultiSig` stays a trusted multisig or becomes veGOV-gated, and per-protocol vs. shared DAO scope.

This doc resolves two of those (decay curve shape, veto plugin's fate) with a concrete preference, and adds a mechanism doc `03` didn't cover: a GOV-minting liquidity-seeding adapter that gives GOV an initial market and a revenue-funded way to support its price afterward. `05 - GOV and veGOV Token Structure.md` continues from here into the actual contract shape of `GOV.sol`/`veGOV.sol`.

## 1. GOV pool structure — three pools, one token

GOV is quoted against each protocol stablecoin independently:

```text
GOV-USDU        GOV-EURU        GOV-CHFU
```

Pool type: **Curve Cryptoswap (v2)**, not StableSwap or fxSwap. Both of those assume a computable peg/rate — fxSwap in particular is built for "low-volatility, correlated pairs" (forex-style, e.g. crvUSD/EURC) and explicitly recommends Cryptoswap for volatile assets. GOV has no such peg: it's deliberately market-driven, and the treasury backing it holds multiple, uncorrelated currencies, so there's no single honest `rate()` to feed a rate-oracle pool. Cryptoswap makes no peg assumption — it does pure market-driven price discovery via an internal EMA, which is the correct fit here.

Because all three pools quote the same GOV token, they're arbitrage-linked: price support (or damage) in any one pool propagates to the others as arbitrageurs correct the implied cross-rate. This matters operationally — a price-support mechanism only needs to run against one pool (see §3) to have a global effect on GOV's price, not three separate, duplicated executions.

## 2. Seeding mechanics

Seeding happens through a minting adapter: mints GOV, pairs it with treasury stablecoin, deposits both into the target pool. Structurally the same shape as the other curator-approved, mint-capable adapters described in doc `03` §2 — gated the same way, funneling into the same treasury.

Concretely, confirmed against `contracts/stablecoin/Stablecoin.sol`: the adapter is registered exactly the way any mint-capable module is registered today — `setModule(module, expiredAt, message)` → `MIN_TIMELOCK` (7 days) to `MAX_TIMELOCK` (4 weeks) delay → `acceptModule(module)`, which grants `mintModule` access until `expiredAt` (module validity is expiry-based, not a permanent boolean). `GOV.sol` mirrors this mechanism directly (see doc `05`), so registering the seeding adapter on GOV works identically to registering a mint-capable adapter on USDU today — no new access-control pattern needed.

```text
Treasury USDU ──┐
                 ├──> mint matching GOV ──> add_liquidity (balanced) ──> GOV-USDU pool
DAO proposal ────┘
```

- **USDU/GOV**: seeded 1:1 — 1 GOV = $1.
- **EURU/GOV** and **CHFU/GOV**: must be seeded at the *real-time FX rate* for that currency, not a naive 1:1. If all three pools are seeded as if 1 GOV = 1 unit of each stablecoin, and EUR/USD or CHF/USD isn't actually 1:1, the pools disagree with each other about GOV's USD price the moment they go live — free arbitrage, extracted from the DAO's own seed liquidity, until the mispricing is gone. Seed EURU/CHFU pools at GOV-price × current EUR/USD (resp. CHF/USD).

## 3. Post-seeding DAO strategies for the adapter

Two strategy shapes for the DAO to direct, post-seeding:

**(a) Reduce the adapter's minted-GOV debt** — the adapter tracks how much GOV it minted to seed/deepen pools; the DAO can direct it to buy back and burn (or otherwise retire) that debt over time.

**(b) One-sided liquidity provision to deepen a pool, funded by protocol profit.**

This is the "donate profit → GOV price support" mechanism from earlier in this design conversation, and it's worth being precise about what it actually does, because two different-looking actions get confused easily:

```text
Balanced mint + deposit              One-coin deposit (no new mint)
────────────────────────             ──────────────────────────────
mint GOV matched to pool ratio       swap profit (USDT/USDC/etc.) -> USDU
add_liquidity, both sides            add_liquidity, USDU side only

= price-neutral                      = price-positive
= pure depth increase                = Curve v2 charges an imbalance fee
= dilutive (new GOV printed)           on this, same reasoning as a swap —
                                        it shifts the invariant the same way
                                      = non-dilutive, funded by real revenue
```

The one-coin deposit is the one that matches the original goal ("DAO donates profit, GOV price increases") — it is *not* price-neutral, and that's the point. It should be named and reasoned about as a revenue-funded buyback-like action, not as neutral depth-adding.

**Guardrails discussed for this action** — two different things need timelocking, worth keeping separate:
- **Registering the adapter as a module** (§2) already has a real precedent, not something to invent: `Stablecoin.sol`'s `setModulePublic`/`claimPublicFee` path lets *anyone* submit the registration once they pay `ConstantsLib.PUBLIC_FEE` (10,000 tokens, transferred to `curator`), at `timelock * 2` instead of `timelock` — "no privileged keeper, pay to propose publicly, longer delay" already exists in code.
- **The adapter's own recurring action** (this periodic one-coin profit deposit) is *not* covered by that module-registration timelock at all — registration only gates whether the module is allowed to call `mintModule`, not what it does afterward. The adapter needs its own internal pending-action mechanism for this specific action. It can reuse the same `PendingUint192`/`PendingLib` primitives (`stablecoin/libraries/PendingLib.sol` is generic, not stablecoin-specific), but the "7-day delay, then publicly executable" behavior for *this* action has to be built into the adapter contract itself.
- Amount-capped relative to **pool TVL**, not just DAO treasury size — a cap expressed as "% of treasury" can still be a large, shock-sized deposit relative to a given pool's actual depth. Take the smaller of a treasury-relative and a pool-relative cap.

**On "rainy day" framing:** holding the resulting LP position is not the same as holding a reserve. If GOV's price falls, unwinding that LP position pays back a rebalanced mix — more GOV, less stablecoin — the opposite of what a reserve intended for price defense needs (stablecoin already on hand, ready to deploy on the DAO's own timing). Treat profit allocation as two explicit buckets, not one:

```text
protocol profit
      │
      ├── deployed  → one-coin LP deposit (§3b) — earns fees, price-positive, illiquid
      └── reserved  → idle stablecoin, held un-deployed — genuine dry powder
```

## 4. veGOV lock structure

Resolves doc `03`'s open "decay curve shape" question: **discrete lock tiers — 2-year and 4-year** — rather than continuous linear decay (the veCRV-style option from doc `02` §4). Discrete tiers are simpler to reason about and audit; the tradeoff is coarser granularity (a lock is worth its tier's weight for its whole duration, no smooth decay curve to point at).

Either way, the underlying mechanism can't just be OZ's `ERC20Votes` inherited as-is: `ERC20Votes` checkpoints only update on transfer, but veGOV's voting power needs to change from **time passing alone**, with no transaction happening. veGOV needs its own accounting for that — either genuine on-the-fly decay math, or (closer to what Curve itself actually does — it rounds locks to week boundaries internally) an epoch/checkpoint-based approximation that reuses OZ's `Checkpoints`/`Votes` primitives, refreshed by a permissionless "poke" between lock actions. Either way it should still expose the standard `IVotes` interface (`getVotes`, `getPastVotes`, `getPastTotalSupply`, `delegates`, `delegate`) so Aragon plugins can consume it like any votes token.

veGOV should be non-transferable (soulbound to the locker). Delegation still works on top of the locked-weight accounting — a locker can delegate their veGOV's voting weight elsewhere while keeping the underlying GOV locked to themselves.

## 5. Governance plugin structure

Resolves doc `03`'s open question on `AragonVetoMultiSig`'s fate: **both existing plugins become veGOV-weighted**, not just one:

```text
today:                                    proposed:
AragonMultiSig          ──create/approve→  Coin voting majority
AragonDelayedAction     ──staged advance→  (same shape, veGOV-gated)
AragonVetoMultiSig      ──veto window───→  Coin veto minority / time-delayed action
AragonDao.execute()                        AragonDao.execute()  (unchanged)
```

- **Coin voting majority** — replaces `AragonMultiSig`. Ordinary proposal creation/approval, majority-based, sourcing weight from veGOV (matches the shape of Aragon's stock `TokenVoting` plugin, but reading from the custom veGOV weight source instead of a plain `ERC20Votes` balance, per doc `03` §4).
- **Coin veto minority / time-delayed action** — replaces `AragonVetoMultiSig` + `AragonDelayedAction`. A veGOV-gated minority-threshold veto window on delayed actions — the guardian-layer concept from doc `01` §7, now token-weighted instead of trusted-multisig-based.

Per doc `03` §4's key point, none of this touches the DAO core's identity or any `curator` pointer across any stablecoin/adapter — only which plugin holds `EXECUTE_PERMISSION_ID` changes.

## 6. Open questions this doc doesn't resolve

- Lock representation: non-transferable balance vs. veNFT (still open from doc `02`).
- Whether the minting adapter's dilution (§2, §3a/b) needs a **global cap across all future GOV-minting modules**, not just a per-module cap — raised as a forward-looking concern once incentive/emission modules (doc `02` §5) exist alongside this adapter, since several individually-reasonable per-module caps can still compound into an unreasonable aggregate issuance rate. Not reconciled with doc `02`'s emissions/reserve-routing questions yet.
- Whether one-coin deposit (§3b) or a straightforward mint-and-lock/burn buyback is the better instrument for the price-positive profit-routing case. Both were discussed; the one-coin deposit also earns ongoing trading fees but leaves the DAO carrying LP-position risk, while a buyback leaves the DAO holding GOV outright. Not decided.
- Per-protocol vs. shared DAO core scope (doc `03` §6) — still unresolved, orthogonal to this doc's content.
- Whether "coin veto minority" (§5) keeps a fixed minority threshold indefinitely or itself becomes a parameter the majority plugin can adjust — not discussed yet.
