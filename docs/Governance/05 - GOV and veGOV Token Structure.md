# GOV and veGOV — Token Structure (Idea #5)

## Where this picks up

Continues `04 - GOV Pool Seeding, Minting Adapter & veGOV Structure.md`, which established the three-pool structure, seeding mechanics, and the discrete 2-year/4-year veGOV lock tiers. This doc narrows in on the actual contract shape of `GOV.sol` and `veGOV.sol` — bare minimum, structural only, confirmed against the real `contracts/stablecoin/Stablecoin.sol` implementation rather than the abstract description in doc `03`.

**The veGOV decay/weighting math is explicitly not covered here** — how a 2-year vs. 4-year lock actually translates into a voting-power number is still open, to be worked out as its own topic.

## 1. GOV.sol mirrors Stablecoin.sol's access-control shape

`Stablecoin.sol`'s curator/guardian/timelock/module machinery is generic — nothing in it is stablecoin-specific except the freeze feature (see below). `GOV.sol` should reuse the same shape directly:

```text
Stablecoin.sol (today)                  GOV.sol (proposed)
───────────────────────                 ──────────────────
curator / pendingCurator                curator / pendingCurator      = aragonDao (doc 03)
guardian / pendingGuardian              guardian / pendingGuardian    unset at genesis
timelock / pendingTimelock              timelock / pendingTimelock    same mechanics
modules / pendingModules                modules / pendingModules      mint-capable adapters
mintModule / burnModule / burn          mintModule / burnModule / burn
setModule / setModulePublic             setModule                     public path dropped, see below
acceptModule / revokePendingModule      acceptModule / revokePendingModule
unfreeze / pendingUnfreeze              — dropped, see below
```

Reuse, don't reimplement: `PendingAddress` / `PendingUint192` (`stablecoin/libraries/PendingLib.sol`) and the timelock bounds in `stablecoin/libraries/ConstantsLib.sol` (`MIN_TIMELOCK = 7 days`, `MAX_TIMELOCK = 4 weeks`, `PUBLIC_FEE = 10000 ether`) are already token-agnostic — `GOV.sol` imports them as-is.

**What "bare minimum" means, concretely, function by function:**

- `curator` — set to `aragonDao` at construction. Same address, same non-migration property as doc `03` §4: only which Aragon plugin holds `EXECUTE_PERMISSION_ID` on that DAO ever changes, `GOV.sol`'s `curator` pointer never does.
- `guardian` — keep the slot (`setGuardian`/`acceptGuardian`/`revokePendingGuardian`), can stay `address(0)` at genesis.
- `timelock` + `pendingTimelock` — identical flow (`setTimelock` → bounds-checked → `acceptTimelock`, or instant if raising the timelock).
- `modules` mapping — expiry-based validity (`modules[module] = expiredAt`, checked via `checkValidModule` = `modules[account] > block.timestamp`), identical to `Stablecoin.sol`. This is what the seeding adapter from doc `04` §2 registers against.
- `mintModule(to, value)` / `burnModule(from, amount)` / public `burn(amount)` — identical signatures and gating (`validModule` / `onlyModule` modifiers).
- `setModule` / `acceptModule` / `revokePendingModule` — identical curator-gated flow.
- **`setModulePublic`/`claimPublicFee` (the permissionless, fee-gated registration path) is dropped.** On `Stablecoin.sol` it's a safety valve against an unresponsive curator: worst case, a bad module that slips through exposes the stablecoin to strategy risk. On `GOV.sol`, a `modules` registration is a grant of minting power over the governance token itself — a capture vector the stablecoin doesn't have. Pay the fee, get a module pending; if curator/guardian miss the `timelock * 2` revoke window, the module mints GOV, which can be locked into veGOV and used to vote — potentially on whether to remove the very module that just diluted everyone. One step from "pay a fee" to "gain governance power over the thing gating governance power," with no equivalent for minting USDU (that doesn't buy GOV influence without a separate, costly step). GOV module registration should always go through an actual DAO vote (the "coin voting majority" plugin, doc `04` §5), not a pay-and-wait bypass around it — that path is already permissionless enough (anyone can propose; a proposal-fee anti-spam mechanism was floated for it separately).
- **`unfreeze`/`pendingUnfreeze` (account freezing) is dropped.** That's a stablecoin-specific compliance feature with no obvious equivalent need for a governance token — an intentional omission, not an oversight, unless a reason to keep it surfaces later.
- `ERC20Permit` — worth keeping; gasless approvals are generically useful and nothing about it is stablecoin-specific.

## 2. veGOV.sol is a separate contract, not a mode of GOV

veGOV isn't a flag on GOV — it's its own contract that GOV gets locked into:

```text
   GOV (liquid, ERC20)
       │  lock(amount, tier)        tier ∈ {2 years, 4 years} — doc 04 §4
       ▼
   veGOV.sol
       │  holds locked GOV, position is non-transferable
       │  exposes IVotes:
       │    getVotes / getPastVotes / getPastTotalSupply / delegates / delegate / delegateBySig
       ▼
   Aragon "coin voting majority" / "coin veto minority" plugins (doc 04 §5)
```

- **Non-transferable** — no `transfer`/`transferFrom` path for the locked position itself (soulbound to the locker, per doc `04` §4).
- **`IVotes`-compliant** — this is the entire integration surface: Aragon's plugins (or anything Governor-style) only need these calls answered correctly for a historical timepoint. Whatever internal accounting veGOV ends up using for the decay/tier math is invisible to everything downstream as long as this interface is honored.
- **Delegation** — a locker can delegate their veGOV voting weight elsewhere while their GOV stays locked to their own address. This is independent of *unlocking*, and should work the same regardless of how the weighting math is eventually decided.
- veGOV does **not** need `GOV.sol`'s full curator/modules/timelock machinery — it isn't mint-capable and isn't meant to be extended by adapters. Its only likely governed surface is which lock tiers are offered, a much smaller footprint than GOV's.

## 3. Explicitly not resolved in this doc

- **The decay/weighting math** — how `lock(amount, 2 years)` vs. `lock(amount, 4 years)` becomes a `getPastVotes` number, and how that number moves (or doesn't) as the lock ages. Doc `04` §4 sketched why plain `ERC20Votes` can't be inherited as-is (checkpoints only update on transfer, not on time passing alone) and named the two implementation directions (continuous bias/slope math vs. epoch-rounded checkpoints with a permissionless poke) — but no formula is chosen yet. Next doc.
- Whether veGOV needs its own `guardian`/emergency-unlock path (e.g. if a lock tier's economics turn out wrong) — not discussed.
- Lock representation: plain non-transferable balance (assumed above, matching doc `04` §4) vs. veNFT per-position (doc `02`, still open) — not ruled out here, just not the shape described.
