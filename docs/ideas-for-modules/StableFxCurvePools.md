# Direct FX Curve Pools (USDU as hub) — supersedes STBLU

## Goal

Give USDU, EURU and CHFU on-chain price discovery and cross-FX trading against each other,
using **USDU as the routing hub**, with no extra synthetic token:

```
USDU-EURU
USDU-CHFU
```

EURU ↔ CHFU trades route through USDU (`EURU → USDU → CHFU`), same hop-count as the
[[StableUnit]] triangle design would have given via STBLU, but with two pools instead of
three and no fourth token to design, audit, or govern.

## Status

This design replaces the STBLU triangle proposed in
`docs/ideas-for-modules/StableUnit.md`. That doc is kept for historical reference (its pool
parameter experiments still apply here — see below) but its game plan is no longer being
pursued. `StableUnit.sol` itself stays in the repo unused for now; nothing here depends on
it.

## Why direct pairing over STBLU

Both designs give the same triangulation (2 hops max to convert between any two of the
three currencies) and the same hop-count for EURU↔CHFU. The STBLU triangle's real
advantage was capital efficiency: STBLU is free to mint (no backing promise), so pool depth
on that leg isn't capped by real treasury/collateral. Direct pairing gives that up — but
in exchange removes an entire token, its adapter class, and its slot in the shared-curator
module wiring. Given USDU/EURU/CHFU mints are collateralized debt anyway (see below), not
raw treasury draws, the capital-efficiency gap is smaller than it first looks, and the
"one fewer token to reason about" trade was judged worth it.

Accepted cost of dropping STBLU: **USDU carries debt exposure in both pools** instead of
appearing in exactly one pool the way each currency would have under the STBLU triangle.
See Open questions.

## Design decisions

-   **Governance**: USDU, EURU and CHFU already share the same curator — no new token
    means no new entry needed in that shared-curator wiring.
-   **Pool type**: Curve **crypto pool** (TwoCrypto-NG), not StableSwap-NG — same reasoning
    as the STBLU doc: USDU/EURU/CHFU don't share a fixed 1:1 rate, so a stableswap invariant
    doesn't apply.
-   **Seeding is a collateralized mint, not a treasury draw**: the curator-only seed
    adapter mints USDU/EURU/CHFU as **debt** (tracked the same way `CurveAdapterV1_2`
    tracks `totalMinted`, contracts/curve/CurveAdapterV1_2.sol:46) and holds the resulting
    LP tokens as the collateral backing that debt (`totalAssets()` valuing LP via
    `pool.get_virtual_price()`, mirroring CurveAdapterV1_2.sol:162). This is **not**
    uncollateralized inflation — the debt is explicit, marked-to-market against the LP
    position, and can be unwound (`removeLiquidity` → burn/repay), same pattern as the
    existing Curve/Morpho adapters.
    -   Both legs of each pool (e.g. USDU and EURU) get minted this way — unlike the STBLU
        design, there's no free-mint leg here, since neither USDU nor EURU/CHFU is allowed
        to be minted without backing.
-   **Fee revenue reconciliation**: adapter should follow the `ModuleRevenueV1`
    (contracts/module/ModuleRevenueV1.sol) reconcile pattern — permissionless
    `reconcile()` throttled to once per `stable.timelock()`, comparing `totalAssets()`
    (LP value) against `totalMinted` (debt); surplus from trading fees mints to
    `stable.curator()` as realized revenue, deficit triggers `_redeemAssets`. This makes
    the earlier "STBLU breathes and consumes fees" idea unnecessary — direct pairing gets
    the same self-funding effect, and unlike an STBLU-denominated fee leg, **100% of the
    accrued revenue here is a real, extractable stablecoin**, not a synthetic asset with no
    use outside the pool.
-   **Peg correction**: same as STBLU doc — deliberately no built mechanism.
    `SwapBridgeMorphoV1.swapIn`/`swapOut` are already permissionless and symmetric, so
    triangular mispricing self-corrects via ordinary arbitrage. See "Worked arbitrage
    example" below for a concrete walk-through of this loop.
-   **Routing**: Curve's own router handles USDU→EURU, USDU→CHFU, and the two-hop
    EURU→USDU→CHFU case. Nothing new to build here.
