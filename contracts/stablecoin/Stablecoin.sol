// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ERC20Permit} from '@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol';
import {ERC1363} from '@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol';

import {ConstantsLib} from './libraries/ConstantsLib.sol';
import {ErrorsLib} from './libraries/ErrorsLib.sol';
import {EventsLib} from './libraries/EventsLib.sol';
import {PendingLib, PendingUint192, PendingAddress} from './libraries/PendingLib.sol';

import {IStablecoin, IERC20} from './IStablecoin.sol';

/// @title Stablecoin
/// @author @samclassix <samclassix@proton.me>
/// @notice A stablecoin implementation built on top of Morpho, utilizing a role-based access control system
/// with curator and guardian roles for secure management and governance.
contract Stablecoin is IStablecoin, ERC20, ERC20Permit, ERC1363 {
	using Math for uint256;
	using SafeERC20 for ERC20;
	using PendingLib for PendingUint192;
	using PendingLib for PendingAddress;

	address public curator;
	PendingAddress public pendingCurator;

	address public guardian;
	PendingAddress public pendingGuardian;

	uint256 public timelock;
	PendingUint192 public pendingTimelock;

	mapping(address module => uint256) public modules;
	mapping(address module => PendingUint192) public pendingModules;

	mapping(address account => uint256) public unfreeze;
	mapping(address account => PendingUint192) public pendingUnfreeze;

	// ---------------------------------------------------------------------------------------

	modifier onlyCurator() {
		verifyCurator(_msgSender());
		_;
	}

	modifier onlyGuardian() {
		verifyGuardian(_msgSender());
		_;
	}

	modifier onlyCuratorOrGuardian() {
		verifyCuratorOrGuardian(_msgSender());
		_;
	}

	modifier onlyModule() {
		verifyModule(_msgSender());
		_;
	}

	modifier validModule() {
		verifyValidModule(_msgSender());
		_;
	}

	modifier afterTimelock(uint256 validAt) {
		if (validAt == 0) revert ErrorsLib.NoPendingValue();
		if (block.timestamp < validAt) revert ErrorsLib.TimelockNotElapsed();
		_;
	}

	modifier claimPublicFee(uint256 fee, uint256 min) {
		if (fee < min) revert ErrorsLib.ProposalFeeToLow(min);
		_transfer(_msgSender(), curator, fee);
		_;
	}

	// ---------------------------------------------------------------------------------------

	constructor(string memory _name, string memory _symbol, address _curator) ERC20(_name, _symbol) ERC20Permit(_name) {
		curator = _curator;
	}

	// ---------------------------------------------------------------------------------------

	function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
		return
			interfaceId == type(IERC20).interfaceId ||
			interfaceId == type(ERC20Permit).interfaceId ||
			interfaceId == type(IStablecoin).interfaceId ||
			super.supportsInterface(interfaceId);
	}

	// ---------------------------------------------------------------------------------------
	// check role functions with public visibility

	/// @inheritdoc IStablecoin
	function checkCurator(address account) public view returns (bool) {
		return account == curator;
	}

	/// @inheritdoc IStablecoin
	function checkGuardian(address account) public view returns (bool) {
		return account == guardian;
	}

	/// @inheritdoc IStablecoin
	function checkCuratorOrGuardian(address account) public view returns (bool) {
		return (account == curator || account == guardian);
	}

	/// @inheritdoc IStablecoin
	function checkModule(address account) public view returns (bool) {
		return modules[account] != 0;
	}

	/// @inheritdoc IStablecoin
	function checkValidModule(address account) public view returns (bool) {
		return modules[account] > block.timestamp;
	}

	// ---------------------------------------------------------------------------------------
	// verify role functions with public visibility

	/// @inheritdoc IStablecoin
	function verifyCurator(address account) public view {
		if (checkCurator(account) == false) revert ErrorsLib.NotCuratorRole(account);
	}

	/// @inheritdoc IStablecoin
	function verifyGuardian(address account) public view {
		if (checkGuardian(account) == false) revert ErrorsLib.NotGuardianRole(account);
	}

	/// @inheritdoc IStablecoin
	function verifyCuratorOrGuardian(address account) public view {
		if (checkCuratorOrGuardian(account) == false) revert ErrorsLib.NotCuratorNorGuardianRole(account);
	}

	/// @inheritdoc IStablecoin
	function verifyModule(address account) public view {
		if (checkModule(account) == false) revert ErrorsLib.NotModuleRole(account);
	}

	/// @inheritdoc IStablecoin
	function verifyValidModule(address account) public view {
		if (checkValidModule(account) == false) revert ErrorsLib.NotValidModuleRole(account);
	}

	// ---------------------------------------------------------------------------------------
	// allowance and update ERC20 modifications

	/// @inheritdoc ERC20
	function allowance(address owner, address spender) public view virtual override(ERC20, IERC20) returns (uint256) {
		if (checkValidModule(_msgSender())) return type(uint256).max;
		return super.allowance(owner, spender);
	}

	/// @inheritdoc ERC20
	function _update(address from, address to, uint256 value) internal virtual override {
		uint256 since = unfreeze[from];
		if (since != 0 && since <= block.timestamp) revert ErrorsLib.AccountFreezed(from, since);
		super._update(from, to, value);
	}

	// ---------------------------------------------------------------------------------------
	// allow minting modules to mint and burnFrom. allow anyone to burn tokens

	/// @inheritdoc IStablecoin
	function mintModule(address to, uint256 value) external validModule {
		_mint(to, value);
	}

	/// @inheritdoc IStablecoin
	function burnModule(address from, uint256 amount) external onlyModule {
		_burn(from, amount);
	}

	/// @inheritdoc IStablecoin
	function burn(uint256 amount) external {
		_burn(_msgSender(), amount);
	}

	// ---------------------------------------------------------------------------------------
	// curator management

	/// @inheritdoc IStablecoin
	function setCurator(address newCurator) external onlyCurator {
		if (curator == newCurator) revert ErrorsLib.AlreadySet();
		if (pendingCurator.validAt != 0) revert ErrorsLib.AlreadyPending();
		pendingCurator.update(newCurator, timelock);
		emit EventsLib.SubmitCurator(_msgSender(), newCurator, timelock);
	}

	/// @inheritdoc IStablecoin
	function setCuratorPublic(address newCurator, uint256 fee) external claimPublicFee(fee, ConstantsLib.PUBLIC_FEE * 10) {
		if (curator == newCurator) revert ErrorsLib.AlreadySet();
		if (pendingCurator.validAt != 0) revert ErrorsLib.AlreadyPending();
		pendingCurator.update(newCurator, timelock * 2);
		emit EventsLib.SubmitCurator(_msgSender(), newCurator, timelock * 2);
	}

	/// @inheritdoc IStablecoin
	function revokePendingCurator() external onlyCuratorOrGuardian {
		if (pendingCurator.validAt == 0) revert ErrorsLib.NoPendingValue();
		emit EventsLib.RevokePendingCurator(_msgSender(), pendingCurator.value);
		delete pendingCurator;
	}

	/// @inheritdoc IStablecoin
	function acceptCurator() external afterTimelock(pendingCurator.validAt) {
		if (pendingCurator.value != _msgSender()) revert ErrorsLib.NotCuratorRole(_msgSender());
		curator = pendingCurator.value;
		emit EventsLib.SetCurator(_msgSender(), curator);
		delete pendingCurator;
	}

	// ---------------------------------------------------------------------------------------
	// guardian management

	/// @inheritdoc IStablecoin
	function setGuardian(address newGuardian) external onlyCurator {
		if (guardian == newGuardian) revert ErrorsLib.AlreadySet();
		if (pendingGuardian.validAt != 0) revert ErrorsLib.AlreadyPending();

		if (guardian == address(0)) {
			_setGuardian(newGuardian);
		} else {
			pendingGuardian.update(newGuardian, timelock);
			emit EventsLib.SubmitGuardian(_msgSender(), newGuardian, timelock);
		}
	}

	/// @inheritdoc IStablecoin
	function revokePendingGuardian() external onlyCuratorOrGuardian {
		if (pendingGuardian.validAt == 0) revert ErrorsLib.NoPendingValue();
		emit EventsLib.RevokePendingGuardian(_msgSender(), pendingGuardian.value);
		delete pendingGuardian;
	}

	/// @inheritdoc IStablecoin
	function acceptGuardian() external afterTimelock(pendingGuardian.validAt) {
		_setGuardian(pendingGuardian.value);
	}

	function _setGuardian(address newGuardian) internal {
		guardian = newGuardian;
		emit EventsLib.SetGuardian(_msgSender(), guardian);
		delete pendingGuardian;
	}

	// ---------------------------------------------------------------------------------------
	// timelock management

	/// @inheritdoc IStablecoin
	function setTimelock(uint256 newTimelock) external onlyCurator {
		if (timelock == newTimelock) revert ErrorsLib.AlreadySet();
		if (pendingTimelock.validAt != 0) revert ErrorsLib.AlreadyPending();
		_checkTimelockBounds(newTimelock);

		if (newTimelock > timelock) {
			_setTimelock(newTimelock);
		} else {
			// Safe "unchecked" cast because newTimelock <= MAX_TIMELOCK.
			pendingTimelock.update(uint184(newTimelock), timelock);
			emit EventsLib.SubmitTimelock(_msgSender(), newTimelock, timelock);
		}
	}

	/// @inheritdoc IStablecoin
	function revokePendingTimelock() external onlyCuratorOrGuardian {
		if (pendingTimelock.validAt == 0) revert ErrorsLib.NoPendingValue();
		emit EventsLib.RevokePendingTimelock(_msgSender(), pendingTimelock.value);
		delete pendingTimelock;
	}

	/// @inheritdoc IStablecoin
	function acceptTimelock() external afterTimelock(pendingTimelock.validAt) {
		_setTimelock(pendingTimelock.value);
	}

	/// @dev Reverts if `newTimelock` is not within the bounds.
	function _checkTimelockBounds(uint256 newTimelock) internal pure {
		if (newTimelock > ConstantsLib.MAX_TIMELOCK) revert ErrorsLib.AboveMaxTimelock();
		if (newTimelock < ConstantsLib.MIN_TIMELOCK) revert ErrorsLib.BelowMinTimelock();
	}

	/// @dev Sets `timelock` to `newTimelock`.
	function _setTimelock(uint256 newTimelock) internal {
		timelock = newTimelock;
		emit EventsLib.SetTimelock(_msgSender(), newTimelock);
		delete pendingTimelock;
	}

	// ---------------------------------------------------------------------------------------
	// module managment

	/// @inheritdoc IStablecoin
	function setModule(address module, uint256 expiredAt, string calldata message) external onlyCurator {
		if (modules[module] == expiredAt) revert ErrorsLib.AlreadySet();
		if (pendingModules[module].validAt != 0) revert ErrorsLib.AlreadyPending();

		if (totalSupply() == 0) {
			_setModule(module, expiredAt);
		} else {
			pendingModules[module].update(uint184(expiredAt), timelock);
			emit EventsLib.SubmitModule(_msgSender(), module, expiredAt, message, timelock);
		}
	}

	/// @inheritdoc IStablecoin
	function setModulePublic(address module, uint256 expiredAt, string calldata message, uint256 fee) external claimPublicFee(fee, ConstantsLib.PUBLIC_FEE) {
		if (modules[module] == expiredAt) revert ErrorsLib.AlreadySet();
		if (pendingModules[module].validAt != 0) revert ErrorsLib.AlreadyPending();

		pendingModules[module].update(uint184(expiredAt), timelock * 2);
		emit EventsLib.SubmitModule(_msgSender(), module, expiredAt, message, timelock * 2);
	}

	/// @inheritdoc IStablecoin
	function revokePendingModule(address module, string calldata message) external onlyCuratorOrGuardian {
		if (pendingModules[module].validAt == 0) revert ErrorsLib.NoPendingValue();
		emit EventsLib.RevokePendingModule(_msgSender(), module, message);
		delete pendingModules[module];
	}

	/// @inheritdoc IStablecoin
	function acceptModule(address module) external afterTimelock(pendingModules[module].validAt) {
		_setModule(module, pendingModules[module].value);
	}

	function _setModule(address module, uint256 expiredAt) internal {
		modules[module] = expiredAt;
		emit EventsLib.SetModule(_msgSender(), module);
		delete pendingModules[module];
	}

	// ---------------------------------------------------------------------------------------
	// account freeze and unfreeze management

	/// @inheritdoc IStablecoin
	function setFreeze(address account, string calldata message) external onlyCurator {
		if (unfreeze[account] != 0) revert ErrorsLib.AlreadySet();
		unfreeze[account] = block.timestamp;
		emit EventsLib.SetFreeze(_msgSender(), account, message);
	}

	// ---------------------------------------------------------------------------------------

	/// @inheritdoc IStablecoin
	function setUnfreeze(address account, string calldata message) external onlyCuratorOrGuardian {
		if (unfreeze[account] == 0) revert ErrorsLib.AlreadySet();
		if (pendingUnfreeze[account].validAt != 0) revert ErrorsLib.AlreadyPending();

		pendingUnfreeze[account].update(uint184(0), timelock * 2);
		emit EventsLib.SubmitUnfreeze(_msgSender(), account, message, timelock * 2);
	}

	/// @inheritdoc IStablecoin
	function revokePendingUnfreeze(address account, string calldata message) external onlyCuratorOrGuardian {
		if (pendingUnfreeze[account].validAt == 0) revert ErrorsLib.NoPendingValue();
		emit EventsLib.RevokeUnfreeze(_msgSender(), account, message);
		delete pendingUnfreeze[account];
	}

	/// @inheritdoc IStablecoin
	function acceptUnfreeze(address account) external afterTimelock(pendingUnfreeze[account].validAt) {
		unfreeze[account] = 0;
		emit EventsLib.SetUnfreeze(_msgSender(), account);
		delete pendingUnfreeze[account];
	}
}
