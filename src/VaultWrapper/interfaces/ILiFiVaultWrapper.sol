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
    /// @param integratorShareBps The integrator's per-fee-type shares (bps, indexed by
    ///        FeeType ordinal) snapshotted at deploy.
    event VaultWrapperConfigured(
        address indexed asset,
        address indexed underlying,
        address indexed adapter,
        address vaultWrapperAdmin,
        address factory,
        uint16[4] integratorShareBps
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
    /// @dev The LI.FI/integrator split is applied at accrual; LI.FI's part is
    ///      `feeShares - integratorShares`.
    /// @param feeType The fee type that accrued (Management or Performance).
    /// @param feeShares The total shares minted to the wrapper.
    /// @param integratorShares The integrator's part of the minted shares.
    event DilutionFeeAccrued(
        FeeType indexed feeType,
        uint256 feeShares,
        uint256 integratorShares
    );

    /// @notice Emitted when an asset-side fee is charged and held idle.
    /// @dev The LI.FI/integrator split is applied at charge; LI.FI's part is
    ///      `feeAssets - integratorAssets`.
    /// @param feeType The fee type charged (Deposit or Withdrawal).
    /// @param feeAssets The total fee amount, in assets.
    /// @param integratorAssets The integrator's part of the fee, in assets.
    event AssetFeeCharged(
        FeeType indexed feeType,
        uint256 feeAssets,
        uint256 integratorAssets
    );

    /// @notice Emitted when the integrator toggles this clone's deposit pause.
    /// @param paused The new pause state.
    /// @param by The owner (integrator) that toggled it.
    event PauseSet(bool paused, address indexed by);

    /// Errors ///

    /// @notice Thrown when a deposit is attempted while any pause source is engaged.
    error DepositsPaused();
    /// @notice Thrown when a fee type ordinal is outside the valid range (0-3).
    error InvalidFeeType(uint8 feeType);
    /// @notice Thrown when a required initialization address is the zero address.
    error ZeroAddress();
    /// @notice Thrown when a fee type's integrator share is 100% (10000 bps) or more.
    error InvalidIntegratorShareBps(uint16 integratorShareBps);
    /// @notice Thrown when ownership renouncement is attempted; the admin role is non-renounceable.
    error RenounceDisabled();
    /// @notice Thrown when the adapter invests less than the net deposit into the yield source.
    error AdapterDepositShortfall(uint256 expected, uint256 actual);
    /// @notice Thrown when the adapter returns less than the requested withdrawal amount.
    error AdapterWithdrawShortfall(uint256 expected, uint256 actual);
    /// @notice Thrown when a requested rate is outside the factory's live bounds.
    error FeeRateOutOfBounds(uint16 rateBps, uint16 minBps, uint16 maxBps);

    /// Functions ///

    /// @notice One-time setup of a vault wrapper immediately after deployment.
    /// @dev The asset is resolved from `_underlying` via `_adapter` rather than passed in,
    ///      so it cannot disagree with what the adapter actually reports.
    /// @param _underlying The protocol-specific yield source (e.g. an ERC-4626 vault).
    /// @param _adapter The approved yield adapter the vault wrapper routes through at runtime.
    /// @param _vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param _integratorShareBps The integrator's fee share (bps) per fee type (indexed by
    ///        FeeType ordinal), resolved and bounded by the factory.
    /// @param _fees The per-fee-type rates and enabled flags (already validated by the factory).
    /// @param _initData Opaque vault-wrapper-side config (access mode, receivers, ToS hash, oracle).
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16[4] calldata _integratorShareBps,
        FeeConfig calldata _fees,
        bytes calldata _initData
    ) external;
}
