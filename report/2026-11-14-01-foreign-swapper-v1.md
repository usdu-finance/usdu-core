# Security Audit — ForeignSwapperV1

**Date:** 2026-11-14  
**Scope:** `contracts/swapper/ForeignSwapperV1.sol`, `contracts/swapper/IForeignSwapperV1.sol` (read in full), plus `IStablecoinModifier.sol` for the access modifiers  
**Commit:** a97caf0 + uncommitted change (ERC-4626 unwrap receiver/owner hardcoded to `address(this)`)  
**Tests:** `test/swapper/TestForeignSwapperV1.ts` (8 passing), `TestForeignSwapperV1.Live.ts` (mainnet fork, svDEURO -> dEURO -> EURC -> EURU, passing)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 0 |
| Low      | 3 |
| Info     | 6 |

---

## Findings

### [L-01] Routes survive a curator change  *(Low, accepted)*
**Location:** `ForeignSwapperV1.sol:59, 114` (`stable.curator()` resolved at call time), `_routes` storage  
**Description:** The sweep destination follows the current curator, but routes configured by the previous curator stay enabled. If the curator rotates and the new DAO approves the swapper for a token that still has an old route, `swap` runs the previous curator's targets and `minRate` against the new DAO's funds, with no re-review.  
**Recommendation:** Store the curator that set each route and require it to equal `stable.curator()` in `swap`/`swappable`, or document that a curator handover must be followed by `disableRoute` for every route and a fresh `setRoute`.

### [L-02] Defence-in-depth target check only covers the route's own foreign token  *(Low, comment fixed)*
**Location:** `ForeignSwapperV1.sol:78-84`  
**Description:** `setRoute` rejects `target == swapper`, `target == stable` and non-unwrap calls into the route's own `token`. A step can still target another token the DAO has approved to the swapper for a different route (or `tokenOut` / an intermediate) with `transferFrom(dao, recipient, amount)` calldata and spend that allowance. The contract comment presents the checks as preventing the route from touching the DAO's approvals, which is not fully true. This needs the curator, who already controls the DAO, so it is not a privilege escalation.  
**Recommendation:** Either reject any step whose `target` is a token used anywhere in the route or that has an approval from the DAO, or soften the comment so it does not imply a guarantee. A cheap partial improvement is to reject targets equal to `route.tokenOut` and to any step's `tokenIn`/`tokenOut` other than the single allowed unwrap.

### [L-03] `RouteSet` does not emit the steps  *(Low, accepted)*
**Location:** `ForeignSwapperV1.sol:95`, `IForeignSwapperV1.sol` `RouteSet`  
**Description:** Targets and calldata are the security-relevant part of a route, but the event carries only token, tokenOut and limits. Monitoring and the history of what a route did at a given time have to be reconstructed from calldata of `setRoute` transactions.  
**Recommendation:** Emit the steps (or a hash of them) in `RouteSet` so watchers can alert on changes to targets.

### [I-00] Price protection is a static `minRate` floor  *(Info, was Medium)*
**Location:** `ForeignSwapperV1.sol:107-137` (`swap`), `Route.minRate`  
**Description:** `swap` is permissionless and there is no oracle, so a caller chooses *when* the route runs. For routes made only of the ecosystem's own modules (swap routers, bridges, vault redemptions) the rate is set by fixed module fees, there is no pool price to move, and nothing can be extracted between the live rate and the floor; the floor then only guards against a misconfigured or changed module. The sandwich concern applies only if a route includes an AMM (e.g. a Curve pool) or an external aggregator, where a caller can skew the pool in the same block and keep the gap up to `minRate`.  
**Recommendation:** Keep routes to own modules, as intended. If a route ever includes an AMM or aggregator step, set `maxAmount` and a tight `minRate` for it and refresh the floor. Re-check the floor if a module's fee changes.

### [I-01] ERC-4626 unwrap restriction (change under review)  *(Info)*
**Location:** `ForeignSwapperV1.sol:158-164`  
**Description:** `_isUnwrap` now requires calldata of exactly 100 bytes, selector `redeem` or `withdraw`, and `receiver == owner == address(this)`. This closes the gap where the old comment claimed owner = msg.sender but nothing enforced it, so the vault call can no longer spend the DAO's share approval or pay anyone else. Tests cover rejection of foreign receiver/owner for both selectors and acceptance of the correct form. Note that `patchAmount` writes the swapper's `tokenIn` balance into the amount word, which is correct for `redeem` (shares) but would be a share count in the assets slot for `withdraw`; use `redeem` with `patchAmount`.  
**Recommendation:** None required; consider rejecting `withdraw` with `patchAmount == true`.

### [I-02] No native ETH support  *(Info)*
**Description:** There is no `receive` and no ETH sweep. A route whose step pays ETH to the swapper reverts at the target. Wrapped tokens only.

### [I-03] Dust calls when `minAmount == 0`  *(Info)*
**Description:** With `minAmount` unset anyone can run the route on a tiny balance. The caller pays the gas and `spent == 0`/`received == 0` revert, so this is griefing of nobody but a way to burn rate-limited allowances on aggregators. Set `minAmount` for every route.

### [I-04] Non-standard tokens  *(Info)*
**Description:** Fee-on-transfer and rebasing foreign tokens work only because `spent` and `received` are measured as balance deltas; `minRate` must account for the fee. Tokens with transfer hooks are covered by `nonReentrant` on `swap`.

### [I-05] Assembly block not marked memory-safe  *(Info)*
**Location:** `ForeignSwapperV1.sol:165-167`  
**Description:** The `mstore` writes into the in-memory copy of `Step.data` (offset `0xa0` is the `data` pointer for the current struct layout and `setRoute` guarantees `offset + 32 <= data.length`). It is correct, but it depends on the `Step` field order; reordering the struct silently breaks it.  
**Recommendation:** Annotate with `/// @solidity memory-safe-assembly` and keep a test that exercises patching (the existing tests do).

---

## Notes

- Access control: `setRoute` is `onlyCurator`; `disableRoute` is `onlyCuratorOrGuardian`; `swap` is permissionless by design. The guardian cannot enable or alter a route.
- Reentrancy: `swap` is `nonReentrant`. `setRoute`/`disableRoute` are not, but they require the curator/guardian, so a route target cannot reach them.
- Approvals: each step approves exactly the current balance and resets to 0 after the call; leftover foreign tokens, `tokenOut` and every intermediate are swept to the DAO in the same transaction, so the contract holds nothing between transactions. Stray balances sent to the swapper are swept to the DAO on the next swap of a route touching that token.
- The DAO's allowance to the swapper is the real exposure cap. Approve exact amounts or small buffers per token rather than `MaxUint256`, and keep `maxAmount` set.
- Deployment: constructor takes the stablecoin whose `curator()` is the DAO (`usduStable`). After deploy the DAO has to approve each foreign token and call `setRoute`.
