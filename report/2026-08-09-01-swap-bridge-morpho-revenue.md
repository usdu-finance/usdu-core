# Security Audit — ModuleRevenueV1 / SwapBridgeMorpho / IModuleRevenue

**Date:** 2026-08-09
**Scope:**
- `contracts/module/ModuleRevenueV1.sol`
- `contracts/swap/SwapBridgeMorpho.sol`
- `contracts/module/IModuleRevenue.sol`

**Commit:** 6928438 (original audit) — re-verified against current branch tip (post `fe6da31`)

---

## Update — 2026-08-09 (v2, supersedes the earlier update note)

Since the original audit, both files were renamed (`SwapBridgeMorpho.sol` → `contracts/swap/SwapBridgeMorphoV1.sol`, `IModuleRevenue.sol` → `contracts/module/IModuleRevenueV1.sol`); findings below still refer to the original paths/line numbers as they stood at commit 6928438. The architecture changed substantially after the first update to this report (which described a now-superseded `repay()`/`redeem()`-based mitigation for H-01 — those functions have since been removed entirely in favor of the design described below).

- **H-02 is RESOLVED.** `ModuleRevenueV1` now inherits OpenZeppelin's `ReentrancyGuard`; `swapIn`, `swapInTo`, `swapOut`, `swapOutTo`, `reconcile()`, and `reconcile(bool)` are all `nonReentrant` and share the same guard by inheritance, so reentering any one of them while another is mid-execution reverts — closing the exploit path this finding described.
- **H-01 is now fully RESOLVED**, not just mitigated — though the precise mechanism shifted again after this update was first written, so re-stating it precisely: `_swapOut`'s fee itself is no longer minted at all, it's taken directly out of the withdrawn `coin` (two `vault.withdraw` calls: one to the swapper, one to the curator for the fee). Separately, `_swapOut` also opportunistically reconciles accrued surplus via the shared `_reconcile` (currently requesting the mint path) — so `swapOut`/`swapOutTo` *can* still call `mintModule` when the module is valid, but never *depend* on it succeeding: `_reconcile` checks `stable.checkValidModule(address(this))` and silently downgrades to redeeming the surplus as coin instead of minting whenever the module is no longer valid, rather than reverting. Net effect is the same guarantee as originally stated (`swapOut` never reverts due to `validModule`), just achieved by a graceful fallback rather than by literally never touching `mintModule`. Verified directly: a `post-expiry wind-down` test suite deploys a module, lets it expire, and confirms `swapIn` still correctly reverts while `swapOut` still succeeds; a further `post-expiry swapOut with accrued surplus` suite confirms the auto-fallback specifically triggers through `swapOut`'s own reconcile call (not just the standalone `reconcile()`). The earlier `repay()`/`redeem()` curator-unwind functions this update previously described are no longer needed for this and have been removed. A separate curator-gated `reconcile(bool allowMinting)` overload allows explicitly forcing either path regardless of validity, and — unlike the permissionless `reconcile()` — isn't throttled by `stable.timelock()`, since that guard exists to stop spam from arbitrary callers, which doesn't apply to the curator's own deliberate action.
- **`_reconcile`'s mint path is now also uncapped** (via the plain `_mint`, not `_mintWithCap`): it only ever mints against a deficit that's already fully backed by real `totalAssets()`, so it can't create unbacked stablecoin regardless of `mintCap` — and leaving it capped would reintroduce a variant of the same "stuck reconciliation" risk this report's Notes previously flagged. `mintCap` now exclusively bounds `swapIn`'s principal-backed issuance. See **[L-02]** below for the resulting documentation-drift finding this introduces.
- **L-01 is unchanged** — not addressed.
- **The "Silent revenue plateau at mintCap" Notes item is obsolete** — reconciliation is no longer capped at all, so there's no plateau to detect.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High     | 2 | resolved |
| Medium   | 0 | — |
| Low      | 2 | 1 open (L-01), 1 fixed (L-02) |
| Info     | 0 | — |

---

## Findings

### [H-01] swapOut becomes permanently unusable once the module expires, defeating wind-down — RESOLVED
**Location:** `contracts/swap/SwapBridgeMorpho.sol:117-130` (`_swapOut`), `contracts/module/ModuleRevenueV1.sol:38-44` (`_mint`)

