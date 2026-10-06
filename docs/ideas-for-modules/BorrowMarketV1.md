# BorrowMarketV1

Single-contract, oracle-free, fixed-term borrow market. Status: first draft implemented in `contracts/borrow/BorrowMarketV1.sol` (+ `IBorrowMarketV1.sol`), compiles, **not yet tested**.

## Principles

-   inherits from an interface (`IBorrowMarketV1`: structs, events, errors, functions)
-   positions are NFTs (ERC721), the NFT owner owns the position
-   "authorized": other addresses may act on behalf of the owner (like in Morpho), scoped per position
-   registered as a module on the stablecoin (`mintModule` / `burnModule`)
-   no price oracle: the position price is set by the borrower, and positions are kept honest by Dutch-auction challenges (same mechanism as Frankencoin `MintingHubV2` / `PositionV2`)
-   all collateral is accounted per position, never via `balanceOf` (donations cannot distort anything)

## Collateral family (a.k.a. proposal)

Curator adds a proposal (`proposeCollateral`, `onlyCurator`), guarded by `stable.timelock()` like the other contracts. Never overrides: every proposal is a new, global, id-scoped entry. Curator or guardian can revoke while pending, anyone can `acceptCollateral` after the timelock. From then on any user can open a position out of it.

```
Collateral {
    id: uint256            proposal id / collateral id
    collateral: address
    maturity: uint64       latest maturity a position of this family may choose
    challenge: uint64      NEW: length of one challenge phase, 1 - 30 days
    minBalance: uint256    minimum collateral balance, prevents dust
    price: uint256         10**(36 - decimals), the "highest price" of the family
    reserve: uint256       1e18 scaled share of every mint that is locked
    limit: uint256         1e18 scaled, max stablecoin outstanding for the family
    available: uint256     1e18 scaled, limit minus debt currently outstanding (starts at limit)
    rate: uint256          1e18 scaled annual interest
}
```

Guards on proposal:

-   decimals <= 24 (leaves 12 digits for the price)
-   reserve between 10% and **90%** (was 100%: repayment divides by `1 - reserve`)
-   rate <= 100%, maturity in the future, challenge phase 1 - 30 days
-   `minBalance * price <= limit * 1e18`, so a minimal position fits the limit
-   collateral must transfer exactly the requested amount (fee-on-transfer is rejected)

## Position

```
Position {
    id: uint256            position id (nft)
    proposal: uint256      <-- collateral family
    maturity: uint64       chosen by the borrower, <= family maturity
    cooldown: uint64       suspends mint / withdraw / price increase, for game theory incentives
    balance: uint256
    minted: uint256        gross debt, incl. reserve
    reserve: uint256       part of minted that is held by the contract
    price: uint256         starts with the family price
    challenged: uint256    collateral currently under challenge
}
```

`authorized` is not part of the struct (a mapping cannot be returned from a getter): it is a separate `id => epoch => operator => bool` mapping. The epoch is bumped on every NFT transfer, so a seller's operators lose access with the sale. Only the owner (or an ERC721 approved address) can grant it, operators cannot escalate.

## Accounting

-   mint of `amount` (gross): `minted += amount`, and
    -   `reserve = amount * family.reserve` is minted to the contract and locked
    -   `fee = amount * rate * (maturity - now) / 365d` is minted to the curator (upfront interest, no accrual afterwards)
    -   the borrower receives `amount - reserve - fee`
-   guarded by `balance * price >= minted` (balance below `minBalance` counts as 0)
-   `available` shrinks on mint, grows on repay / liquidation
-   mint only if cooldown is in the past, no challenge is running, and the position is not matured
-   repay `x`: pays `x`, burns `x` plus the proportional reserve; debt shrinks by `x * minted / (minted - reserve)`. `minted - reserve` closes the debt. Anyone may repay, also during a challenge
-   LTV is minted / collateral balance: eg 20000 USDU / 1 cbBTC

## Price

-   starts at the family price, which is also the hard cap (no "approval" path above it, see open questions)
-   can be increased by max 2x per step, triggers a 5 day cooldown
-   can be lowered, if the position stays covered
-   not while challenged or matured

## What a user can do with its position

-   `open`: deposit collateral, choose maturity, optionally mint right away
-   `deposit`: anyone, can only make it safer
-   `withdraw`: authorized, as long as covered, not while challenged / in cooldown
-   `mint`: authorized
-   `repay`: anyone
-   `setPrice`: authorized
-   `setAuthorized`: owner
-   transfer / sell the NFT

## Challenges (oracle-free liquidation)

1. `challenge`: anyone deposits `size` of their own collateral against the position's collateral. Guarded by `minimumPrice` against the owner lowering the price in the same block
2. phase 1 (`family.challenge`): anyone can avert via `bid` by paying the position price to the challenger and receiving the challenger's collateral (the challenger can cancel for free). Cooldown 1 day. Not in the same block
3. phase 2: Dutch auction, price falls linearly from the position price to 0. `bid` pays the offer, receives the position's collateral. The challenger gets their collateral back plus 2% of the offer. Cooldown 3 days
4. settlement (shared with forced sales): the proportional debt is repaid out of the offer plus the proportional reserve. Excess is split: reserve ratio to the curator, the rest to the owner.
5. shortfall is written off as `badDebt` per family and does not free capacity. `coverBadDebt` burns stablecoin against it and frees the capacity again

## Maturity

-   after maturity: no mint, no price change, no new challenge
-   `buyExpired`: forced sale, price starts at 10x the position price, falls to 1x within one challenge phase and to 0 within another. Same settlement as a successful challenge. Not while a challenge is open

## Open questions / not included

-   "if approved -> check if higher than the collateral id price -> set price": implemented as a hard cap at the family price. Is a curator-approved price above it intended?
-   public proposals with fee (like `setModulePublic`)
-   guardian kill switch for a live family (for now only the module expiry on the stablecoin)
-   rolling / extending maturity
-   implement `IModuleRevenueV1` / `IModuleExpenseV1`? Fees go to the curator directly today
-   tests: open, mint, repay, averted challenge, successful challenge with excess and with bad debt, `buyExpired`, authorization epoch
