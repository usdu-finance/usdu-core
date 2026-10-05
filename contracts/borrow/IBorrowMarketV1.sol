// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @title IBorrowMarketV1
/// @notice Oracle-free, fixed-term borrow market. Every position is an NFT; collateral families ("proposals") are
///         whitelisted by the curator behind the stablecoin timelock. Positions are kept honest by Dutch-auction
///         challenges (as in Frankencoin v2) instead of a price oracle.
interface IBorrowMarketV1 {
	// ---------------------------------------------------------------------------------------
	// structs

	/// @notice Curator input for a new collateral family.
	struct CollateralParams {
		address collateral; // ERC20, max 24 decimals, must transfer exactly the requested amount
		uint64 maturity; // latest maturity any position of this family may choose
		uint64 challenge; // length of one challenge phase (the auction runs for two phases)
		uint256 minBalance; // minimum collateral balance of a position, prevents dust
		uint256 price; // highest position price, (36 - decimals) decimals
		uint256 reserve; // 1e18 scaled share of every mint that is locked as reserve
		uint256 limit; // 1e18 scaled, max stablecoin outstanding for this family
		uint256 rate; // 1e18 scaled annual interest, charged upfront until maturity
	}

	/// @notice A collateral family. Immutable once accepted, except `available`.
	struct Collateral {
		uint256 id;
		address collateral;
		uint64 maturity;
		uint64 challenge;
		uint256 minBalance;
		uint256 price;
		uint256 reserve;
		uint256 limit;
		uint256 available; // limit minus the debt currently outstanding in the family
		uint256 rate;
	}

	struct PendingCollateral {
		Collateral value;
		uint64 validAt;
	}

	/// @notice `minted` is the gross debt (incl. reserve). The borrower receives minted - reserve - fee.
	struct Position {
		uint256 id; // NFT id
		uint256 proposal; // collateral family id
		uint64 maturity;
		uint64 cooldown; // minting, withdrawing and price increases are suspended until this timestamp
		uint256 balance;
		uint256 minted;
		uint256 reserve; // part of `minted` that is held by this contract
		uint256 price; // starts at the family price, (36 - decimals) decimals
		uint256 challenged; // collateral currently under challenge
	}

	struct Challenge {
		address challenger;
		uint64 start;
		uint256 position;
		uint256 size; // collateral the challenger deposited
	}

	// ---------------------------------------------------------------------------------------
	// events and errors

	event CollateralProposed(address indexed curator, uint256 indexed id, address indexed collateral, uint256 validAt);
	event CollateralAccepted(uint256 indexed id);
	event CollateralRevoked(address indexed account, uint256 indexed id);

	event PositionOpened(address indexed owner, uint256 indexed id, uint256 indexed proposal);
	event PositionUpdate(uint256 indexed id, uint256 balance, uint256 price, uint256 minted);
	event Authorized(uint256 indexed id, address indexed operator, bool allowed);

	event ChallengeStarted(address indexed challenger, uint256 indexed id, uint256 size, uint256 number);
	event ChallengeAverted(uint256 indexed id, uint256 number, uint256 size);
	event ChallengeSucceeded(uint256 indexed id, uint256 number, uint256 bid, uint256 size);
	event ForcedSale(uint256 indexed id, uint256 amount, uint256 price);
	event BadDebt(uint256 indexed proposal, uint256 amount, uint256 total);

	error InvalidCollateral();
	error IncompatibleCollateral();
	error InvalidPosition();
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
	// collateral families (curator)

	function proposeCollateral(CollateralParams calldata params) external returns (uint256 id);

	function revokeCollateral(uint256 id) external;

	function acceptCollateral(uint256 id) external;

	// ---------------------------------------------------------------------------------------
	// positions

	function open(uint256 proposal, uint256 amount, uint64 maturity, uint256 mintAmount, address to) external returns (uint256 id);

	function deposit(uint256 id, uint256 amount) external;

	function withdraw(uint256 id, uint256 amount, address to) external;

	function mint(uint256 id, uint256 amount, address to) external;

	function repay(uint256 id, uint256 amount) external;

	function setPrice(uint256 id, uint256 newPrice) external;

	function setAuthorized(uint256 id, address operator, bool allowed) external;

	// ---------------------------------------------------------------------------------------
	// challenges and expiry

	function challenge(uint256 id, uint256 size, uint256 minimumPrice) external returns (uint256 number);

	function bid(uint256 number, uint256 size) external;

	function buyExpired(uint256 id, uint256 upTo) external returns (uint256 amount);

	function coverBadDebt(uint256 proposal, uint256 amount) external;

	// ---------------------------------------------------------------------------------------
	// views

	function getCollateral(uint256 id) external view returns (Collateral memory);

	function getPosition(uint256 id) external view returns (Position memory);

	function isAuthorized(uint256 id, address operator) external view returns (bool);

	function feeRate(uint256 proposal, uint64 maturity) external view returns (uint256);

	function auctionPrice(uint256 number) external view returns (uint256);

	function expiredPrice(uint256 id) external view returns (uint256);
}
