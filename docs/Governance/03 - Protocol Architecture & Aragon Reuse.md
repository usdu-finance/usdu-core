# Protocol Shape + Aragon vs. OZ (Idea #3)

## Where this picks up

Continues `01 - veGOV Foundations.md` and `02 - Scope, Emissions & Treasury Routing.md`. This doc narrows scope in one important way: each stablecoin protocol (USDU, EURU, CHFU, …) is **self-contained**. Governance doesn't live inside it — it only plugs into it through the swappable `curator`/`guardian` slots. This reframes the earlier "cross-protocol scope" question (Idea #2 §3) from "does one veGOV governor span protocols" to something simpler underneath: however many stablecoins exist, each one just needs *a* curator address, and governance's job is to be a good tenant of that slot.

## 1. A stablecoin protocol, as itself

Per-protocol shape:

- **Stablecoin contract** — modular, e.g. USDU.
- **Adapter/module layer** — pluggable strategies, each curator-approved.
- **Treasury** — all revenue routes in, all expenses pull from it.

Governance is **not implemented inside this** beyond the `curator`/`guardian` role slots (`Stablecoin.sol`, adapters). That's deliberate — those slots are meant to be swapped out, not extended.

## 2. Revenue-generating module ideas (concrete examples)

Three distinct shapes raised, all funneling profit into the treasury:

**a) Curve/Morpho rebalancing adapter**
1. Mints USDU to balance out a Curve pool that's run low, swapping it for e.g. USDC.
2. Deposits that USDC into Morpho to earn lending rewards while it's idle.
3. Reconciles accrued profit into the treasury — same pattern the existing Morpho adapter already uses (compare `totalAssets()` against `totalMinted`, mint the surplus, distribute it), or a new mechanism if this arb needs something different — this can happen here or get folded into step 5, not necessarily both.
4. Redeems the USDC from Morpho and swaps it back on Curve, collecting the arbitrage.
5. Repays the debt (burns the USDU it minted) and claims profit into the reserve, if that wasn't already done in step 3.

**b) Borrow market module** — a specific-collateral lending market (see `BorrowMarketV1.sol.md`), earning upfront fees + liquidation profits.

**c) Bond-like module** — users lock USDU, receive a fixed reward paid out from the treasury.

Different risk/return/liquidity shapes, same destination: treasury.

## 3. What governance is actually being asked to do

Not "govern the stablecoin's internals" — govern **the set of modules and their approval**, sitting entirely behind the existing `curator` slot. Specifically:

- **Approve/veto new modules** — on the stablecoin side, this should stay a **veto-based** check (matches the guardian pattern already in place: fast, bounded, can reject/revoke a pending change).
- **Arbitrary code execution** — on the governance-contract side, proposals should be able to do anything a DAO can do (call any target, any calldata) — "like an Aragon DAO."

That second point is the interesting one: you already have exactly that.

## 4. Do you still need Aragon, or should this be OZ?

Checked the deployed setup (`exports/address.config.ts`, `exports/abis/aragon/*`): this is **Aragon OSx**, and it's already live.

```
curator == aragonDao   (same address, 0x9fe66037c44236c87D9Ac8345F489b4413fDFf06)

AragonMultiSig  --create/approve proposal-->
AragonDelayedAction  --staged advance-->
AragonVetoMultiSig  --veto window-->
AragonDao.execute()  (gated by EXECUTE_PERMISSION_ID, arbitrary target + calldata)
```

That's already a propose → delay → veto → execute pipeline. It's multisig-driven today, not token-driven — but the pipeline shape is exactly what Idea #1's two-layer governance/guardian split was describing, already built.

**My take: reuse the Aragon DAO core, don't rebuild on OZ.**

Reasoning:

