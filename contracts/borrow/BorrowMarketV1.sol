// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {ERC721} from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IStablecoinModifier, IStablecoinMetadata} from '../stablecoin/IStablecoinModifier.sol';
import {ErrorsLib} from '../stablecoin/libraries/ErrorsLib.sol';

import {IBorrowMarketV1} from './IBorrowMarketV1.sol';

/// @title BorrowMarketV1
/// @author @samclassix <samclassix@proton.me>
/// @notice Single-contract, oracle-free borrow market. Positions are NFTs, collateral families are whitelisted by
///         the curator behind the stablecoin timelock, and positions are kept honest by Dutch-auction challenges
///         instead of a price oracle.
/// @dev Must be registered as a module on the stablecoin (mintModule/burnModule).
/// @dev Accounting model: `minted` is the gross debt of a position. On mint, `reserve` of it is minted to this
///      contract and locked, `fee` (upfront interest until maturity) is minted to the curator, and the rest goes to
///      the borrower. Repaying `amount` burns `amount` from the payer plus the proportional reserve, so the supply
///      attributable to a position always equals its `minted`. All collateral is accounted per position (never via
///      balanceOf), so donations cannot distort anything.
contract BorrowMarketV1 is ERC721, ReentrancyGuard, IStablecoinModifier, IBorrowMarketV1 {
	using SafeERC20 for IERC20;

	uint256 internal constant ONE = 1e18;

	/// @notice Reserve bounds per family. The upper bound stays below 100% since repayment divides by (1 - reserve).
	uint256 public constant MIN_RESERVE = 0.1e18;
	uint256 public constant MAX_RESERVE = 0.9e18;

	/// @notice Bounds of one challenge phase.
	uint64 public constant MIN_CHALLENGE = 1 days;
	uint64 public constant MAX_CHALLENGE = 30 days;

	/// @notice Challenger reward, relative to the winning bid.
	uint256 public constant CHALLENGER_REWARD = 0.02e18;

	/// @notice A position price can be raised by at most this factor per step.
	uint256 public constant MAX_PRICE_INCREASE = 2;

	/// @notice Cooldowns, during which minting, withdrawing and price increases are suspended.
	uint64 public constant COOLDOWN_PRICE_INCREASE = 5 days;
	uint64 public constant COOLDOWN_CHALLENGE_AVERTED = 1 days;
	uint64 public constant COOLDOWN_CHALLENGE_SUCCEEDED = 3 days;

	/// @notice Start multiple of the forced sale price for matured positions.
	uint256 public constant EXPIRED_PRICE_FACTOR = 10;

	// ---------------------------------------------------------------------------------------

	uint256 public collateralCount;
	uint256 public positionCount;

	mapping(uint256 id => Collateral) internal _collaterals;
	mapping(uint256 id => PendingCollateral) internal _pendingCollaterals;
	mapping(uint256 id => Position) internal _positions;

	/// @notice Unbacked stablecoin left behind by liquidations that did not cover the debt, per family.
	mapping(uint256 proposal => uint256) public badDebt;

	/// @dev Operator approvals are scoped to the current owner: the epoch is bumped on every transfer.
	mapping(uint256 id => uint256) internal _epoch;
	mapping(uint256 id => mapping(uint256 epoch => mapping(address operator => bool))) internal _authorized;

	uint256 public challengeCount;
	mapping(uint256 number => Challenge) public challenges;

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
	// collateral families

	/// @notice Curator proposes a new family. Becomes acceptable after stable.timelock(). Never overrides, every
	///         proposal gets its own id.
	function proposeCollateral(CollateralParams calldata p) external onlyCurator returns (uint256 id) {
		if (p.collateral == address(0) || p.collateral == address(stable)) revert InvalidCollateral();
		if (IERC20Metadata(p.collateral).decimals() > 24) revert InvalidCollateral(); // leaves 12 digits for price
		if (p.maturity <= block.timestamp) revert InvalidMaturity();
		if (p.challenge < MIN_CHALLENGE || p.challenge > MAX_CHALLENGE) revert InvalidCollateral();
		if (p.reserve < MIN_RESERVE || p.reserve > MAX_RESERVE) revert InvalidCollateral();
		if (p.minBalance == 0 || p.price == 0 || p.limit == 0 || p.rate > ONE) revert InvalidCollateral();
		if (p.minBalance * p.price > p.limit * ONE) revert InvalidCollateral(); // a min position must fit the limit

		id = ++collateralCount;
		PendingCollateral storage pending = _pendingCollaterals[id];
		pending.value = Collateral({
			id: id,
			collateral: p.collateral,
			maturity: p.maturity,
			challenge: p.challenge,
			minBalance: p.minBalance,
			price: p.price,
			reserve: p.reserve,
			limit: p.limit,
			available: p.limit,
			rate: p.rate
		});
		pending.validAt = uint64(block.timestamp + stable.timelock());

		emit CollateralProposed(_msgSender(), id, p.collateral, pending.validAt);
	}

	/// @notice Cancels a pending proposal.
	function revokeCollateral(uint256 id) external onlyCuratorOrGuardian {
		if (_pendingCollaterals[id].validAt == 0) revert ErrorsLib.NoPendingValue();
		delete _pendingCollaterals[id];
		emit CollateralRevoked(_msgSender(), id);
	}

	/// @notice Permissionless after the timelock. Positions can be opened afterwards.
	function acceptCollateral(uint256 id) external afterTimelock(_pendingCollaterals[id].validAt) {
		Collateral memory c = _pendingCollaterals[id].value;
		if (c.maturity <= block.timestamp) revert InvalidMaturity();

		_collaterals[id] = c;
		delete _pendingCollaterals[id];
		emit CollateralAccepted(id);
	}

	// ---------------------------------------------------------------------------------------
	// positions

	/// @notice Opens a position, owned by the caller, and optionally mints right away. The mint is guarded by the
	///         family price, like any later mint.
	/// @param proposal family id
	/// @param amount initial collateral, must be at least the family's minBalance
	/// @param maturity chosen maturity, at most the family maturity
	/// @param mintAmount gross debt to take on, can be 0
	/// @param to receiver of the borrowed stablecoin
	function open(
		uint256 proposal,
		uint256 amount,
		uint64 maturity,
		uint256 mintAmount,
		address to
	) external nonReentrant returns (uint256 id) {
		Collateral storage c = _collaterals[proposal];
		if (c.id == 0) revert InvalidCollateral();
		if (maturity <= block.timestamp || maturity > c.maturity) revert InvalidMaturity();
		if (amount < c.minBalance) revert InsufficientCollateral(amount, c.minBalance);

		id = ++positionCount;
		_positions[id] = Position({
			id: id,
			proposal: proposal,
			maturity: maturity,
			cooldown: 0,
			balance: amount,
			minted: 0,
			reserve: 0,
			price: c.price,
			challenged: 0
		});
		_mint(_msgSender(), id);
		_pull(c.collateral, _msgSender(), amount);
		emit PositionOpened(_msgSender(), id, proposal);

		if (mintAmount > 0) _mintDebt(_positions[id], c, mintAmount, to);
		_emitUpdate(_positions[id]);
	}

	/// @notice Adds collateral. Open to anyone, it can only make a position safer.
	function deposit(uint256 id, uint256 amount) external nonReentrant {
		Position storage p = _position(id);
		_pull(_collaterals[p.proposal].collateral, _msgSender(), amount);
		p.balance += amount;
		_emitUpdate(p);
	}

	/// @notice Removes collateral as far as the position stays covered at its price. Not while challenged or hot.
	function withdraw(uint256 id, uint256 amount, address to) external nonReentrant {
		Position storage p = _position(id);
		_requireAuthorized(id);
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp <= p.cooldown) revert Hot(p.cooldown);

		Collateral storage c = _collaterals[p.proposal];
		p.balance -= amount;
		_checkCollateral(p, c);
		IERC20(c.collateral).safeTransfer(to, amount);
		_emitUpdate(p);
	}

	/// @notice Takes on more debt. Not while challenged, hot or matured.
	function mint(uint256 id, uint256 amount, address to) external nonReentrant {
		Position storage p = _position(id);
		_requireAuthorized(id);
		_mintDebt(p, _collaterals[p.proposal], amount, to);
		_emitUpdate(p);
	}

	/// @notice Repays `amount` of stablecoin, pulled from the caller (anyone may repay). It reduces the debt by
	///         `amount` plus the proportional reserve. Repaying `minted - reserve` closes the debt completely.
	///         Possible while challenged, but the collateral stays locked until the challenge is over.
	function repay(uint256 id, uint256 amount) external nonReentrant {
		Position storage p = _position(id);
		uint256 due = p.minted - p.reserve;
		if (amount > due) revert RepaidTooMuch(amount - due);
		if (amount == 0) return;

		uint256 reduction = (amount * p.minted) / due;
		uint256 reserveShare = reduction - amount;

		p.minted -= reduction;
		p.reserve -= reserveShare;
		_collaterals[p.proposal].available += reduction;

		stable.transferFrom(_msgSender(), address(this), amount);
		stable.burnModule(address(this), reduction); // payment plus released reserve
		_emitUpdate(p);
	}

	/// @notice Adjusts the position price, at most up to the family price. Raising it at most doubles it and starts
	///         a cooldown, lowering it requires the position to stay covered. Not while challenged or matured.
	function setPrice(uint256 id, uint256 newPrice) external nonReentrant {
		Position storage p = _position(id);
		_requireAuthorized(id);
		Collateral storage c = _collaterals[p.proposal];
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp >= p.maturity) revert Expired();
		if (newPrice == 0 || newPrice > c.price) revert InvalidPrice();

		if (newPrice > p.price) {
			if (newPrice > p.price * MAX_PRICE_INCREASE) revert InvalidPrice();
			_restrict(p, COOLDOWN_PRICE_INCREASE);
			p.price = newPrice;
		} else {
			p.price = newPrice;
			_checkCollateral(p, c);
		}
		_emitUpdate(p);
	}

	/// @notice Lets `operator` act for the position (withdraw, mint, setPrice) like in Morpho. Only the owner (or an
	///         ERC721 approved address) can grant it, and it lapses when the NFT is transferred.
	function setAuthorized(uint256 id, address operator, bool allowed) external {
		address owner = ownerOf(id);
		if (!_isAuthorized(owner, _msgSender(), id)) revert NotAuthorized();
		_authorized[id][_epoch[id]][operator] = allowed;
		emit Authorized(id, operator, allowed);
	}

	// ---------------------------------------------------------------------------------------
	// challenges

	/// @notice Starts a challenge: the caller deposits `size` collateral to put up for auction against the position's
	///         collateral. For the first phase anyone can avert it by buying the challenger's collateral at the
	///         position price, in the second phase the price falls to 0 and the position's collateral is sold.
	/// @param minimumPrice protects the challenger against the owner lowering the price in the same block
	function challenge(uint256 id, uint256 size, uint256 minimumPrice) external nonReentrant returns (uint256 number) {
		Position storage p = _position(id);
		Collateral storage c = _collaterals[p.proposal];
		if (p.price < minimumPrice) revert UnexpectedPrice();
		if (block.timestamp >= p.maturity) revert Expired();
		if (size == 0 || (size < c.minBalance && size < p.balance)) revert ChallengeTooSmall();
		if (size > p.balance - p.challenged) revert ChallengeTooLarge();

		_pull(c.collateral, _msgSender(), size);
		p.challenged += size;

		number = challengeCount++;
		challenges[number] = Challenge(_msgSender(), uint64(block.timestamp), id, size);
		emit ChallengeStarted(_msgSender(), id, size, number);
	}

	/// @notice Bids on a challenge. In the first phase it averts the challenge (pays the challenger the position
	///         price, gets the challenger's collateral), afterwards it buys the position's collateral at the falling
	///         auction price and the challenger gets their collateral back plus a reward.
	/// @param size collateral to bid for, reduced to what is left of the challenge
	function bid(uint256 number, uint256 size) external nonReentrant {
		Challenge memory ch = challenges[number];
		if (ch.challenger == address(0)) revert InvalidPosition();
		Position storage p = _positions[ch.position];
		Collateral storage c = _collaterals[p.proposal];
		size = size < ch.size ? size : ch.size;
		if (size == 0) revert ChallengeTooSmall();

		_shrinkChallenge(number, ch, size);
		p.challenged -= size;

		if (block.timestamp <= ch.start + c.challenge) {
			_avert(number, ch, p, c, size);
		} else {
			_succeed(number, ch, p, c, size);
		}
	}

	function _avert(uint256 number, Challenge memory ch, Position storage p, Collateral storage c, uint256 size) internal {
		if (block.timestamp == ch.start) revert SameBlock(); // no atomic challenge and avert
		if (_msgSender() != ch.challenger) {
			stable.transferFrom(_msgSender(), ch.challenger, (size * p.price) / ONE);
		} // the challenger can cancel for free

		_restrict(p, COOLDOWN_CHALLENGE_AVERTED);
		IERC20(c.collateral).safeTransfer(_msgSender(), size);
		emit ChallengeAverted(ch.position, number, size);
	}

	function _succeed(uint256 number, Challenge memory ch, Position storage p, Collateral storage c, uint256 size) internal {
		uint256 offer = (_auctionPrice(ch.start + c.challenge, c.challenge, p.price) * size) / ONE;
		stable.transferFrom(_msgSender(), address(this), offer);

		uint256 reward = (offer * CHALLENGER_REWARD) / ONE;
		_pay(ch.challenger, reward);

		_restrict(p, COOLDOWN_CHALLENGE_SUCCEEDED); // time for further challenges before the owner can mint again
		_settle(ch.position, p, c, size, offer - reward);

		IERC20(c.collateral).safeTransfer(ch.challenger, size);
		IERC20(c.collateral).safeTransfer(_msgSender(), size);
		emit ChallengeSucceeded(ch.position, number, offer, size);
	}

	/// @notice Buys up to `upTo` collateral of a matured position at the forced sale price, which starts at 10x the
	///         position price at maturity and falls to 0 within two challenge phases.
	function buyExpired(uint256 id, uint256 upTo) external nonReentrant returns (uint256 amount) {
		Position storage p = _position(id);
		Collateral storage c = _collaterals[p.proposal];
		if (block.timestamp < p.maturity) revert NotExpired();
		if (p.challenged > 0) revert Challenged(); // otherwise the owner could front-run challenges with a sale

		uint256 price = _expiredPrice(p, c);
		amount = upTo < p.balance ? upTo : p.balance;
		if (amount == 0) return 0;

		uint256 cost = (price * amount) / ONE;
		stable.transferFrom(_msgSender(), address(this), cost);
		_settle(id, p, c, amount, cost);
		IERC20(c.collateral).safeTransfer(_msgSender(), amount);
		emit ForcedSale(id, amount, price);
	}

	/// @notice Burns the caller's stablecoin against the family's bad debt and frees the capacity again.
	function coverBadDebt(uint256 proposal, uint256 amount) external nonReentrant {
		if (amount > badDebt[proposal]) amount = badDebt[proposal];
		badDebt[proposal] -= amount;
		_collaterals[proposal].available += amount;
		stable.transferFrom(_msgSender(), address(this), amount);
		stable.burnModule(address(this), amount);
		emit BadDebt(proposal, 0, badDebt[proposal]);
	}

	// ---------------------------------------------------------------------------------------
	// views

	function getCollateral(uint256 id) external view returns (Collateral memory) {
		return _collaterals[id];
	}

	function getPendingCollateral(uint256 id) external view returns (PendingCollateral memory) {
		return _pendingCollaterals[id];
	}

	function getPosition(uint256 id) external view returns (Position memory) {
		return _positions[id];
	}

	function isAuthorized(uint256 id, address operator) public view returns (bool) {
		address owner = ownerOf(id);
		return operator == owner || _isAuthorized(owner, operator, id) || _authorized[id][_epoch[id]][operator];
	}

	/// @notice Upfront interest (1e18 scaled share of the minted amount) when minting now with `maturity`.
	function feeRate(uint256 proposal, uint64 maturity) public view returns (uint256) {
		if (maturity <= block.timestamp) return 0;
		return (_collaterals[proposal].rate * (maturity - block.timestamp)) / 365 days;
	}

	/// @notice Current price per collateral unit for a challenge, (36 - decimals) decimals. 0 if it is gone.
	function auctionPrice(uint256 number) external view returns (uint256) {
		Challenge memory ch = challenges[number];
		if (ch.challenger == address(0)) return 0;
		Position storage p = _positions[ch.position];
		uint64 phase = _collaterals[p.proposal].challenge;
		return _auctionPrice(ch.start + phase, phase, p.price);
	}

	function expiredPrice(uint256 id) external view returns (uint256) {
		Position storage p = _position(id);
		return _expiredPrice(p, _collaterals[p.proposal]);
	}

	// ---------------------------------------------------------------------------------------
	// internals

	function _position(uint256 id) internal view returns (Position storage p) {
		p = _positions[id];
		if (p.id == 0) revert InvalidPosition();
	}

	function _requireAuthorized(uint256 id) internal view {
		if (!isAuthorized(id, _msgSender())) revert NotAuthorized();
	}

	function _restrict(Position storage p, uint64 period) internal {
		uint64 horizon = uint64(block.timestamp) + period;
		if (horizon > p.cooldown) p.cooldown = horizon;
	}

	function _emitUpdate(Position storage p) internal {
		emit PositionUpdate(p.id, p.balance, p.price, p.minted);
	}

	/// @dev The position must always stay covered: balance * price >= minted. Below minBalance, nothing counts.
	function _checkCollateral(Position storage p, Collateral storage c) internal view {
		uint256 relevant = p.balance < c.minBalance ? 0 : p.balance;
		uint256 value = relevant * p.price;
		if (value < p.minted * ONE) revert InsufficientCollateral(value, p.minted * ONE);
	}

	/// @dev Pulls exactly `amount`, rejecting fee-on-transfer and other non-standard tokens.
	function _pull(address token, address from, uint256 amount) internal {
		uint256 before = IERC20(token).balanceOf(address(this));
		IERC20(token).safeTransferFrom(from, address(this), amount);
		if (IERC20(token).balanceOf(address(this)) - before != amount) revert IncompatibleCollateral();
	}

	function _mintDebt(Position storage p, Collateral storage c, uint256 amount, address to) internal {
		if (p.challenged > 0) revert Challenged();
		if (block.timestamp <= p.cooldown) revert Hot(p.cooldown);
		if (block.timestamp >= p.maturity) revert Expired();
		if (amount > c.available) revert LimitExceeded(amount, c.available);

		uint256 fee = feeRate(p.proposal, p.maturity);
		if (c.reserve + fee >= ONE) revert FeeTooHigh();

		uint256 reserve = (amount * c.reserve + ONE - 1) / ONE; // rounded up in favor of the reserve
		uint256 feeAmount = (amount * fee) / ONE;

		c.available -= amount;
		p.minted += amount;
		p.reserve += reserve;
		_checkCollateral(p, c);

		stable.mintModule(address(this), reserve);
		if (feeAmount > 0) stable.mintModule(stable.curator(), feeAmount);
		stable.mintModule(to, amount - reserve - feeAmount);
	}

	/// @dev Takes `size` collateral from the position, repays the proportional debt out of `funds` (stablecoin
	///      already held by this contract) and its reserve, and distributes what is left. Any shortfall is written
	///      off as bad debt. Used for both successful challenges and forced sales of matured positions.
	function _settle(uint256 id, Position storage p, Collateral storage c, uint256 size, uint256 funds) internal {
		uint256 debt = (p.minted * size) / p.balance;
		uint256 reserve = p.minted == 0 ? 0 : (p.reserve * debt) / p.minted;
		uint256 due = debt - reserve; // what the proceeds have to cover, the reserve covers the rest

		p.balance -= size;
		p.minted -= debt;
		p.reserve -= reserve;

		uint256 shortfall = funds >= due ? 0 : due - funds;
		uint256 excess = funds - (due - shortfall);

		stable.burnModule(address(this), funds - excess + reserve);
		c.available += debt - shortfall;

		if (shortfall > 0) {
			badDebt[p.proposal] += shortfall;
			emit BadDebt(p.proposal, shortfall, badDebt[p.proposal]);
		}

		if (excess > 0) {
			// like Frankencoin: the reserve ratio of the excess is kept as profit, unless nothing was owed
			uint256 profit = debt == 0 ? 0 : (excess * c.reserve) / ONE;
			_pay(stable.curator(), profit);
			_pay(ownerOf(id), excess - profit);
		}
		_emitUpdate(p);
	}

	/// @dev Stablecoin payout that can never block a liquidation, e.g. by a frozen recipient: falls back to the curator.
	function _pay(address to, uint256 amount) internal {
		if (amount == 0) return;
		try stable.transfer(to, amount) returns (bool ok) {
			if (ok) return;
		} catch {}
		stable.transfer(stable.curator(), amount);
	}

	function _shrinkChallenge(uint256 number, Challenge memory ch, uint256 size) internal {
		if (size == ch.size) delete challenges[number];
		else challenges[number].size = ch.size - size;
	}

	/// @dev Linear fall from `price` at `start` to 0 after `phase`. The auction starts after the first phase.
	function _auctionPrice(uint256 start, uint256 phase, uint256 price) internal view returns (uint256) {
		if (block.timestamp <= start) return price;
		if (block.timestamp >= start + phase) return 0;
		return (price / phase) * (phase - (block.timestamp - start));
	}

	/// @dev 10x position price until maturity, falling to 1x within one challenge phase after maturity and to 0
	///      within another.
	function _expiredPrice(Position storage p, Collateral storage c) internal view returns (uint256) {
		uint256 price = p.price;
		if (block.timestamp <= p.maturity) return EXPIRED_PRICE_FACTOR * price;

		uint256 phase = c.challenge;
		uint256 passed = block.timestamp - p.maturity;
		if (passed <= phase) {
			return price + (((EXPIRED_PRICE_FACTOR - 1) * price) / phase) * (phase - passed);
		} else if (passed < 2 * phase) {
			return (price / phase) * (2 * phase - passed);
		}
		return 0;
	}

	/// @dev Operator approvals lapse with every ownership change.
	function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
		from = super._update(to, tokenId, auth);
		if (from != address(0) && from != to) _epoch[tokenId]++;
	}
}
