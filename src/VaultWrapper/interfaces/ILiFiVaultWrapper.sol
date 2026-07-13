// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { FeeConfig, FeeType, FeeReceiver, FEE_TYPE_COUNT } from "../LiFiVaultWrapperTypes.sol";

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
    event VaultWrapperConfigured(
        address indexed asset,
        address indexed underlying,
        address indexed adapter,
        address vaultWrapperAdmin
    );

    /// @notice Emitted when a fee type's rate is changed.
    /// @param feeType The fee type updated.
    /// @param newRateBps The new rate in basis points (0 = disabled).
    event FeeConfigUpdated(FeeType indexed feeType, uint16 newRateBps);

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

    /// @notice Emitted when the instance's access gate is set (at initialize when
    ///         non-zero, and on every `setAccessGate`).
    /// @param accessGate The new gate; address(0) = fully permissionless.
    event AccessGateUpdated(address indexed accessGate);

    /// @notice Emitted when the integrator's fee-receiver set is configured.
    /// @param receivers The integrator payout wallets with their bps split (sum to 100%).
    event ReceiversSet(FeeReceiver[] receivers);

    /// @notice Emitted once per non-empty fee pool distributed by `distributeFees`.
    /// @param token The fee-pool token (the vault asset, or this wrapper's shares).
    /// @param lifiAmount Amount delivered to the LI.FI recipient (LI.FI's split only).
    /// @param integratorAmount Amount delivered across the integrator wallets (excludes any
    ///        retained after a failed transfer).
    event FeePoolDistributed(
        address indexed token,
        uint256 lifiAmount,
        uint256 integratorAmount
    );

    /// @notice Emitted when an integrator payout fails (e.g. a blacklisted wallet). The amount
    ///         is left in the wrapper — still tracked as owed integrator fees — instead of
    ///         reverting the distribution or being redirected to LI.FI. The integrator can
    ///         rotate to a working wallet via `setIntegratorFeeReceivers` and call
    ///         `distributeFees` again to claim it.
    /// @param receiver The integrator wallet whose transfer reverted.
    /// @param token The fee-pool token retained (the asset, or this wrapper's shares).
    /// @param amount The amount retained in the wrapper.
    event IntegratorPayoutRetained(
        address indexed receiver,
        address indexed token,
        uint256 amount
    );

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
    /// @notice Thrown when the receiver count is zero or above MAX_FEE_RECEIVERS.
    error InvalidReceiverCount();
    /// @notice Thrown when a receiver wallet is the zero address.
    error ZeroReceiver();
    /// @notice Thrown when the receiver bps do not sum to exactly 100%.
    error ReceiverBpsSumNot100();
    /// @notice Thrown when the access gate rejects a deposit/mint share receiver.
    error AccountNotAllowed(address account);
    /// @notice Thrown when the access gate rejects a share transfer.
    error TransferNotAllowed(address from, address to);
    /// @notice Thrown when the access gate flags an exit party as sanctioned.
    error AccountSanctioned(address account);

    /// Functions ///

    /// @notice One-time setup of a vault wrapper immediately after deployment.
    /// @dev The asset is resolved from `_underlying` via `_adapter` rather than passed in,
    ///      so it cannot disagree with what the adapter actually reports.
    /// @param _underlying The protocol-specific yield source (e.g. an ERC-4626 vault).
    /// @param _adapter The approved yield adapter the vault wrapper routes through at runtime.
    /// @param _vaultWrapperAdmin The per-vault controller granted the instance admin role.
    /// @param _integratorShareBps The integrator's fee share (bps) per fee type (indexed by
    ///        FeeType ordinal), resolved and bounded by the factory.
    /// @param _fees The per-fee-type rates, 0 = disabled (already validated by the factory).
    /// @param _receivers The integrator payout wallets + bps split; validated on-instance
    ///        (1..50 non-zero wallets, bps summing to exactly 100%).
    /// @param _accessGate The pluggable IAccessGate governing the instance's perimeter;
    ///        address(0) = fully permissionless.
    function initialize(
        address _underlying,
        address _adapter,
        address _vaultWrapperAdmin,
        uint16[FEE_TYPE_COUNT] calldata _integratorShareBps,
        FeeConfig calldata _fees,
        FeeReceiver[] calldata _receivers,
        address _accessGate
    ) external;
}
