# StableUnit (STBLU) — Synthetic Cross-FX Unit & Curve Triangle

> **Superseded**: direct pairing (`USDU-EURU`, `USDU-CHFU`, USDU as hub) was chosen instead
> of this triangle — see `docs/ideas-for-modules/StableFxCurvePools.md` for the rationale
> and the active game plan. Kept here for reference; the pool parameter experiments below
> still apply (they're topology-agnostic). `StableUnit.sol` and its interfaces have been
> removed from the repo (they're recoverable from git history if this ever gets revisited);
> the sandbox test now lives at `test/stablefx/TestFxCurvePool.ts`, repointed at real
> USDU/EURU instead of a freshly-deployed STBLU token.

## Goal

STBLU is a generic/synthetic stablecoin with no direct backing of its own. It exists purely to pair with the
three real, backed stablecoins (USDU, EURU, CHFU) in Curve crypto pools:

```
USDU-STBLU
EURU-STBLU
CHFU-STBLU
```

These three pools do two things at once:

-   **Price discovery** — since USDU/EURU/CHFU represent USD/EUR/CHF, the STBLU triangle implicitly prices
    EUR/USD and CHF/USD on-chain, without STBLU itself needing an external peg or oracle.
-   **Cross-FX trading** — anyone can swap USDU → STBLU → CHFU (etc.) to move exposure between currencies
    without a direct USDU-CHFU pool ever existing.

## Status

-   [x] `StableUnit.sol`, `IStableUnit.sol`, `IStableUnitMetadata.sol`, `IStableUnitModifier.sol` —
        `contracts/stableunit/`. Mirrors `Stablecoin`/`IStablecoin` (curator, guardian, timelock, modules,
        mint/burn) with **freeze/unfreeze entirely removed** — STBLU accounts can never be frozen. Reuses the
        shared `stablecoin/libraries/*` directly rather than duplicating them.
-   [x] `ITwocryptoFactory.sol`, `ITwocrypto.sol` — `contracts/curve/helpers/`. Interfaces for Curve's
        TwoCrypto-NG factory/pool, mirrored from the real Vyper source
        (github.com/curvefi/twocrypto-ng). Reusable by the Phase 2 top-up adapter, not just tests.
-   [x] `test/stableunit/TestStableUnitTwoCryptoPool.ts` — a mainnet-fork sandbox that deploys STBLU fresh
        and seeds real STBLU/USDU pools against the live TwoCrypto-NG factory
        (`0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f`, same address across mainnet/arbitrum/etc). Covers
        deployment/seeding sanity, imbalance from a one-directional sell, LP fee accrual (`virtual_price`
        growth) from round-trip trades, `price_oracle` drift under sustained one-directional flow, and a
        side-by-side slippage sweep across parameter presets. This is the pool-parameter tuning sandbox —
        see below.

## Design decisions (recap of discussion)

-   **Governance**: STBLU, USDU, EURU and CHFU all share the **same curator** — one governance action to
    register the adapter as a module everywhere it's needed, not four.
-   **Pool type**: Curve **crypto pool** (e.g. TwoCrypto-NG), not StableSwap-NG. USDU/EURU/CHFU don't share a
    fixed 1:1 rate, so a stableswap invariant (and the existing `CurveAdapterV1`'s "imbalance = raw token-count
    skew from par" logic) doesn't apply here.
-   **Bootstrapping / depth**: a curator-only adapter seeds each pool and tops up depth over time. Top-ups are
    **proportional** — computed from the pool's current `balances()` ratio, not a fixed rate — so they never
    move `price_scale` and need no oracle. STBLU is minted fresh (no backing promise); the paired
    USDU/EURU/CHFU must be **real** curator/treasury balance, not freshly minted, so we never inflate a backed
    token's supply without backing.
-   **Peg correction**: deliberately **no built mechanism**. `SwapBridgeMorphoV1.swapIn`/`swapOut` are already
    permissionless and symmetric (mint/redeem 1:1 minus fee against real collateral), so triangular mispricing
    self-corrects via ordinary arbitrage: whoever finds a currency "cheap" in STBLU terms mints it from its
    real backing and sells it into the pool, capturing the spread and growing real TVL exactly where organic
    demand pulled it. No oracle, no keeper, no new contract needed for this.
-   **Routing**: use **Curve's own router** for USDU→STBLU→CHFU-style multi-hop swaps. `SwapRouterV1` in this
    repo is unrelated (it routes `swapIn`/`swapOut` through `ISwapBridgeV1` modules, not between Curve pools),
    so there's no overlap and nothing to build here.
-   **Rejected approaches**:
    -   Chainlink-oracle-based deviation trigger for active peg defense — works, but adds an external trust
        dependency and sits in tension with "the pool is the price-finding mechanism"; kept as a possible
        fallback, not v1.
    -   Manual curator-only peg defense — fine for bootstrap depth, not a substitute for ongoing correction (too
        slow/centralized to rely on as the only mechanism).

## Pool parameter experiments

`test/stableunit/TestStableUnitTwoCryptoPool.ts` deploys real TwoCrypto-NG pools on a mainnet fork and runs
the same trade script against different `A`/`gamma`/fee presets so results are measured, not guessed. Three
presets tried so far (raw on-chain units — fees are 1e10-scaled, `gamma`/`fee_gamma`/`allowed_extra_profit`/
`adjustment_step` are 1e18-scaled fractions, `A` and `ma_exp_time` pass through as-is):

| Preset       | A          | gamma                   | mid_fee   | out_fee    | fee_gamma            | allowed_extra_profit | adjustment_step  | ma_exp_time |
| ------------ | ---------- | ------------------------ | --------- | ---------- | --------------------- | --------------------- | ----------------- | ----------- |
| `VOLATILE`   | 400,000    | 145,000,000,000,000      | 26,000,000 (0.26%) | 45,000,000 (0.45%) | 230,000,000,000,000  | 2,000,000,000,000     | 146,000,000,000,000 | 600s        |
| `FX` (v1 guess) | 4,000,000 | 10,000,000,000,000     | 4,000,000 (0.04%)  | 20,000,000 (0.20%) | 230,000,000,000,000  | 2,000,000,000,000     | 146,000,000,000,000 | 1,800s      |
| `LSD` (Curve's "Liquid Staking Derivatives" UI preset) | 40,000,000 | 2,000,000,000,000,000 | 3,000,000 (0.03%) | 45,000,000 (0.45%) | 300,000,000,000,000,000 | 10,000,000,000 | 5,500,000,000,000 | 600s |
| `LOW_VOL` (Curve's "Low Vol" UI preset) | 20,000,000 | 1,000,000,000,000,000 | 5,000,000 (0.05%) | 45,000,000 (0.45%) | 5,000,000,000,000,000 | 10,000,000,000 | 5,500,000,000,000 | 600s |

Slippage measured via `get_dy` at increasing trade size relative to a 20,000/20,000 seeded pool:

| % of pool | VOLATILE | FX (v1 guess) | LSD    | LOW_VOL |
| --------- | -------- | -------------- | ------ | ------- |
| 1%        | 43 bps   | 34 bps          | 3 bps  | 5 bps   |
| 2%        | 97 bps   | 131 bps         | 3 bps  | 8 bps   |
| 5%        | 368 bps  | 429 bps         | 4 bps  | 24 bps  |
| 10%       | 823 bps  | 877 bps         | 21 bps | 122 bps |
| 25%       | 1952 bps | 1984 bps        | 550 bps| 1109 bps|

Two findings worth keeping:

-   **The v1 "FX" guess was wrong.** The intuition "tighter `A` + smaller `gamma` ⇒ always less slippage"
    only held at 1% of pool depth. At every larger size it was *worse* than the generic volatile-pair
    default — `gamma` sets the width of the low-slippage zone around `price_scale`, and this preset's `A`
    wasn't pushed up enough to compensate for how far it had narrowed that zone.
-   **The LSD preset (chosen for its "soft-pegged to its underlying asset" description) wins decisively at
    every size tested** — 3-4 bps up to 5% of pool depth, still only 21 bps at 10%. Makes sense: LSD pairs
    (e.g. stETH/ETH) share the same "low relative volatility, not truly pegged" shape as an FX pair, so the
    much higher `A` (100x the volatile default) transfers well. One caveat: an LSD's soft peg is backed by a
    *structural* bound (ETH is always eventually redeemable from staking), which caps how far it can drift.
    STBLU has no equivalent — nothing redeems STBLU 1:1 for anything. The peg here is softer, held up only
    by the AMM-plus-swap-bridge arbitrage loop described above, not by a redemption contract. The parameter
    *shape* transfers; the safety margin it implies does not.

-   **`LOW_VOL` looks similar to `LSD` on paper (also very high `A`, small `gamma`) but loses meaningfully at
    every size** — 122 bps vs 21 bps at 10%, 1109 bps vs 550 bps at 25%. The gap traces to `fee_gamma`:
    `LOW_VOL`'s is 0.005, 60x smaller than `LSD`'s 0.3, so its fee ramps from `mid_fee` toward `out_fee` much
    sooner as a trade imbalances the pool — `LOW_VOL` also halves `A` and `gamma` relative to `LSD`, giving
    it less price-impact headroom on top of the worse fee ramp. Two presets that look superficially close in
    a UI can differ a lot in practice — worth actually running each one rather than eyeballing the numbers.

### Fee rate vs. arbitrage dead-zone — the "lower bps" metric above is incomplete

All the "slippage bps" numbers above bundle two mechanistically different things: curve-shape price impact
(`A`/`gamma` — a flatter curve absorbs size better and costs LPs nothing, closer to a free lunch) and the
explicit fee rate (`mid_fee`/`out_fee` — a real skim). Only the fee rate is a genuine tradeoff: raising it
gives the LP position (the future top-up adapter) more revenue per trade, but it also raises the bar for the
arbitrage-driven peg correction the whole design leans on (see Design decisions above) — if the fee eats the
whole mispricing spread, no one bothers correcting it, and small deviations just sit there. So "lower bps
wins" was right for comparing curve shapes, wrong to extend to fee-rate comparisons without separating them.

Isolated the fee rate specifically: `LSD`'s curve shape (`A`/`gamma`) held fixed, only `mid_fee`/`out_fee`
varied, measured a 1%-of-pool trade one-way (LP revenue proxy) and round-trip (arbitrageur cost proxy):

| Preset       | mid_fee / out_fee | LP revenue (bps, one leg) | Round-trip cost (bps, single pool) |
| ------------ | ------------------ | -------------------------- | ------------------------------------ |
| `LSD_LOW_FEE`  | 0.01% / 0.10%     | 1 bps                      | 2 bps                                |
| `LSD` (current) | 0.03% / 0.45%   | 3 bps                      | 6 bps                                |
| `LSD_HIGH_FEE` | 0.10% / 0.80%     | 10 bps                     | 20 bps                               |

**Correction, verified directly rather than assumed:** the round-trip number above is *not* a lower bound
that needs doubling for a real two-pool triangular arb — it already **is** the right estimate. A round trip
on one pool (out, then back) is two one-way legs, same shape as one leg on pool A plus one leg on pool B.
Measured both directly (two independent pool instances, one leg through each, vs. the same trade as a
same-pool round trip) and they came out identical:

| Preset         | Real two-pool cost | Single-pool round-trip |
| -------------- | ------------------- | ------------------------ |
| `LSD_LOW_FEE`  | 2 bps                | 2 bps                    |
| `LSD` (current)| 6 bps                | 6 bps                    |
| `LSD_HIGH_FEE` | 20 bps               | 20 bps                   |

So `LSD`'s current fees imply roughly a **6 bps floor** before a real cross-pool arb clears the Curve-fee
cost alone — not 12 bps as first assumed here. Still not the whole dead-zone: gas and the swap-bridge's own
`swapInFeePPM`/`swapOutFeePPM` stack on top of this. Scales roughly linearly with the fee rate either way,
so it's still a real dial — picking it remains a genuine judgment call between LP revenue and how tightly
the peg gets held, not something to default to "lowest possible."

Current leaning: start from the `LSD` preset as the working default for all three STBLU pools — it remains
the best of the four tried so far by a clear margin — and keep using this sandbox to try further presets
before anything real gets deployed.

## Open questions / risks

-   What exactly should back "curator's assets" for top-ups — treasury balance directly, or routed through
    accrued `ModuleRevenueV1` revenue? - LP tokens held.
-   Cold-start dead zone: while pools are shallow, STBLU's implied price can be noisy since arbitrage volume
    (and therefore correction) is a function of pool depth.
-   Cross-pool triangulation (checking the three pools' implied cross-rates against each other) is a stronger,
    fully oracle-free peg-defense signal than anything oracle-based — deferred until all three pools have real
    depth, since it needs the triangle to already be meaningful.
-   Confirm swap-bridge fee parameters (`swapInFeePPM`/`swapOutFeePPM`) don't create asymmetric friction that
    would bias arbitrage to only work in one direction. Also add them to the total dead-zone estimate
    (see Fee rate vs. arbitrage dead-zone above — currently ~6 bps from Curve fees alone at `LSD`'s current
    settings) — that's not the full cost an arbitrageur has to clear, gas and these swap-bridge fees stack
    on top of it.
-   How `price_scale` gets initialized at pool creation for the EURU/CHFU pools (needs a real FX rate input
    at deploy time — one-time, not an ongoing oracle dependency). Note `Twocrypto.vy`: "All prices in the AMM
    are with respect to the first token in the pool" — confirm `initial_price` direction against whichever
    coin ends up at index 0 before deploying those two.
-   `A`/`gamma`/fee parameters still need real calibration (CurveSim / Curve's own FXSwap-simulation
    approach), not just comparison between a handful of presets — the sandbox test narrows the search, it
    doesn't finish it.

## Game plan

### Phase 1 — Core token (done)

-   [x] `StableUnit.sol` contract
-   [x] `IStableUnit` / `IStableUnitMetadata` / `IStableUnitModifier` interfaces

### Phase 2 — Curator top-up / bootstrap adapter

-   [ ] Design `StableUnitCurveAdapterV1` (curator-only entrypoint), one instance per pool
    -   [ ] Proportional top-up logic: read `pool.balances()`, match ratio, no price assumptions
    -   [ ] Mint STBLU via `mintModule` (adapter needs `module` role on STBLU only)
    -   [ ] Pull real USDU/EURU/CHFU from curator via `transferFrom` (no minting on that leg)
    -   [ ] `add_liquidity`, hold LP tokens in the adapter (protocol-owned liquidity)
    -   [ ] Initial seed path: set the pool's `price_scale` from a real FX rate at deploy time
-   [ ] Decide LP token handling: permanently locked protocol-owned liquidity, or ever removable/rebalanced // its always module owned asset, because eventually it needs to pay back its created debt.

### Phase 3 — Pool deployment

-   [x] Choose Curve pool factory/version — TwoCrypto-NG, factory `0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f`
        (same address across mainnet/arbitrum/etc; confirm it's live on whichever chain is actually targeted)
-   [ ] Finish calibrating `A`/`gamma`/fees per pool (see Pool parameter experiments above — `LSD` preset is
        the current working default, not yet final)
-   [ ] Deploy USDU-STBLU pool, seed via adapter
-   [ ] Deploy EURU-STBLU pool, seed with correct EUR/USD `price_scale`
-   [ ] Deploy CHFU-STBLU pool, seed with correct CHF/USD `price_scale`
-   [ ] Register each adapter as a module on STBLU (curator, timelocked, same flow as existing modules)

### Phase 4 — Governance wiring

-   [ ] Confirm/enforce a single shared curator across STBLU, USDU, EURU, CHFU
-   [ ] Module registration + timelock flow for each top-up adapter

### Phase 5 — Deployer / scripts

-   [ ] `StableUnitDeployer.sol` bundling STBLU + its three adapters (mirrors `ChfuDeployer`/`EuruDeployer`)
-   [ ] Deployment + initial seeding scripts

### Phase 6 — Testing

-   [x] Pool-parameter tuning sandbox — `test/stableunit/TestStableUnitTwoCryptoPool.ts` (see Pool parameter
        experiments above); keep using it as more presets get tried
-   [ ] Unit tests for `StableUnit` (mirror `test/stablecoin/TestStablecoin.ts`, drop all freeze/unfreeze cases)
-   [ ] Unit tests for the top-up adapter (proportional math, module gating, LP custody)
-   [ ] Fork tests simulating the triangular-arbitrage flow (`swapIn`/`swapOut` + Curve swaps) to validate
        that mispricing actually self-corrects in practice, not just in theory

### Phase 7 — Deferred / nice-to-haves

-   [ ] Cross-pool triangulation as a secondary, fully oracle-free peg-defense signal (post-launch, once all
        three pools have real depth)
-   [ ] Optional atomic arbitrage helper (only if separate-transaction execution proves to be meaningful
        friction for arbitrageurs in practice — not needed for v1 since Curve's router already handles routing)

## Explicitly out of scope for v1

-   Any oracle-based automatic peg correction
-   Any freeze/unfreeze capability on STBLU
-   A custom multi-hop swap router (Curve's own router covers this)