**Description:**
`_swapOut` unconditionally mints the swap-out fee to the curator via `_mint(stable.curator(), fee)`, which calls `stable.mintModule(...)`. `Stablecoin.mintModule` is gated by the `validModule` modifier (`contracts/stablecoin/Stablecoin.sol:174`), which reverts once `modules[address(this)] <= block.timestamp` — i.e. once this module's `expiredAt` has passed.

That means the *entire* `swapOut`/`swapOutTo` call reverts after expiry, even though burning the caller's stablecoin (`stable.burnModule`, gated only by `onlyModule`, not `validModule`) and withdrawing from the vault don't themselves require minting rights. The only reason the redemption path fails is the incidental fee-mint step.

This directly conflicts with the module-expiry design documented in `docs/deprecated-modules/Deprecated Modules.md`, which explicitly relies on modules staying redeemable after expiry ("redeem/reconcile this position down before or as part of expiry"). Every module in this system is designed to expire eventually (`README.md`: "No permanent modules"), so this isn't a rare edge case — it will be hit by every deployment of this contract that accrues any outstanding `totalMinted`.

**Impact:** Once a `SwapBridgeMorpho` instance expires, any holder of the stablecoin it minted loses the ability to redeem it via `swapOut`/`swapOutTo`. Funds aren't stolen, but become inaccessible through the intended path — recovery would require curator/governance intervention (e.g. re-registering the module, which contradicts the intent of letting it expire) rather than a user-triggered exit.

**Recommendation:** Decouple the redemption path from minting rights. Options:
- Check `stable.checkValidModule(address(this))` before attempting the fee mint; if invalid, skip minting the fee (waive it) and proceed with burn + withdrawal so the core exit path always stays available.
- Or wrap the fee-mint in a way that degrades gracefully (e.g. the same "burn what you can, skip the rest" fallback pattern already used in `MorphoAdapterV1_2.redeem()`/`VaultAdapterV1.redeem()`), rather than letting an unrelated privilege check block the user's own withdrawal.

---

### [H-02] No reentrancy guard; deposit-before-mint ordering in swapIn can be exploited by a reentrant reconcile() — RESOLVED
**Location:** `contracts/swap/SwapBridgeMorpho.sol:86-102` (`_swapIn`), `contracts/module/ModuleRevenueV1.sol:76-88` (`_reconcile`), `contracts/module/ModuleRevenueV1.sol:51-53` (`reconcile`, fully permissionless)

**Description:**
`_swapIn` deposits the user's coin into the vault *before* minting the corresponding stablecoin:

```solidity
function _swapIn(address target, uint256 amount) internal returns (uint256) {
    coin.safeTransferFrom(_msgSender(), address(this), amount);
    coin.forceApprove(address(vault), amount);
    vault.deposit(amount, address(this));       // <- totalAssets() now includes this swap's principal

    uint256 amountStable = (amount * 1 ether) / 10 ** coin.decimals();
    uint256 fee = amountStable.mulDiv(swapInFeePPM, 1_000_000);

    _mint(target, amountStable - fee);           // <- totalMinted only updated here
    _mint(stable.curator(), fee);
    ...
}
```

Between `vault.deposit(...)` and the first `_mint(...)`, `totalAssets()` already reflects the newly deposited principal, but `totalMinted` has not yet been incremented for it. If execution can re-enter the contract during `vault.deposit(...)` — e.g. because the curator-supplied `coin` or `vault` (both arbitrary, constructor-supplied addresses; see `constructor` at `contracts/swap/SwapBridgeMorpho.sol:48-64`) has any transfer hook or callback — a reentrant call to the fully permissionless `reconcile()` would compute:

```
deficit = totalAssets() - totalMinted   // inflated by the in-flight swap's own principal
```

and mint that "deficit" straight to the curator as if it were accrued yield. When the original `_swapIn` call resumes, it *also* mints `amountStable` to `target`/curator for the same underlying principal — resulting in stablecoin minted twice against one deposit, breaking the 1:1 backing invariant the whole module is built on.

Neither `ModuleRevenueV1` nor `SwapBridgeMorpho` has any `nonReentrant` guard, unlike `contracts/merkl/MerklRewardsV1.sol` in this same codebase, which explicitly added one for the analogous risk of interacting with untrusted external contracts.

**Impact:** Depends entirely on the reentrancy-safety of whichever `coin`/`vault` pair a given deployment is wired to. Not exploitable against a plain USDC + standard, non-hooked ERC4626 vault today, but the contract's own docstring and this session's design intent ("we will reuse the same contract for different currencies") mean future deployments against a different coin (e.g. anything with transfer hooks) or a less conventional ERC4626 vault would be directly exposed. Given the permissionless nature of `reconcile()`, exploitation requires no special privilege beyond triggering the reentrant call.

