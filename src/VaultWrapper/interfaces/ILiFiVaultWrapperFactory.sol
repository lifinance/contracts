// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeType } from "../LiFiVaultWrapperTypes.sol";

/// @title ILiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Events and errors emitted by the LI.FI vault wrapper factory.
/// @custom:version 1.0.0
interface ILiFiVaultWrapperFactory {
    /// Events ///

    /// @notice Emitted when a new vault wrapper is deployed.
    /// @param instance The deployed vault wrapper address.
    /// @param integrator The integrator that owns the instance.
    /// @param underlying The wrapped yield source.
    /// @param adapter The yield adapter the vault wrapper routes through.
    /// @param nonce The caller-supplied nonce disambiguating instances.
    /// @param salt The CREATE2 salt used to deploy the vault wrapper.
    event WrapperDeployed(
        address indexed instance,
        address indexed integrator,
        address indexed underlying,
        address adapter,
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

    /// @notice Emitted when the ceiling on the integrator fee share is set.
    /// @param maxBps The maximum integrator share (bps) a deploy may set.
    event MaxIntegratorShareSet(uint16 maxBps);

    /// @notice Emitted when an integrator's self-deploy approval changes.
    /// @param integrator The integrator address.
    /// @param approved Whether it is now approved.
    event IntegratorApprovedSet(address indexed integrator, bool approved);

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
    /// @notice Thrown when a self-deploying caller is not an approved integrator.
    error IntegratorNotApproved();
    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when fee bounds are invalid (min > max, or max above the cap).
    error InvalidFeeBounds();
    /// @notice Thrown when a configured split is invalid (above 100%, or default/ceiling crossed).
    error InvalidSplit();
    /// @notice Thrown when a deploy sets an integrator share above the ceiling.
    error IntegratorShareAboveCeiling();
    /// @notice Thrown when the underlying is not on the deploy allowlist.
    error UnderlyingNotAllowed();
    /// @notice Thrown when the chosen adapter is not approved.
    error AdapterNotApproved();
    /// @notice Thrown when the adapter cannot resolve the underlying's asset.
    error AssetResolutionFailed();
    /// @notice Thrown when an enabled fee rate is outside its configured bounds.
    error FeeRateAboveBound();
    /// @notice Thrown when an enabled fee rate exceeds its immutable cap.
    error FeeRateAboveCap();
    /// @notice Thrown when a disabled fee carries a non-zero rate.
    error DisabledFeeMustBeZero();
    /// @notice Thrown when an approved integrator deploys for a different integrator.
    error IntegratorMismatch();
    /// @notice Thrown when an instance already exists for the computed salt.
    error InstanceAlreadyExists();
}
