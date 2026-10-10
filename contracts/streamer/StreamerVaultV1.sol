// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC4626, ERC20, IERC20} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';

/**
 * @title StreamerVaultV1
 * @notice Minimal ERC-4626 "streamer" vault. Stakers deposit the asset (e.g. USDU) and receive shares.
 *         Anyone can fund the vault by simply transferring asset to it; it is not credited instantly but
 *         picked up by `sync()` and streamed linearly to the stakers: the share price rises smoothly over time.
 *
 * @dev No fees, no owner, no admin. Accounting is fully internal (`totalDeposits`, `totalWithdrawn`,
 *      `totalFunded`), and tokens sent directly to the vault only enter `totalAssets` through the stream
 *      (never instantly), so they cannot be used to manipulate the share price (inflation / donation attacks).
 *
 *      totalAssets = totalDeposits - totalWithdrawn + totalFunded - locked()
 *
 *      Syncing while a stream is running merges the still-locked amount with the new amount. The new
 *      end time is the amount-weighted average of the old remaining time and `duration`, so a dust
 *      top-up can never meaningfully prolong or reset a running stream.
 */
contract StreamerVaultV1 is ERC4626 {
	using Math for uint256;

	/// @notice Time over which a freshly funded amount is streamed
	uint256 public immutable duration;

	uint256 public totalDeposits;
	uint256 public totalWithdrawn;
	uint256 public totalFunded;

	/// @dev Locked (not yet streamed) amount as of `lastUpdate`
	uint256 private lockedAtUpdate;
	uint64 public lastUpdate;
	uint64 public streamEnd;

	// ---------------------------------------------------------------------------------------

	event Synced(uint256 amount, uint256 locked, uint64 streamEnd);

	error ZeroDuration();

	// ---------------------------------------------------------------------------------------

	constructor(
		IERC20 _asset,
		uint256 _duration,
		string memory _name,
		string memory _symbol
	) ERC4626(_asset) ERC20(_name, _symbol) {
		if (_duration == 0) revert ZeroDuration();
		duration = _duration;
	}

	// ---------------------------------------------------------------------------------------
	// Streaming

	/// @notice Tokens held by the vault beyond what is accounted for, waiting to be streamed
	function pending() public view returns (uint256) {
		uint256 accounted = totalDeposits + totalFunded - totalWithdrawn;
		uint256 balance = IERC20(asset()).balanceOf(address(this));
		return balance > accounted ? balance - accounted : 0;
	}

	/// @notice Picks up any asset sent directly to the vault and adds it to the stream. Permissionless.
	/// @dev Runs automatically on deposit and withdraw. Pending tokens are not part of `totalAssets` until
	///      synced, so syncing never changes the share price at that instant, it only starts the stream.
	///      Without stakers nothing is synced: nobody would be entitled to the stream.
	function sync() public {
		uint256 amount = pending();
		if (amount == 0 || totalSupply() == 0) return;

		uint256 remaining = locked();
		uint256 remainingTime = block.timestamp < streamEnd ? streamEnd - block.timestamp : 0;
		uint256 newLocked = remaining + amount;

		// amount-weighted average of old remaining time and the full duration, rounded up
		uint256 newTime = (remaining * remainingTime + amount * duration).ceilDiv(newLocked);

		lockedAtUpdate = newLocked;
		lastUpdate = uint64(block.timestamp);
		streamEnd = uint64(block.timestamp + newTime);
		totalFunded += amount;

		emit Synced(amount, newLocked, streamEnd);
	}

	/// @notice Amount funded but not yet streamed to stakers
	function locked() public view returns (uint256) {
		if (block.timestamp >= streamEnd) return 0;
		return lockedAtUpdate.mulDiv(streamEnd - block.timestamp, streamEnd - lastUpdate);
	}

	/// @notice Current stream rate in asset per second (0 if no stream is running)
	function rate() external view returns (uint256) {
		if (block.timestamp >= streamEnd) return 0;
		return lockedAtUpdate / (streamEnd - lastUpdate);
	}

	/// @notice Price of one full share (1e18 shares) in asset
	function price() external view returns (uint256) {
		return convertToAssets(1 ether);
	}

	// ---------------------------------------------------------------------------------------
	// ERC4626

	function totalAssets() public view override returns (uint256) {
		return totalDeposits + totalFunded - totalWithdrawn - locked();
	}

	function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
		sync();
		// transfer before mint, see OZ ERC4626
		SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), assets);
		totalDeposits += assets;
		_mint(receiver, shares);
		emit Deposit(caller, receiver, assets, shares);
	}

	function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares) internal override {
		sync();
		if (caller != owner) _spendAllowance(owner, caller, shares);
		_burn(owner, shares);
		totalWithdrawn += assets;
		SafeERC20.safeTransfer(IERC20(asset()), receiver, assets);
		emit Withdraw(caller, receiver, owner, assets, shares);
	}
}
