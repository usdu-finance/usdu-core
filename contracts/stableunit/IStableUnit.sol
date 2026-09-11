// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

interface IStableUnit is IERC20 {
	// ---------------------------------------------------------------------------------------

	/// @notice Checks if the given account has the curator role.
	/// @param account The address to check.
	/// @return True if the account is a curator, false otherwise.
	function checkCurator(address account) external view returns (bool);

	/// @notice Checks if the given account has the guardian role.
	/// @param account The address to check.
	/// @return True if the account is a guardian, false otherwise.
	function checkGuardian(address account) external view returns (bool);

	/// @notice Checks if the given account is either a curator or a guardian.
	/// @param account The address to check.
	/// @return True if the account is a curator or a guardian, false otherwise.
	function checkCuratorOrGuardian(address account) external view returns (bool);

	/// @notice Checks if the given account has any module role (active or expired).
	/// @param account The address to check.
	/// @return True if the account is a module, false otherwise.
	function checkModule(address account) external view returns (bool);

	/// @notice Checks if the given account is a valid (non-expired) module.
	/// @param account The address to check.
	/// @return True if the account is a valid module, false otherwise.
	function checkValidModule(address account) external view returns (bool);

	// ---------------------------------------------------------------------------------------

	/// @notice Verifies that the given account is a curator.
	/// @dev Reverts if the account is not a curator.
	/// @param account The address to verify.
	function verifyCurator(address account) external view;

	/// @notice Verifies that the given account is a guardian.
	/// @dev Reverts if the account is not a guardian.
	/// @param account The address to verify.
	function verifyGuardian(address account) external view;

	/// @notice Verifies that the given account is either a curator or a guardian.
	/// @dev Reverts if the account is neither a curator nor a guardian.
	/// @param account The address to verify.
	function verifyCuratorOrGuardian(address account) external view;

	/// @notice Verifies that the given account has a module role (active or expired).
	/// @dev Reverts if the account is not a module.
	/// @param account The address to verify.
	function verifyModule(address account) external view;

	/// @notice Verifies that the given account is a valid (non-expired) module.
	/// @dev Reverts if the account is not a valid module.
	/// @param account The address to verify.
	function verifyValidModule(address account) external view;

	// ---------------------------------------------------------------------------------------

	/// @notice Mints `value` tokens to address `to`.
	/// @dev Callable only by addresses with the `validModule` role.
	/// @param to The address receiving the minted tokens.
	/// @param value The amount of tokens to mint.
	/// @custom:role validModule
	function mintModule(address to, uint256 value) external;

	/// @notice Burns `amount` tokens from address `from`.
	/// @dev Callable only by addresses with the `onlyModule` role.
	/// @param from The address whose tokens will be burned.
	/// @param amount The amount of tokens to burn.
	/// @custom:role onlyModule
	function burnModule(address from, uint256 amount) external;

	/// @notice Burns `amount` tokens from the caller's balance.
	/// @dev Publicly accessible by any user with sufficient balance.
	/// @param amount The amount of tokens to burn.
	/// @custom:role public
	function burn(uint256 amount) external;

	// ---------------------------------------------------------------------------------------

	/// @notice Sets a new curator for the contract.
	/// @dev Callable only by the current curator.
	/// @param newCurator The address to assign as the new curator.
	/// @custom:role onlyCurator
	function setCurator(address newCurator) external;

	/// @notice Publicly initiates a curator change by paying a fee.
	/// @dev Caller must pay `fee`, which must be at least `ConstantsLib.PUBLIC_FEE * 10`.
	/// @dev Applies a timelock that is twice as long
	/// @param newCurator The address to be proposed as the new curator.
	/// @param fee The fee amount submitted with the transaction.
	/// @custom:rule claimPublicFee(fee, ConstantsLib.PUBLIC_FEE * 10)
	function setCuratorPublic(address newCurator, uint256 fee) external;

	/// @notice Cancels a pending curator proposal.
	/// @dev Callable by either the current curator or a guardian.
	/// @custom:role onlyCuratorOrGuardian
	function revokePendingCurator() external;

	/// @notice Accepts the curator role after the timelock period.
	/// @dev Only new curator can accept the new role.
	/// @dev Callable only after `pendingCurator.validAt` timestamp has passed.
	/// @custom:rule afterTimelock(pendingCurator.validAt)
	function acceptCurator() external;

	// ---------------------------------------------------------------------------------------

	/// @notice Sets a new guardian for the contract.
	/// @dev Callable only by the current curator.
	/// @param newGuardian The address to assign as the new guardian.
	/// @custom:role onlyCurator
	function setGuardian(address newGuardian) external;

	/// @notice Cancels a pending guardian proposal.
	/// @dev Callable by either the current curator or the current guardian.
	/// @custom:role onlyCuratorOrGuardian
	function revokePendingGuardian() external;

	/// @notice Accepts the guardian role after the timelock period.
	/// @dev Callable only after `pendingGuardian.validAt` timestamp has passed.
	/// @custom:rule afterTimelock(pendingGuardian.validAt)
	function acceptGuardian() external;

	// ---------------------------------------------------------------------------------------

	/// @notice Proposes a new timelock duration for sensitive actions.
	/// @dev Callable only by the current curator.
	/// @param newTimelock The new timelock duration (typically in seconds).
	/// @custom:role onlyCurator
	function setTimelock(uint256 newTimelock) external;

	/// @notice Cancels a pending timelock change.
	/// @dev Callable by either the curator or the guardian.
	/// @custom:role onlyCuratorOrGuardian
	function revokePendingTimelock() external;

	/// @notice Finalizes the timelock change after the delay period.
	/// @dev Callable only after `pendingTimelock.validAt` has passed.
	/// @custom:rule afterTimelock(pendingTimelock.validAt)
	function acceptTimelock() external;

	// ---------------------------------------------------------------------------------------

	/// @notice Proposes a new module with an expiration time and message.
	/// @dev Callable only by the curator.
	/// @param module The address of the module to config.
	/// @param expiredAt The timestamp when the module should expire.
	/// @param message A message describing the module purpose or context.
	/// @custom:role onlyCurator
	function setModule(address module, uint256 expiredAt, string calldata message) external;

	/// @notice Publicly proposes a new module by paying a fee.
	/// @dev Requires a fee at least equal to `ConstantsLib.PUBLIC_FEE`.
	/// @dev Applies a timelock that is twice as long
	/// @param module The address of the module to config.
	/// @param expiredAt The timestamp when the module should expire.
	/// @param message A message describing the module purpose or context.
	/// @param fee The fee amount submitted with the transaction.
	/// @custom:rule claimPublicFee(fee, ConstantsLib.PUBLIC_FEE)
	function setModulePublic(address module, uint256 expiredAt, string calldata message, uint256 fee) external;

	/// @notice Cancels a pending module proposal.
	/// @dev Callable by either the curator or the guardian.
	/// @param module The address of the module to revoke.
	/// @param message A message explaining the revocation.
	/// @custom:role onlyCuratorOrGuardian
	function revokePendingModule(address module, string calldata message) external;

	/// @notice Finalizes the addition of a module after the timelock period.
	/// @dev Callable only after `pendingModules[module].validAt` has passed.
	/// @param module The address of the module to accept.
	/// @custom:rule afterTimelock(pendingModules[module].validAt)
	function acceptModule(address module) external;

	// ---------------------------------------------------------------------------------------
}
