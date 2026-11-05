// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ERC721} from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';
import {ErrorsLib} from '../stablecoin/libraries/ErrorsLib.sol';

import {IBorrowMarketV1} from './IBorrowMarketV1.sol';

/// @title BorrowMarketV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Single-contract, oracle-free borrow market. Positions are NFTs, markets are whitelisted by
///         the curator behind the stablecoin timelock, and positions are kept honest by Dutch-auction challenges
///         instead of a price oracle.
/// @dev Must be registered as a module on the stablecoin (mintModule/burnModule).
/// @dev Accounting model: `borrowed` is the gross debt of a position. On mint, `reserve` of it is minted to this
///      contract and locked, `fee` (upfront interest until maturity) is minted to the curator, and the rest goes to
///      the borrower. Repaying `amount` burns `amount` from the payer plus the proportional reserve, so the supply
///      attributable to a position always equals its `borrowed`. All collateral is accounted per position (never via
///      balanceOf), so donations cannot distort anything.
contract BorrowMarketV1 is ERC721, ReentrancyGuard, IStablecoinModifier, IBorrowMarketV1 {
	using SafeERC20 for IERC20;

	uint256 internal constant ONE = 1 ether;

	/// @notice Reserve bounds per market. Above 50% the effective LTV (price - reserve - upfront fee) is too small to be useful.
	uint256 public constant MIN_RESERVE = 0.1 ether;
	uint256 public constant MAX_RESERVE = 0.5 ether;

	/// @notice Bounds of the auction duration.
	uint64 public constant MIN_AUCTION = 1 days;
	uint64 public constant MAX_AUCTION = 30 days;

	/// @notice Share of the market reserve ratio that is paid out of the proceeds of an auction, relative to the winning
	///         bid. With a 10% reserve and a 20% share it is 2%, a higher reserve pays more. It is the challenger reward
	///         of a succeeded challenge and the expiry fee of the curator when an expired position is bought.
	uint256 public constant AUCTION_REWARD_SHARE = 0.2 ether;

	/// @notice A position price can be raised by at most this factor per step.
	uint256 public constant MAX_PRICE_INCREASE = 2;

	/// @notice Cooldowns, during which minting, withdrawing and price increases are suspended.
	uint64 public constant COOLDOWN_PRICE_INCREASE = 5 days;
	uint64 public constant COOLDOWN_CHALLENGE_AVERTED = 3 days;
	uint64 public constant COOLDOWN_CHALLENGE_SUCCEEDED = 5 days;

	/// @notice Every auction starts at this multiple of the position price and falls to 0 within the auction duration.
	uint256 public constant AUCTION_PRICE_FACTOR = 10;

	// ---------------------------------------------------------------------------------------

	uint256 public marketCount;
	uint256 public positionCount;
	uint256 public challengeCount;

	mapping(uint256 marketId => Market) internal _markets;
	mapping(uint256 marketId => PendingMarket) internal _pendingMarkets;
	mapping(uint256 positionId => Position) internal _positions;
	mapping(uint256 challengeId => Challenge) internal _challenges;

	/// @dev Operator approvals are scoped to the current owner: the epoch is bumped on every transfer.
	mapping(uint256 positionId => uint256) internal _epoch;
	mapping(uint256 positionId => mapping(uint256 epoch => mapping(address operator => bool))) internal _authorized;

	// ---------------------------------------------------------------------------------------

	/// @dev NFT name and symbol are derived from the stablecoin symbol, e.g. 'USDU Borrow Position' / 'USDU-BP'.
	constructor(
		IStablecoinMetadata _stable
	)
		ERC721(
			string.concat(IERC20Metadata(address(_stable)).symbol(), ' Borrow Position'),
			string.concat(IERC20Metadata(address(_stable)).symbol(), '-BP')
		)
		IStablecoinModifier(_stable)
	{}

	// ---------------------------------------------------------------------------------------
	// markets

	/// @notice Curator proposes a new market. Becomes acceptable after stable.timelock(). Never overrides, every
	///         market gets its own id.
	function proposeMarket(MarketParams calldata p) external onlyCurator returns (uint256 marketId) {
		if (p.collateral == address(0) || p.collateral == address(stable)) revert InvalidMarket();
		if (IERC20Metadata(p.collateral).decimals() > 24) revert InvalidMarket(); // leaves 12 digits for price
		if (p.maturity <= block.timestamp) revert InvalidMaturity();
		if (p.auction < MIN_AUCTION || p.auction > MAX_AUCTION) revert InvalidMarket();
		if (p.reserve < MIN_RESERVE || p.reserve > MAX_RESERVE) revert InvalidMarket();
		if (p.minBalance == 0 || p.price == 0 || p.limit == 0 || p.rate > ONE) revert InvalidMarket();
		if (p.minBalance * p.price > p.limit * ONE) revert InvalidMarket(); // a min position must fit the limit

		marketId = ++marketCount;
		PendingMarket storage pending = _pendingMarkets[marketId];
		pending.value = Market({
			marketId: marketId,
			collateral: p.collateral,
			maturity: p.maturity,
			auction: p.auction,
			minBalance: p.minBalance,
			price: p.price,
			reserve: p.reserve,
			limit: p.limit,
			borrowed: 0,
			badDebt: 0,
			rate: p.rate
		});
		pending.validAt = uint64(block.timestamp + stable.timelock());

		emit MarketProposed(_msgSender(), marketId, p.collateral, pending.validAt);
	}

	/// @notice Cancels a pending marketId.
	function revokeMarket(uint256 marketId) external onlyCuratorOrGuardian {
		if (_pendingMarkets[marketId].validAt == 0) revert ErrorsLib.NoPendingValue();
		delete _pendingMarkets[marketId];
		emit MarketRevoked(_msgSender(), marketId);
	}

	/// @notice Permissionless after the timelock. Positions can be opened afterwards.
	function acceptMarket(uint256 marketId) external afterTimelock(_pendingMarkets[marketId].validAt) {
		Market memory m = _pendingMarkets[marketId].value;
		if (m.maturity <= block.timestamp) revert InvalidMaturity();

		_markets[marketId] = m;
		delete _pendingMarkets[marketId];
		emit MarketAccepted(marketId);
	}

	// ---------------------------------------------------------------------------------------
	// positions

	/// @notice Opens a position, owned by the caller, and optionally mints right away. The mint is guarded by the
	///         market price, like any later mint.
	/// @param marketId market id
	/// @param amount initial collateral, must be at least the market's minBalance
	/// @param maturity chosen maturity, at most the market maturity
	/// @param borrowAmount gross debt to take on, can be 0
	/// @param to receiver of the borrowed stablecoin
	function open(
		uint256 marketId,
		uint256 amount,
		uint64 maturity,
		uint256 borrowAmount,
		address to
	) external nonReentrant returns (uint256 positionId) {
		Market storage m = _markets[marketId];
		if (m.marketId == 0) revert InvalidMarket();
		if (maturity <= block.timestamp || maturity > m.maturity) revert InvalidMaturity();
		if (amount < m.minBalance) revert InsufficientCollateral(amount, m.minBalance);

		positionId = ++positionCount;
		_positions[positionId] = Position({
			positionId: positionId,
			marketId: marketId,
			maturity: maturity,
			cooldown: 0,
			balance: amount,
			borrowed: 0,
			reserve: 0,
			price: m.price,
			challenged: 0
		});
		_pull(m.collateral, _msgSender(), amount);
		_mint(_msgSender(), positionId);
		emit PositionOpened(_msgSender(), positionId, marketId);

		if (borrowAmount > 0) _mintDebt(_positions[positionId], m, borrowAmount, to);
		_emitUpdate(_positions[positionId]);
	}

	/// @notice Adds collateral. Open to anyone, it can only make a position safer.
	function deposit(uint256 positionId, uint256 amount) external nonReentrant {
		Position storage p = _position(positionId);
		_pull(_markets[p.marketId].collateral, _msgSender(), amount);
		p.balance += amount;
		_emitUpdate(p);
	}

	/// @notice Removes collateral as far as the position stays covered at its price. Not while challenged or hot.
	function withdraw(uint256 positionId, uint256 amount, address to) external nonReentrant {
		Position storage p = _position(positionId);
		_requireAuthorized(positionId);
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp <= p.cooldown) revert Hot(p.cooldown);

		Market storage m = _markets[p.marketId];
		p.balance -= amount;
		_checkCollateral(p, m);
		IERC20(m.collateral).safeTransfer(to, amount);
		_emitUpdate(p);
	}

	/// @notice Takes on more debt. Not while challenged, hot or matured.
	function mint(uint256 positionId, uint256 amount, address to) external nonReentrant {
		Position storage p = _position(positionId);
		_requireAuthorized(positionId);
		_mintDebt(p, _markets[p.marketId], amount, to);
		_emitUpdate(p);
	}

	/// @notice Repays `amount` of stablecoin, pulled from the caller (anyone may repay). It reduces the debt by
	///         `amount` plus the proportional reserve. Repaying `borrowed - reserve` closes the debt completely.
	///         Possible while challenged, but the collateral stays locked until the challenge is over.
	function repay(uint256 positionId, uint256 amount) external nonReentrant {
		Position storage p = _position(positionId);
		uint256 due = p.borrowed - p.reserve;
		if (amount > due) revert RepaidTooMuch(amount - due);
		if (amount == 0) return;

		uint256 reduction = (amount * p.borrowed) / due;
		uint256 reserveShare = reduction - amount;

		p.borrowed -= reduction;
		p.reserve -= reserveShare;
		_markets[p.marketId].borrowed -= reduction;

		stable.transferFrom(_msgSender(), address(this), amount);
		stable.burnModule(address(this), reduction); // payment plus released reserve
		_emitUpdate(p);
	}

	/// @notice Adjusts the position price, at most up to the market price. Raising it at most doubles it and starts
	///         a cooldown, lowering it requires the position to stay covered. Not while challenged or matured.
	function setPrice(uint256 positionId, uint256 newPrice) external nonReentrant {
		Position storage p = _position(positionId);
		_requireAuthorized(positionId);
		Market storage m = _markets[p.marketId];
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp >= p.maturity) revert Expired();
		if (newPrice == 0 || newPrice > m.price) revert InvalidPrice();

		if (newPrice > p.price) {
			if (newPrice > p.price * MAX_PRICE_INCREASE) revert InvalidPrice();
			_restrict(p, COOLDOWN_PRICE_INCREASE);
			p.price = newPrice;
		} else {
			p.price = newPrice;
			_checkCollateral(p, m);
		}
		_emitUpdate(p);
	}

	/// @notice Lets `operator` act for the position (withdraw, mint, setPrice) like in Morpho. Only the owner (or an
	///         ERC721 approved address) can grant it, and it lapses when the NFT is transferred.
	function setAuthorized(uint256 positionId, address operator, bool allowed) external {
		address owner = ownerOf(positionId);
		if (!_isAuthorized(owner, _msgSender(), positionId)) revert NotAuthorized();
		_authorized[positionId][_epoch[positionId]][operator] = allowed;
		emit Authorized(positionId, operator, allowed);
	}

	// ---------------------------------------------------------------------------------------
	// challenges

	/// @notice Starts a challenge: the caller deposits `size` collateral, which stays locked until the auction has
	///         sold it or the position's collateral. The auction starts at 10x the position price and falls to 0 within
	///         the market's auction duration. At or above the position price `bid` buys the challenger's collateral
	///         (the challenge is averted), below it `bid` buys the position's collateral (the challenge succeeded).
	/// @param minimumPrice protects the challenger against the owner lowering the price in the same block
	function challenge(uint256 positionId, uint256 size, uint256 minimumPrice) external nonReentrant returns (uint256 challengeId) {
		Position storage p = _position(positionId);
		Market storage m = _markets[p.marketId];
		if (p.price < minimumPrice) revert UnexpectedPrice();
		if (block.timestamp >= p.maturity) revert Expired();
		uint256 remaining = p.balance - p.challenged;
		if (size == 0 || (size < m.minBalance && size < remaining)) revert ChallengeTooSmall(); // dust is fine if it is all that is left
		if (size > remaining) revert ChallengeTooLarge();

		_pull(m.collateral, _msgSender(), size);
		p.challenged += size;

		challengeId = challengeCount++;
		_challenges[challengeId] = Challenge(_msgSender(), uint64(block.timestamp), positionId, size);
		emit ChallengeStarted(_msgSender(), positionId, size, challengeId);
	}

	/// @notice Bids on a challenge at the current auction price. At or above the position price it averts the
	///         challenge: the bidder pays the challenger and receives the challenger's collateral. Below the position
	///         price the challenge succeeded: the bidder buys the position's collateral, and the challenger gets their
	///         collateral back plus a reward.
	/// @param size collateral to bid for, reduced to what is left of the challenge
	function bid(uint256 challengeId, uint256 size) external nonReentrant {
		Challenge memory ch = _challenges[challengeId];
		if (ch.challenger == address(0)) revert InvalidChallenge();
		Position storage p = _positions[ch.positionId];
		Market storage m = _markets[p.marketId];
		size = size < ch.collateralSize ? size : ch.collateralSize;
		if (size == 0) revert ChallengeTooSmall();

		uint256 price = _auctionPrice(ch.startTime, m.auction, p.price);
		_shrinkChallenge(challengeId, ch, size);
		p.challenged -= size;

		if (price >= p.price) {
			_avert(challengeId, ch, p, m, size, price);
		} else {
			_succeed(challengeId, ch, p, m, size, price);
		}
	}

	function _avert(uint256 challengeId, Challenge memory ch, Position storage p, Market storage m, uint256 size, uint256 price) internal {
		stable.transferFrom(_msgSender(), ch.challenger, (size * price) / ONE);

		_restrict(p, COOLDOWN_CHALLENGE_AVERTED);
		IERC20(m.collateral).safeTransfer(_msgSender(), size);
		emit ChallengeAverted(ch.positionId, challengeId, size);
	}

	function _succeed(
		uint256 challengeId,
		Challenge memory ch,
		Position storage p,
		Market storage m,
		uint256 size,
		uint256 price
	) internal {
		uint256 offer = (price * size) / ONE;
		_restrict(p, COOLDOWN_CHALLENGE_SUCCEEDED); // time for further challenges before the owner can mint again
		_sell(ch.positionId, p, m, size, offer, ch.challenger, _reward(offer, m), true);

		IERC20(m.collateral).safeTransfer(ch.challenger, size);
		emit ChallengeSucceeded(ch.positionId, challengeId, offer, size);
	}

	/// @notice Buys up to `upTo` collateral of an expired position. The auction starts at maturity at 10x the position
	///         price and falls to 0 within the market's auction duration. At or above the position price the curator
	///         receives the expiry fee out of the proceeds. Below it the proceeds go to the debt first and the owner
	///         forfeits whatever is left: all of it goes to the curator (covering the market's bad debt first).
	function buyExpired(uint256 positionId, uint256 upTo) external nonReentrant returns (uint256 amount) {
		Position storage p = _position(positionId);
		Market storage m = _markets[p.marketId];
		if (block.timestamp < p.maturity) revert NotExpired();
		if (p.challenged > 0) revert Challenged(); // otherwise the owner could front-run challenges with a sale

		uint256 price = _auctionPrice(p.maturity, m.auction, p.price);
		amount = upTo < p.balance ? upTo : p.balance;
		if (amount == 0) return 0;

		uint256 offer = (price * amount) / ONE;
		bool below = price < p.price;
		_sell(positionId, p, m, amount, offer, stable.curator(), below ? 0 : _reward(offer, m), below);
		emit ExpiredBought(positionId, amount, price);
	}

	/// @notice Burns the caller's stablecoin against the market's bad debt and frees the capacity again.
	function coverBadDebt(uint256 marketId, uint256 amount) external nonReentrant {
		Market storage m = _markets[marketId];
		if (amount > m.badDebt) amount = m.badDebt;
		m.badDebt -= amount;
		m.borrowed -= amount;
		stable.transferFrom(_msgSender(), address(this), amount);
		stable.burnModule(address(this), amount);
		emit BadDebt(marketId, 0, m.badDebt);
	}

	// ---------------------------------------------------------------------------------------
	// views

	function getMarket(uint256 marketId) external view returns (Market memory) {
		return _markets[marketId];
	}

	function getChallenge(uint256 challengeId) external view returns (Challenge memory) {
		return _challenges[challengeId];
	}

	function getPendingMarket(uint256 marketId) external view returns (PendingMarket memory) {
		return _pendingMarkets[marketId];
	}

	function getPosition(uint256 positionId) external view returns (Position memory) {
		return _positions[positionId];
	}

	function isAuthorized(uint256 positionId, address operator) public view returns (bool) {
		address owner = ownerOf(positionId);
		return operator == owner || _isAuthorized(owner, operator, positionId) || _authorized[positionId][_epoch[positionId]][operator];
	}

	/// @notice Upfront interest (1e18 scaled share of the borrowed amount) when minting now with `maturity`.
	function feeRate(uint256 marketId, uint64 maturity) public view returns (uint256) {
		if (maturity <= block.timestamp) return 0;
		return (_markets[marketId].rate * (maturity - block.timestamp)) / 365 days;
	}

	/// @notice Current price per collateral unit for a challenge, (36 - decimals) decimals. 0 if it is gone.
	function auctionPrice(uint256 challengeId) external view returns (uint256) {
		Challenge memory ch = _challenges[challengeId];
		if (ch.challenger == address(0)) return 0;
		Position storage p = _positions[ch.positionId];
		return _auctionPrice(ch.startTime, _markets[p.marketId].auction, p.price);
	}

	/// @notice Current price per collateral unit for an expired position, (36 - decimals) decimals.
	function expiredPrice(uint256 positionId) external view returns (uint256) {
		Position storage p = _position(positionId);
		return _auctionPrice(p.maturity, _markets[p.marketId].auction, p.price);
	}

	// ---------------------------------------------------------------------------------------
	// internals

	function _position(uint256 positionId) internal view returns (Position storage p) {
		p = _positions[positionId];
		if (p.positionId == 0) revert InvalidPosition();
	}

	function _requireAuthorized(uint256 positionId) internal view {
		if (!isAuthorized(positionId, _msgSender())) revert NotAuthorized();
	}

	function _restrict(Position storage p, uint64 period) internal {
		uint64 horizon = uint64(block.timestamp) + period;
		if (horizon > p.cooldown) p.cooldown = horizon;
	}

	function _emitUpdate(Position storage p) internal {
		emit PositionUpdate(p.positionId, p.balance, p.price, p.borrowed);
	}

	/// @dev The position must always stay covered: balance * price >= borrowed. Below minBalance, nothing counts.
	function _checkCollateral(Position storage p, Market storage m) internal view {
		uint256 relevant = p.balance < m.minBalance ? 0 : p.balance;
		uint256 value = relevant * p.price;
		if (value < p.borrowed * ONE) revert InsufficientCollateral(value, p.borrowed * ONE);
	}

	/// @dev Pulls exactly `amount`, rejecting fee-on-transfer and other non-standard tokens.
	function _pull(address token, address from, uint256 amount) internal {
		uint256 before = IERC20(token).balanceOf(address(this));
		IERC20(token).safeTransferFrom(from, address(this), amount);
		if (IERC20(token).balanceOf(address(this)) - before != amount) revert IncompatibleCollateral();
	}

	function _mintDebt(Position storage p, Market storage m, uint256 amount, address to) internal {
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp <= p.cooldown) revert Hot(p.cooldown);
		if (block.timestamp >= p.maturity) revert Expired();
		if (amount > m.limit - m.borrowed) revert LimitExceeded(amount, m.limit - m.borrowed);

		uint256 fee = feeRate(p.marketId, p.maturity);
		if (m.reserve + fee >= ONE) revert FeeTooHigh();

		uint256 reserve = (amount * m.reserve + ONE - 1) / ONE; // rounded up in favor of the reserve
		uint256 feeAmount = (amount * fee) / ONE;

		m.borrowed += amount;
		p.borrowed += amount;
		p.reserve += reserve;
		_checkCollateral(p, m);

		stable.mintModule(address(this), reserve);
		if (feeAmount > 0) stable.mintModule(stable.curator(), feeAmount);
		stable.mintModule(to, amount - reserve - feeAmount);
	}

	/// @dev Takes `size` collateral from the position, repays the proportional debt out of `funds` (stablecoin
	///      already held by this contract) and its reserve, and distributes what is left. Any shortfall is written
	///      off as bad debt. Used for both succeeded challenges and expired positions below the position price. With
	///      `forfeit` the owner gets nothing of the excess, all of it goes to the curator (after the bad debt of the
	///      market is covered). Without it the reserve ratio of the excess goes to the curator and the rest to the owner.
	function _settle(uint256 positionId, Position storage p, Market storage m, uint256 size, uint256 funds, bool forfeit) internal {
		uint256 debt = (p.borrowed * size) / p.balance;
		uint256 reserve = p.borrowed == 0 ? 0 : (p.reserve * debt) / p.borrowed;
		uint256 due = debt - reserve; // what the proceeds have to cover, the reserve covers the rest

		p.balance -= size;
		p.borrowed -= debt;
		p.reserve -= reserve;

		uint256 shortfall = funds >= due ? 0 : due - funds;
		uint256 excess = funds - (due - shortfall);

		stable.burnModule(address(this), funds - excess + reserve);
		m.borrowed -= debt - shortfall;

		if (shortfall > 0) {
			m.badDebt += shortfall;
			emit BadDebt(p.marketId, shortfall, m.badDebt);
		}

		if (excess > 0) {
			// like Frankencoin: the reserve ratio of the excess is kept as profit, unless nothing was owed
			uint256 profit = debt == 0 ? 0 : forfeit ? excess : (excess * m.reserve) / ONE;
			_payCurator(p.marketId, m, profit);
			_pay(ownerOf(positionId), excess - profit);
		}
		_emitUpdate(p);
	}

	/// @dev The caller pays `offer` for `size` collateral of the position. `fee` is paid to `feeTo` out of the offer
	///      first, the rest settles the debt.
	function _sell(
		uint256 positionId,
		Position storage p,
		Market storage m,
		uint256 size,
		uint256 offer,
		address feeTo,
		uint256 fee,
		bool forfeit
	) internal {
		stable.transferFrom(_msgSender(), address(this), offer);
		if (feeTo == stable.curator()) _payCurator(p.marketId, m, fee);
		else _pay(feeTo, fee);
		_settle(positionId, p, m, size, offer - fee, forfeit);
		IERC20(m.collateral).safeTransfer(_msgSender(), size);
	}

	/// @dev Challenger reward / expiry fee: a share of the reserve ratio, relative to the offer.
	function _reward(uint256 offer, Market storage m) internal view returns (uint256) {
		return Math.mulDiv(offer, m.reserve * AUCTION_REWARD_SHARE, ONE * ONE);
	}

	/// @dev Whatever the curator would receive from an auction first covers the bad debt of the market (which frees its
	///      capacity again), only the rest is paid out.
	function _payCurator(uint256 marketId, Market storage m, uint256 amount) internal {
		uint256 cover = amount < m.badDebt ? amount : m.badDebt;
		if (cover > 0) {
			m.badDebt -= cover;
			m.borrowed -= cover;
			stable.burnModule(address(this), cover);
			emit BadDebt(marketId, 0, m.badDebt);
		}
		_pay(stable.curator(), amount - cover);
	}

	function _pay(address to, uint256 amount) internal {
		if (amount > 0) stable.transfer(to, amount);
	}

	function _shrinkChallenge(uint256 challengeId, Challenge memory ch, uint256 size) internal {
		if (size == ch.collateralSize) delete _challenges[challengeId];
		else _challenges[challengeId].collateralSize = ch.collateralSize - size;
	}

	/// @dev Quadratic ease-out: 10x the position price at `start`, falling fast at first and ever slower, reaching the
	///      position price after ~68% of the duration and 0 at the end: price * 10 * (1 - elapsed / duration)^2.
	function _auctionPrice(uint256 start, uint64 duration, uint256 price) internal view returns (uint256) {
		uint256 startPrice = AUCTION_PRICE_FACTOR * price;
		if (block.timestamp <= start) return startPrice;
		uint256 elapsed = block.timestamp - start;
		if (elapsed >= duration) return 0;
		uint256 remaining = duration - elapsed;
		return Math.mulDiv(Math.mulDiv(startPrice, remaining, duration), remaining, duration);
	}

	/// @dev Operator approvals lapse with every ownership change.
	function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
		from = super._update(to, tokenId, auth);
		if (from != address(0) && from != to) _epoch[tokenId]++;
	}
}