**Recommendation:** Add OpenZeppelin's `ReentrancyGuard` (already used in `MerklRewardsV1`) and mark `swapIn`, `swapInTo`, `swapOut`, `swapOutTo`, and `reconcile` as `nonReentrant`. This is cheap, and removes the dependency on every future `coin`/`vault` pairing being individually verified as reentrancy-safe.

---

### [L-01] No handling for fee-on-transfer or rebasing `coin`
**Location:** `contracts/swap/SwapBridgeMorpho.sol:87-90`

**Description:** `_swapIn` transfers `amount` of `coin` via `safeTransferFrom`, then immediately deposits that same nominal `amount` into the vault, rather than measuring the balance actually received. For a fee-on-transfer or rebasing token, actual received balance would be less than `amount`, and `vault.deposit(amount, ...)` would then attempt to pull more than this contract actually holds.

**Impact:** With a standard token like USDC (the evident intended `coin`), this is a non-issue. It fails safe today — the deposit call would simply revert rather than silently lose funds. Flagged because the module is explicitly designed to be redeployed for different coins in the future, and a fee-on-transfer coin would make every `swapIn` revert (a liveness issue, not fund loss).

**Recommendation:** If this contract is ever intended to support such tokens, measure the actual balance delta before depositing. Otherwise, document the "no fee-on-transfer / no rebasing coin" assumption explicitly (e.g. in the `coin` NatSpec) so it's an intentional, known constraint on future deployments rather than an implicit one.

---

### [L-02] `mintCap`'s docstring no longer describes actual behavior — FIXED
**Location:** `contracts/module/IModuleRevenueV1.sol` (`mintCap()`), `contracts/module/ModuleRevenueV1.sol` (`_reconcile`)

**Description:** `IModuleRevenueV1.mintCap()` is documented as "The maximum amount this module may mint" — but as of the reconcile redesign, that's only true for principal-backed issuance through `_mintWithCap` (used by `swapIn`). `_reconcile`'s revenue mint uses the uncapped `_mint`, deliberately, since it only ever mints against a deficit already fully backed by `totalAssets()` — so `totalMinted` can now legitimately exceed `mintCap` once enough interest/revenue has been reconciled over time.

**Impact:** Purely a documentation/interface-clarity issue, not a fund-safety one — the module stays fully backed regardless. But an integrator or risk dashboard reading `mintCap()` at face value (e.g. computing "headroom" as `mintCap - totalMinted`) would get a nonsensical or negative result once this happens, without any indication that's expected.

**Recommendation:** Update `mintCap()`'s NatSpec (in `IModuleRevenueV1`) to clarify it bounds new principal-backed issuance specifically, not `totalMinted` as a whole — e.g. "The maximum amount this module may mint against new deposits; totalMinted can exceed this once revenue reconciliation mints against already-backed surplus."

---

## Notes

- **Vault illiquidity can revert `swapOut`.** Morpho Vault V2's documented "in-kind redemption" mechanics and non-conventional `maxWithdraw() == 0` behavior mean `vault.withdraw(...)` in `_swapOut` isn't guaranteed to be instantly liquid. Not a security defect (a revert here is atomic and leaves no inconsistent state), but worth surfacing to integrators/frontends as an expected failure mode distinct from a "bad input" revert.
- **Residual ERC20 allowance to the vault.** `coin.forceApprove(address(vault), amount)` in `_swapIn` sets (not increments) the allowance each call, so there's no unbounded-approval growth, but if a given `vault.deposit` call doesn't consume the full approved amount, the leftover allowance persists until the next `swapIn` overwrites it. Low risk since `vault` is an immutable, curator-chosen address, not attacker-controlled — noted for completeness rather than as a finding.
- **Rounding direction is consistently safe.** Both `totalAssets()` and the swap-out coin conversion floor their division results, which is the conservative direction (never over-reports assets, never overpays a redeemer). No change needed.
- **Post-expiry asymmetry is otherwise correct.** `swapIn`'s block on an expired module (via `validModule` on `mintModule`) is the *intended* behavior — no new deposits after expiry, consistent with the rest of the module system. H-01 is specifically about `swapOut` incorrectly sharing that same block.
