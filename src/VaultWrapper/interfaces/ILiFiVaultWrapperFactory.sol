// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeType } from "../LiFiVaultWrapperTypes.sol";

/// @title ILiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Events, errors, and the live state a vault wrapper reads back from its factory.
/// @custom:version 1.0.0
interface ILiFiVaultWrapperFactory {
    /// Views ///

    /// @notice Returns the adjustable fee bounds (bps) for a fee type.
    /// @dev ABI-identical to the auto-generated getter for the factory's public
    ///      `mapping(FeeType => FeeBounds) feeBounds`, which flattens the struct to
    ///      a `(uint16, uint16)` tuple. Read live by instances enforcing rate changes.
    /// @param _feeType The fee type to look up.
    /// @return minBps The lowest rate (bps) an instance may set for the fee type.
    /// @return maxBps The highest rate (bps) an instance may set for the fee type.
    function feeBounds(
        FeeType _feeType
    ) external view returns (uint16 minBps, uint16 maxBps);

    /// @notice Whether deposits are globally halted across every vault wrapper.
    /// @return True when the global circuit breaker is engaged.
    function globalPaused() external view returns (bool);

    /// Events ///

    /// @notice Emitted when a new vault wrapper is deployed.
    /// @param instance The deployed vault wrapper address.
    /// @param namespace The integrator namespace the instance belongs to.
    /// @param underlying The wrapped yield source.
    /// @param adapter The yield adapter the vault wrapper routes through.
    /// @param asset The ERC20 asset resolved from the underlying.
    /// @param vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param integratorShareBps The integrator fee share (bps) snapshotted into the instance.
    /// @param nonce The caller-supplied nonce disambiguating instances.
    /// @param salt The CREATE2 salt used to deploy the vault wrapper.
    event WrapperDeployed(
        address indexed instance,
        bytes32 indexed namespace,
        address indexed underlying,
        address adapter,
        address asset,
        address vaultWrapperAdmin,
        uint16 integratorShareBps,
        uint256 nonce,
        bytes32 salt
    );

    /// @notice Emitted when a yield source is added to or removed from the allowlist.
    /// @param underlying The yield source address.
    /// @param allowed Whether it is now allowed.
    event UnderlyingAllowedSet(address indexed underlying, bool allowed);

    /// @notice Emitted when a yield adapter is approved or revoked.
    /// @param adapter The adapter address.
    /// @param approved Whether it is now approved.
    event AdapterApprovedSet(address indexed adapter, bool approved);

    /// @notice Emitted when adjustable fee bounds for a fee type are set.
    /// @param feeType The fee type.
    /// @param minBps The minimum rate (bps).
    /// @param maxBps The maximum rate (bps).
    event FeeBoundsSet(FeeType indexed feeType, uint16 minBps, uint16 maxBps);

    /// @notice Emitted when the default integrator fee share is set.
    /// @param integratorBps The integrator share (bps); LI.FI receives the remaining (100% - integratorBps).
    event DefaultSplitSet(uint16 integratorBps);

    /// @notice Emitted when LI.FI's fee recipient is set.
    /// @param recipient The address that receives LI.FI's fee share.
    event LifiFeeRecipientSet(address indexed recipient);

    /// @notice Emitted when a namespace's authorized deployer is assigned or revoked.
    /// @param namespace The integrator namespace.
    /// @param deployer The authorized deployer (zero address revokes).
    event IntegratorDeployerSet(
        bytes32 indexed namespace,
        address indexed deployer
    );

    /// @notice Emitted when the global circuit breaker is toggled.
    /// @param paused The new pause state.
    /// @param by The emergency pauser that toggled it.
    event GlobalPauseSet(bool paused, address indexed by);

    /// @notice Emitted when a role address is rotated.
    /// @param role The role identifier.
    /// @param oldAddr The previous holder.
    /// @param newAddr The new holder.
    event RoleRotated(bytes32 indexed role, address oldAddr, address newAddr);

    /// Errors ///

    /// @notice Thrown when the caller is not the emergency pauser.
    error NotEmergencyPauser();
    /// @notice Thrown when the caller is not the onboarding manager.
    error NotOnboardingManager();
    /// @notice Thrown when the caller is not authorized to deploy under the namespace.
    error NotApprovedDeployer();
    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when the namespace is the zero value.
    error ZeroNamespace();
    /// @notice Thrown when fee bounds are invalid (min > max, or max above the cap).
    error InvalidFeeBounds();
    /// @notice Thrown when an integrator fee split exceeds 100% (the bps denominator).
    error InvalidSplit();
    /// @notice Thrown when a self-serve deployer sets an integrator share above the
    ///         factory default, which would cut LI.FI's share below its default cut.
    error IntegratorShareAboveDefault();
    /// @notice Thrown when the underlying is not on the deploy allowlist.
    error UnderlyingNotAllowed();
    /// @notice Thrown when the chosen adapter is not approved.
    error AdapterNotApproved();
    /// @notice Thrown when an enabled fee rate is outside its configured bounds.
    error FeeRateAboveBound();
    /// @notice Thrown when an enabled fee rate exceeds its immutable cap.
    error FeeRateAboveCap();
    /// @notice Thrown when a disabled fee carries a non-zero rate.
    error DisabledFeeMustBeZero();
}