-   **Rejected approach**: STBLU triangle (`docs/ideas-for-modules/StableUnit.md`) — works,
    and is more capital-efficient on pool depth, but adds a fourth token, a bespoke
    top-up-adapter class, and a fourth slot in curator/module governance for a benefit that
    matters less once seeding is a collateralized mint rather than a free one.

## Worked arbitrage example

Concrete walk-through of the "ordinary arbitrage self-corrects triangular mispricing"
mechanism above, since it's easy to describe abstractly but the actual loop is worth
spelling out once:

1. A user deposits CHFU as collateral and borrows EURU, then dumps that EURU — e.g. routing
   it `EURU → USDU → CHFU` through the two Curve pools to close out a leveraged position.
   This sell pressure pushes EURU's price down and CHFU's price up inside the two pools
   (excess EURU supply in the USDU-EURU pool; excess CHFU demand in the USDU-CHFU pool).
2. That mispricing is the arbitrage opportunity: CHFU is now priced rich in-pool relative to
   its real backing, EURU cheap. An arbitrageur:
    - Sells real CHFU into the USDU-CHFU pool for USDU (pulls CHFU's in-pool price back
      toward par).
    - Sells that USDU into the USDU-EURU pool for EURU (pulls EURU's in-pool price back
      toward par).
    - Leaves the protocol entirely: redeems EURU → EURC via
      `SwapBridgeMorphoV1 - steakEURC` (`contracts/deploy/EuruDeployer.sol:41`).
    - Swaps EURC → ZCHF on an external venue (not part of this protocol).
    - Mints CHFU from ZCHF via `SwapBridgeMorphoV1 - svZCHF`
      (`contracts/deploy/ChfuDeployer.sol:41`).
    - Repeats until the spread no longer covers the round-trip cost.
