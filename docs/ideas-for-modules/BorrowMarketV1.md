# BorrowMarketV1

Single-contract, oracle-free, fixed-term borrow market. Status: first draft implemented in `contracts/borrow/BorrowMarketV1.sol` (+ `IBorrowMarketV1.sol`), compiles, **tested (84 tests)**.

## Principles

-   inherits from an interface (`IBorrowMarketV1`: structs, events, errors, functions)
-   positions are NFTs (ERC721), the NFT owner owns the position
-   "authorized": other addresses may act on behalf of the owner (like in Morpho), scoped per position
-   registered as a module on the stablecoin (`mintModule` / `burnModule`)
-   no price oracle: the position price is set by the borrower, and positions are kept honest by Dutch-auction challenges (same mechanism as Frankencoin `MintingHubV2` / `PositionV2`)
-   all collateral is accounted per position, never via `balanceOf` (donations cannot distort anything)

## Market

Curator adds a proposal (`proposeMarket`, `onlyCurator`), guarded by `stable.timelock()` like the other contracts. Never overrides: every proposal is a new, global, id-scoped entry. Curator or guardian can revoke while pending, anyone can `acceptMarket` after the timelock. From then on any user can open a position out of it.

```
Market {
    marketId: uint256        market id (proposal id)
    collateral: address
    maturity: uint64    latest maturity a position of this market may choose
    auction: uint64             NEW: duration of every auction of the market, 1 - 30 days
    minBalance: uint256    minimum collateral balance, prevents dust
    price: uint256    10**(36 - decimals), the "highest price" of the market
    reserve: uint256    1e18 scaled share of every mint that is locked
    limit: uint256         1e18 scaled, max stablecoin outstanding for the market
    borrowed: uint256        1e18 scaled, gross debt currently outstanding, counts against the limit (starts at 0)
    badDebt: uint256 unbacked stablecoin left by uncovered liquidations
    rate: uint256          1e18 scaled annual interest
}
```

Guards on proposal:

-   decimals <= 24 (leaves 12 digits for the price)
-   reserve between 10% and **50%** (repayment divides by `1 - reserve`, and above 50% the effective LTV `1 - ltv - reserve - fee` is too small to be useful)
-   rate <= 100%, maturity in the future, auction duration 1 - 30 days
-   `minBalance * price <= limit * 1e18`, so a minimal position fits the limit
-   collateral must transfer exactly the requested amount (fee-on-transfer is rejected)

## Position

```
Position {
    positionId: uint256      position id (nft)
    marketId: uint256        <-- market
    maturity: uint64            chosen by the borrower, <= market maturity
    cooldown: uint64       suspends mint / withdraw / price increase, for game theory incentives
    balance: uint256
    borrowed: uint256        gross debt, incl. reserve
    reserve: uint256 part of borrowed that is held by the contract
    price: uint256 starts with the market price
    challenged: uint256    collateral currently under challenge
}
```

`authorized` is not part of the struct (a mapping cannot be returned from a getter): it is a separate `positionId => epoch => operator => bool` mapping. The epoch is bumped on every NFT transfer, so a seller's operators lose access with the sale. Only the owner (or an ERC721 approved address) can grant it, operators cannot escalate.

## Accounting

-   mint of `amount` (gross): `borrowed += amount`, and
    -   `reserve = amount * market.reserve` is minted to the contract and locked
    -   `fee = amount * rate * (maturity - now) / 365d` is minted to the curator (upfront interest, no accrual afterwards)
    -   the borrower receives `amount - reserve - fee`
-   guarded by `balance * price >= borrowed` (balance below `minBalance` counts as 0)
-   `borrowed` (market level) grows on mint, shrinks on repay / liquidation, `limit - borrowed` is what can still be borrowed
-   mint only if cooldown is in the past, no challenge is running, and the position is not matured
-   repay `x`: pays `x`, burns `x` plus the proportional reserve; debt shrinks by `x * borrowed / (borrowed - reserve)`. `borrowed - reserve` closes the debt. Anyone may repay, also during a challenge
-   LTV is borrowed / collateral balance: eg 20000 USDU / 1 cbBTC

## Price

-   starts at the market price, which is also the hard cap (no "approval" path above it, see open questions)
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

## Auction curve (challenges and expired positions)

One curve for everything. It starts at 10x the position price and falls to 0 within the market's `auction` duration (1 - 30 days):

```
price(t) = 10 * positionPrice * (1 - t / duration)^2
```

It falls fast at first and ever slower: 2.5x after half the duration, 1x after ~68% of it, then a long tail towards 0. Two `mulDiv`s, no libraries. See `BorrowMarketV1-auction-curve.html` for a chart.

## Challenges (oracle-free liquidation)

1. `challenge`: anyone deposits `size` of their own collateral against the position's collateral. Guarded by `minimumPrice` against the owner lowering the price in the same block. The deposit is locked until the auction has sold it (or the position's collateral), there is no cancel
2. `bid` at the current auction price, two outcomes depending on the price:
    -   **at or above the position price: averted.** The bidder pays the challenger and receives the challenger's collateral. The position is untouched, cooldown 3 days. A challenger whose collateral is bought at a high price is simply paid for it, so there is nothing to monitor
    -   **below the position price: succeeded.** The bidder pays the offer and receives the position's collateral. The challenger gets their collateral back plus a reward of `reserve * 20%` of the offer (e.g. 10% reserve -> 2%, `AUCTION_REWARD_SHARE`). Cooldown 5 days
3. settlement (shared with expired positions): the proportional debt is repaid out of the offer (minus the reward) plus the proportional reserve. The owner is liquidated and gets nothing of the excess: all of it goes to the curator, after the market's bad debt is covered. The only case where the owner gets paid is an expired position sold at or above its position price (reserve ratio of the excess to the curator, the rest to the owner).
4. shortfall is written off as `badDebt` (a field of the market) and does not free capacity. `coverBadDebt` burns stablecoin against it and frees the capacity again

## Maturity

-   after maturity: no mint, no price change, no new challenge
-   `buyExpired`: same curve, starting at maturity, no challenger and no deposit. Same settlement as a succeeded challenge. Not while a challenge is open
    -   price at or above the position price: the curator receives the expiry fee (`reserve * 20%` of the offer) out of the proceeds, on top of its reserve share of the excess
    -   price below the position price: no fee, the owner forfeits the excess. The proceeds repay the debt first, everything that is left goes to the curator
-   everything the curator receives from an auction (reserve share of the excess, expiry fee, forfeited excess) first covers the market's `badDebt`, which frees its capacity again, only the rest is paid out

## Open questions / not included

-   "if approved -> check if higher than the collateral id price -> set price": implemented as a hard cap at the market price. Is a curator-approved price above it intended?
-   public proposals with fee (like `setModulePublic`)
-   guardian kill switch for a live market (for now only the module expiry on the stablecoin)
-   rolling / extending maturity
-   implement `IModuleRevenueV1` / `IModuleExpenseV1`? Fees go to the curator directly today