- `curator` on every stablecoin/adapter contract already points at the **DAO core address**, not at the Multisig plugin. Aragon OSx's whole design point is that the DAO core's identity never changes — only which plugin holds `EXECUTE_PERMISSION_ID` changes. That means: **no `setCurator` migration across any deployed module**, on any protocol, ever. Grant `EXECUTE_PERMISSION_ID` to a new veGOV plugin, revoke it from `AragonMultiSig`, done.
- Arbitrary code execution is already native to the DAO core (`execute(bytes32, Action[], uint256)`). You don't need to reimplement that — you need a plugin that's authorized to call it.
- The veto layer already exists (`AragonVetoMultiSig`) and structurally matches the guardian concept from Idea #1 — worth evolving rather than replacing. It could stay a small trusted multisig (fast, protective, matches guardian's current job), or later become veGOV-gated too, without touching the DAO core either way.
- Going OZ Governor+TimelockController instead means standing up a brand-new authority address and migrating every `curator` pointer on every module across every protocol to it — real, repeated, per-protocol migration work, each one behind its own existing timelock, for no capability you don't already have.

**What still has to be built either way**, Aragon or OZ: neither's stock voting mechanism does what veGOV needs.
- Aragon's official `TokenVoting` plugin uses OZ `ERC20Votes` — snapshot-based, no time-decay.
- OZ `Governor` has the same `ERC20Votes` limitation.

So the real work isn't "Aragon vs. OZ" as competing foundations — it's writing a **custom voting-power source** (the ve-lock/decay mechanic from Idea #2 §4) and wiring it into a plugin that plugs into the *existing* Aragon DAO's permission system, replacing `AragonMultiSig` as the thing allowed to create/execute proposals. Aragon OSx plugins are exactly the extension point for this — a custom plugin implementing the proposal lifecycle, sourcing weight from the ve-lock contract instead of a checkpointed balance.

## 5. Treasury identity, and building USDU ahead of the governance build

Two follow-on points, both confirmed against how Aragon OSx actually works.

**The treasury can be the same DAO contract.** Not a workaround — this is the native OSx pattern: the DAO core contract is designed to *be* the vault (it holds ETH/ERC20/ERC721/ERC1155 directly), and permissioned `execute()` is the only way funds ever leave. So "curator," "governance identity," and "treasury" collapsing into one address (`aragonDao`) isn't three things glued together — it's one contract doing what it was built for.

The thing to be precise about: this means the treasury has **no separate contract boundary**. Its safety becomes entirely a function of *which permission ID gates spending it*, not physical isolation from the rest of governance. That's fine — it's how OSx expects to be used — but it means the reserve-protection guardrail from Idea #1/#2 ("reserve withdrawals need a higher bar than ordinary parameter votes") has to be enforced explicitly through Aragon's permission system: a distinct permission ID (or a distinct plugin) for treasury-moving actions versus the one for adapter-approval/parameter actions. Otherwise "approve a new adapter" and "send treasury funds out" end up sitting behind the same threshold by accident.

**This decouples USDU module work from the governance build entirely.** Every adapter and module only ever checks `onlyCurator`/`onlyGuardian` against the DAO address — never against a specific governance mechanism sitting behind it. Combined with §4 (DAO core identity never moves, only who holds `EXECUTE_PERMISSION_ID` does), that means USDU's modules/adapters/logic can be built and shipped now, against the *current* Aragon setup (`AragonMultiSig` + `AragonVetoMultiSig` + `AragonDelayedAction`), without waiting on any open question from this doc or Idea #2 (decay curve, lock representation, emission model, per-protocol scope). The veGOV plugin swap-in later touches zero adapter code — it only changes who's authorized to call `execute()` on a DAO address that was never going anywhere.

## 6. Open questions this doc doesn't resolve

- Does `AragonVetoMultiSig` stay a small trusted multisig indefinitely, or eventually become veGOV-gated itself? (Idea #1's guardrail was to keep guardian fast/constrained — a multisig arguably fits that better than a second token vote.)
- Per-protocol vs. shared DAO core: does each stablecoin (USDU/EURU/CHFU) get its own Aragon DAO instance with its own plugin, or is there one shared veGOV plugin that's granted `EXECUTE_PERMISSION_ID` on multiple DAOs? (Ties back to Idea #2 §3's (a) vs (b) split — now sharper: it's "one veGOV plugin, installed on N DAOs" vs "N veGOV plugins, one shared vote source.")
- Still fully open from Idea #2: lock representation (balance vs. veNFT), decay curve shape, emission model.