3. **The fee stack this arbitrageur actually pays** is bigger than "the two Curve pool
   fees" — it's Curve `mid_fee`/`out_fee` on both legs, `swapOutFeePPM` to redeem
   EURU→EURC, whatever fee/slippage exists on the external EURC↔ZCHF leg (outside this
   protocol's control), and `swapInFeePPM` to mint ZCHF→CHFU, plus gas. Tuning Curve's own
   fees down (see Pool parameter experiments below) only helps the correction loop if it's
   not already dominated by these other costs — worth pricing out the swap-bridge fees and
   the external EURC/ZCHF leg before concluding Curve fees are the lever that matters most
   for how tightly the peg holds.
4. This loop also isn't atomic — the EURC↔ZCHF leg happens off-protocol, likely on a
   different venue — so the arbitrageur carries execution-time price risk, a real-world
   delay on how fast correction actually happens that a pure fee-rate analysis misses.

## Pool parameter experiments

The parameter sweep in `docs/ideas-for-modules/StableUnit.md` (`Pool parameter
experiments` section) is topology-agnostic — it measured curve-shape (`A`/`gamma`) and fee
(`mid_fee`/`out_fee`/`fee_gamma`) behavior on a generic TwoCrypto-NG pool, not anything
specific to STBLU. The conclusions carry over unchanged:

-   Working default: the **`LSD`** preset (`A=40,000,000`, `gamma=2,000,000,000,000,000`,
    `mid_fee=3,000,000` (0.03%), `out_fee=45,000,000` (0.45%),
    `fee_gamma=300,000,000,000,000,000`, `allowed_extra_profit=10,000,000,000`,
    `adjustment_step=5,500,000,000,000`, `ma_exp_time=600`) — wins decisively at every
    trade size tested (3-4 bps up to 5% of pool depth).
-   `test/stablefx/TestFxCurvePool.ts` now runs this exact sandbox against the real,
    deployed USDU/EURU pair (forked at a later block than the repo's default, since EURU
    postdates `hardhat.config.ts`'s pinned fork block — see `resetFork` usage in that file).
    All bps numbers above are unchanged from the original STBLU/USDU version, confirming the
    comparisons are scale-invariant w.r.t. which real pair is used. Extending it to
    USDU/CHFU is a straightforward addition once CHFU calibration is needed.

## Open questions / risks

-   **USDU debt concentration**: with USDU in both pools, its outstanding minted debt
    across this module class is roughly double what EURU or CHFU carries. Confirm whatever
    per-module or per-currency debt ceiling exists (`mintCap` in `ModuleRevenueV1`) is sized
    with this in mind, and that USDU's collateral (its LP positions in *both* pools) is
    tracked/monitored as one combined exposure, not two independent ones that happen to
    share a currency.
-   How `price_scale` gets initialized at pool creation for USDU-EURU and USDU-CHFU (needs
    a real EUR/USD, CHF/USD rate input at deploy time — one-time, not an ongoing oracle
    dependency). Confirm `initial_price` direction against whichever coin ends up at index 0
    (Twocrypto prices are "with respect to the first token in the pool").
-   Confirm swap-bridge fee parameters (`swapInFeePPM`/`swapOutFeePPM`) don't create
    asymmetric friction biasing arbitrage to work in only one direction, and add them to the
    total dead-zone estimate (currently ~6 bps from Curve fees alone at the `LSD` preset,
    per the StableUnit doc's fee-rate analysis).
-   `A`/`gamma`/fee parameters still need real calibration (CurveSim / Curve's own
    FXSwap-simulation approach) — the sandbox narrows the search, it doesn't finish it.
-   If capital efficiency on pool depth becomes a real bottleneck later (i.e. USDU/EURU/CHFU
    debt ceilings can't support deep enough pools), STBLU remains available as a fallback —
    nothing here forecloses revisiting `docs/ideas-for-modules/StableUnit.md`.

## Game plan

### Phase 1 — Tokens (done)

-   [x] USDU, EURU, CHFU already deployed with a shared curator — no new token needed.

### Phase 2 — Seed adapter

-   [ ] Design a curator-only seed adapter per pool, following the `CurveAdapterV1_2` /
        `ModuleRevenueV1` pattern rather than a bespoke mechanism:
    -   [ ] Mint both legs as debt (`totalMinted`) via `mintModule`, not a treasury draw
    -   [ ] `add_liquidity`, hold LP tokens as collateral (`totalAssets()` via
            `get_virtual_price()`)
    -   [ ] `reconcile()` following `ModuleRevenueV1`: surplus (fees) mints to curator as
            revenue, deficit redeems LP down
    -   [ ] Imbalance guard before/after ops, mirroring `checkImbalance`/`verifyImbalance`
    -   [ ] Initial seed path: set the pool's `price_scale` from a real FX rate at deploy
            time

### Phase 3 — Pool deployment

-   [x] Choose Curve pool factory/version — TwoCrypto-NG, factory
        `0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f`
-   [ ] Finish calibrating `A`/`gamma`/fees per pool — `LSD` preset is the current working
        default, not yet final
-   [ ] Deploy USDU-EURU pool, seed via adapter
-   [ ] Deploy USDU-CHFU pool, seed with correct CHF/USD `price_scale`
-   [ ] Register each adapter as a module (curator, timelocked, same flow as existing
        modules — `setModule`, `Stablecoin.sol`)

### Phase 4 — Governance wiring

-   [ ] Confirm the debt-ceiling (`mintCap`) sizing accounts for USDU's doubled exposure
        across both pools
-   [ ] Module registration + timelock flow for each seed adapter

### Phase 5 — Deployer / scripts

-   [ ] Deployer bundling both seed adapters (mirrors `ChfuDeployer`/`EuruDeployer`'s
        deploy → `setModule` → hand off curator/timelock pattern)
-   [ ] Deployment + initial seeding scripts

### Phase 6 — Testing

-   [x] Repoint the pool-parameter sandbox at real tokens instead of STBLU/USDU —
        `test/stablefx/TestFxCurvePool.ts`, now running against real, deployed USDU/EURU.
        `StableUnit.sol` and its interfaces were removed from the repo as part of this
        (recoverable from git history). USDU/CHFU coverage still outstanding — same sandbox,
        just needs a CHFU-paired pool added.
-   [ ] Unit tests for the seed adapter (debt tracking, imbalance gating, reconcile/revenue
        math, LP custody)
-   [ ] Fork tests simulating triangular arbitrage (`swapIn`/`swapOut` + two-hop Curve
        swaps) to validate mispricing self-corrects in practice

### Phase 7 — Deferred / nice-to-haves

-   [ ] Cross-pool triangulation as a secondary, oracle-free peg-defense signal (post-launch,
        once both pools have real depth)
-   [ ] Revisit STBLU if USDU's debt ceiling becomes a binding constraint on pool depth

## Explicitly out of scope for v1

-   STBLU / any synthetic pivot token (see "Why direct pairing over STBLU" above)
-   Any oracle-based automatic peg correction
-   A custom multi-hop swap router (Curve's own router covers this)
