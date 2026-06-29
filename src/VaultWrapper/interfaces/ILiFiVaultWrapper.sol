// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeConfig, FeeType } from "../LiFiVaultWrapperTypes.sol";

/// @title ILiFiVaultWrapper
/// @author LI.FI (https://li.fi)
/// @notice Interface the factory calls on a freshly deployed vault wrapper, plus the events
///         and errors the vault wrapper emits.
/// @custom:version 1.0.0
interface ILiFiVaultWrapper {
    /// Events ///

    /// @notice Emitted once when the instance is configured.
    /// @param asset The ERC20 asset the vault is denominated in.
    /// @param underlying The yield source the wrapper deposits into.
    /// @param adapter The yield adapter the wrapper routes through.
    /// @param vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param factory The factory that deployed and initialized the instance.
    /// @param integratorShareBps The integrator's fee share (bps) snapshotted at deploy.
    event Initialized(
        address indexed asset,
        address indexed underlying,
        address indexed adapter,
        address vaultWrapperAdmin,
        address factory,
        uint16 integratorShareBps
    );

    /// @notice Emitted when an admin transfer is started (pending acceptance).
    /// @param currentAdmin The admin initiating the transfer.
    /// @param newAdmin The proposed new admin that must accept.
    event VaultWrapperAdminTransferStarted(
        address indexed currentAdmin,
        address indexed newAdmin
    );

    /// @notice Emitted when the admin role is transferred (accepted).
    /// @param previousAdmin The admin being replaced.
    /// @param newAdmin The admin that accepted the role.
    event VaultWrapperAdminTransferred(
        address indexed previousAdmin,
        address indexed newAdmin
    );

    /// @notice Emitted when a fee type's rate (and enabled flag) is changed.
    /// @param feeType The fee type updated.
    /// @param newRateBps The new rate in basis points (0 when disabled).
    /// @param enabled Whether the fee type is now active.
    event FeeConfigUpdated(
        FeeType indexed feeType,
        uint16 newRateBps,
        bool enabled
    );

    /// @notice Emitted when dilution fee-shares are minted to the wrapper.
    /// @dev Reports the total before the LI.FI/integrator split.
    /// @param feeType The fee type that accrued (Management today).
    /// @param feeShares The shares minted to the wrapper.
    event DilutionFeeAccrued(FeeType indexed feeType, uint256 feeShares);

    /// @notice Emitted when an asset-side fee is charged and held idle.
    /// @param feeType The fee type charged (Deposit or Withdrawal).
    /// @param feeAssets The fee amount, in assets.
    event AssetFeeCharged(FeeType indexed feeType, uint256 feeAssets);

    /// Errors ///

    /// @notice Thrown when a fee type ordinal is outside the valid range (0-3).
    error InvalidFeeType(uint8 feeType);
    /// @notice Thrown when a required initialization address is the zero address.
    error ZeroAddress();
    /// @notice Thrown when the integrator share exceeds 100% (10000 bps).
    error InvalidIntegratorShareBps(uint16 integratorShareBps);
    /// @notice Thrown when a caller other than the current admin attempts an admin action.
    error NotVaultWrapperAdmin();
    /// @notice Thrown when a caller other than the pending admin attempts to accept the role.
    error NotPendingVaultWrapperAdmin();
    /// @notice Thrown when the adapter invests less than the net deposit into the yield source.
    error AdapterDepositShortfall(uint256 expected, uint256 actual);
    /// @notice Thrown when the adapter returns less than the requested withdrawal amount.
    error AdapterWithdrawShortfall(uint256 expected, uint256 actual);
    /// @notice Thrown when a rate change is attempted for the performance fee, which is
    ///         not configurable through this setter.
    error FeeTypeNotConfigurable(FeeType feeType);
    /// @notice Thrown when a requested rate is outside the factory's live bounds.
    error FeeRateOutOfBounds(uint16 rateBps, uint16 minBps, uint16 maxBps);

    /// Functions ///

    /// @notice One-time setup of a vault wrapper immediately after deployment.
    /// @dev The asset is resolved from `_underlying` via `_adapter` rather than passed in,
    ///      so it cannot disagree with what the adapter actually reports.
    /// @param _underlying The protocol-specific yield source (e.g. an ERC-4626 vault).
    /// @param _adapter The approved yield adapter the vault wrapper routes through at runtime.
    /// @param _vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param _integratorShareBps The integrator's fee share (bps), resolved and bounded by the factory.
    /// @param _fees The per-fee-type rates and enabled flags (already validated by the factory).
    /// @param _initData Opaque vault-wrapper-side config (access mode, receivers, ToS hash, oracle).
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16 _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external;
}
