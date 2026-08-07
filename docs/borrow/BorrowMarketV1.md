- inhert from interface
- stuct needed
- we will use NFTs as positions id
- we will you "authorized", so other addresses are allowed to act on behalf of owner

- there should be a config for collaterals struct, by the stable.verifyCurator


workflow:

curator adds new proposal/whitlisting (timelock guarded - same idea as we have already in the other contracts), not overrides, it acts as a global id-scoped entry
e.g. mapping => collateral struct (we might need a better wording for this one)
{
    id: uint256, proposal id / collateral id
    collateral: address,
    maturity: uint64 (?), for timestamp
    minBalance: uint265, 
    price: uint256, 10**(36 - decimals), --> guard in add collateral for decimals max 24 digits, the price is the "highest price" in the id-scoped family
    reserve: uint256, 1e18 scaled --> guard, min: 10%, max: 100%
    limit: uint256, 1e18 scaled for max minting limit for stablecoin
    available: uint256, 1e18 scaled for available
    rate: uint256, 1e18 scaled for interest rate 
}

if proposal is granted after timelock, any user can create a position out of it. 

positions map NFTs and also has a mapping => position struct

{
    id: uint256, position id (nft)
    proposal: uint256, <-- collateral struct
    maturity: uint64, max. collateral struct maturity
    balance: uint256,
    minted: uint256,
    reserve: uint256,
    price: uint256, starts with collateral struct price
    challenged: uint256, challenged balance
    cooldown: uint265, cooldownfor various game theory incentives
    authorized: mapping address => bool
}

if mint increases --> minted increases --> reserve increases
guarded by balance * price

can only mint more if cooldown is in the past.

price can be increased by max 2x --> triggers cooldown 5days
if "approved" -> check if higher then the collateral id price -> set price

LTV is minted/collateral balance: eg 20000 USDU / 1 cbBTC

what can a user do with its position: