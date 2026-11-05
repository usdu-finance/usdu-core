// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IBorrowMarketV1
/// @notice Oracle-free, fixed-term borrow market. Every position is an NFT; markets are
///         whitelisted by the curator behind the stablecoin timelock. Positions are kept honest by Dutch-auction
///         challenges (as in Frankencoin v2) instead of a price oracle.
interface IBorrowMarketV1 {
	// ---------------------------------------------------------------------------------------
	// structs

	/// @notice Curator input for a new market.
	struct MarketParams {
		address collateral; // ERC20, max 24 decimals, must transfer exactly the requested amount
		uint64 maturity; // latest maturity any position of this market may choose
		uint64 challengePhase; // length of one challenge phase (the auction runs for two phases)
		uint256 minBalance; // minimum collateral balance of a position, prevents dust
		uint256 price; // highest position price, (36 - decimals) decimals
		uint256 reserve; // 1e18 scaled share of every mint that is locked as reserve
		uint256 limit; // 1e18 scaled, max stablecoin outstanding for this market
		uint256 rate; // 1e18 scaled annual interest, charged upfront until maturity
	}

	/// @notice A market (one collateral, one set of risk parameters). Immutable once accepted, except `borrowed` and `badDebt`.
	struct Market {
		uint256 marketId;
		address collateral;
		uint64 maturity;
		uint64 challengePhase;
		uint256 minBalance;
		uint256 price;
		uint256 reserve;
		uint256 limit;
		uint256 borrowed; // gross debt currently outstanding in the market, counts against the limit
		uint256 badDebt; // unbacked stablecoin left behind by liquidations that did not cover the debt
		uint256 rate;
	}

	struct PendingMarket {
		Market value;
		uint64 validAt;
	}

	/// @notice `borrowed` includes the reserve. The borrower receives borrowed - reserve - fee.
	struct Position {
		uint256 positionId; // NFT id
		uint256 marketId; // market id
		uint64 maturity;
		uint64 cooldown; // minting, withdrawing and price increases are suspended until this timestamp
		uint256 balance;
		uint256 borrowed;
		uint256 reserve; // part of `borrowed` that is held by this contract
		uint256 price; // starts at the market price, (36 - decimals) decimals
		uint256 challenged; // collateral currently under challenge
	}

	struct Challenge {
		address challenger;
		uint64 startTime;
		uint256 positionId;
		uint256 collateralSize; // collateral the challenger deposited
	}

	// ---------------------------------------------------------------------------------------
	// events and errors

	event MarketProposed(address indexed curator, uint256 indexed marketId, address indexed collateral, uint256 validAt);
	event MarketAccepted(uint256 indexed marketId);
	event MarketRevoked(address indexed account, uint256 indexed marketId);

	event PositionOpened(address indexed owner, uint256 indexed positionId, uint256 indexed marketId);
	event PositionUpdate(uint256 indexed positionId, uint256 balance, uint256 price, uint256 borrowed);
	event Authorized(uint256 indexed positionId, address indexed operator, bool allowed);

	event ChallengeStarted(address indexed challenger, uint256 indexed positionId, uint256 size, uint256 challengeId);
	event ChallengeAverted(uint256 indexed positionId, uint256 challengeId, uint256 size);
	event ChallengeSucceeded(uint256 indexed positionId, uint256 challengeId, uint256 bid, uint256 size);
	event ForcedSale(uint256 indexed positionId, uint256 amount, uint256 price);
	event BadDebt(uint256 indexed marketId, uint256 amount, uint256 total);

	error InvalidMarket();
	error IncompatibleCollateral();
	error InvalidPosition();
	error InvalidChallenge();
	error InvalidMaturity();
	error NotAuthorized();
	error InsufficientCollateral(uint256 value, uint256 debt);
	error LimitExceeded(uint256 requested, uint256 available);
	error RepaidTooMuch(uint256 excess);
	error FeeTooHigh();
	error Hot(uint256 until);
	error Challenged();
	error Expired();
	error NotExpired();
	error UnexpectedPrice();
	error InvalidPrice();
	error ChallengeTooSmall();
	error ChallengeTooLarge();
	error SameBlock();

	// ---------------------------------------------------------------------------------------
	// markets (curator)

	function proposeMarket(MarketParams calldata params) external returns (uint256 marketId);

	function revokeMarket(uint256 marketId) external;

	function acceptMarket(uint256 marketId) external;

	// ---------------------------------------------------------------------------------------
	// positions

	function open(uint256 marketId, uint256 amount, uint64 maturity, uint256 borrowAmount, address to) external returns (uint256 positionId);

	function deposit(uint256 positionId, uint256 amount) external;

	function withdraw(uint256 positionId, uint256 amount, address to) external;

	function mint(uint256 positionId, uint256 amount, address to) external;

	function repay(uint256 positionId, uint256 amount) external;

	function setPrice(uint256 positionId, uint256 newPrice) external;

	function setAuthorized(uint256 positionId, address operator, bool allowed) external;

	// ---------------------------------------------------------------------------------------
	// challenges and expiry

	function challenge(uint256 positionId, uint256 size, uint256 minimumPrice) external returns (uint256 challengeId);

	function bid(uint256 challengeId, uint256 size) external;

	function buyExpired(uint256 positionId, uint256 upTo) external returns (uint256 amount);

	function coverBadDebt(uint256 marketId, uint256 amount) external;

	// ---------------------------------------------------------------------------------------
	// views

	function getMarket(uint256 marketId) external view returns (Market memory);

	function getPosition(uint256 positionId) external view returns (Position memory);

	function isAuthorized(uint256 positionId, address operator) external view returns (bool);

	function feeRate(uint256 marketId, uint64 maturity) external view returns (uint256);

	function auctionPrice(uint256 challengeId) external view returns (uint256);

	function expiredPrice(uint256 positionId) external view returns (uint256);
}
