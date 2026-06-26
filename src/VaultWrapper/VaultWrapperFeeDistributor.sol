// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VaultWrapperFeeDistributor
/// @author LI.FI (https://li.fi)
/// @notice Fee receiver configuration and sweep/distribution mixin for a vault wrapper.
///         Accrued fee assets are routed into two pools — LI.FI's and the integrator's —
///         split by the instance's `integratorShareBps`. A permissionless sweep pays the
///         LI.FI pool to the factory-governed recipient (read live) and the integrator pool
///         across 1..5 integrator wallets by their individual bps.
/// @dev Abstract: the wrapper supplies the fee asset, the integrator/LI.FI split, and the
///      live LI.FI recipient via hooks. This module owns only the routing of ALREADY-collected
///      fee assets and their distribution; computing how much fee to take (accrual) is a
///      separate concern that calls `_routeFee`. The external `setIntegratorReceivers`/`sweep`
///      entrypoints live on the wrapper so they reuse its integrator-admin gate and reentrancy
///      guard. Fee pools are asset-denominated; the wrapper holds exactly
///      `lifiFeesAccrued + integratorFeesAccrued` idle asset between operations.
/// @custom:version 1.0.0
abstract contract VaultWrapperFeeDistributor {
    /// Constants ///

    /// @notice Basis-point denominator (100%).
    uint16 internal constant FEE_BPS_DENOMINATOR = 10000;
    /// @notice Maximum number of integrator receiver wallets.
    uint256 internal constant MAX_FEE_RECEIVERS = 5;

    /// Storage ///

    /// @dev Integrator payout wallets (1..5), parallel to `_integratorReceiverBps`.
    address[] internal _integratorReceivers;
    /// @dev Per-receiver bps, summing to 100%; parallel to `_integratorReceivers`.
    uint16[] internal _integratorReceiverBps;
    /// @notice Accrued fee assets owed to LI.FI, awaiting sweep.
    uint256 public lifiFeesAccrued;
    /// @notice Accrued fee assets owed to the integrator wallets, awaiting sweep.
    uint256 public integratorFeesAccrued;

    /// @dev Reserved slots so this mixin can gain state in a future upgrade without
    ///      shifting the storage of contracts that inherit after it. Append-only; never
    ///      reorder fields or the inheriting contract's base list. (See LiFiVaultWrapper.)
    uint256[50] private __gap;

    /// Events ///

    /// @notice Emitted when the integrator's receiver set is configured.
    /// @param receivers The integrator payout wallets.
    /// @param bps The per-receiver basis points (sum to 100%).
    event ReceiversSet(address[] receivers, uint16[] bps);

    /// @notice Emitted when the LI.FI fee pool is swept.
    /// @param amount Asset amount paid to the LI.FI recipient.
    /// @param recipient The LI.FI recipient the pool was paid to.
    event LifiFeesSwept(uint256 amount, address indexed recipient);

    /// @notice Emitted when the integrator fee pool is distributed across its wallets.
    /// @param amount Total asset amount distributed.
    event IntegratorFeesSwept(uint256 amount);

    /// Errors ///

    /// @notice Thrown when the receiver count is zero or above MAX_FEE_RECEIVERS.
    error InvalidReceiverCount();
    /// @notice Thrown when the receivers and bps arrays differ in length.
    error ReceiversLengthMismatch();
    /// @notice Thrown when a receiver wallet is the zero address.
    error ZeroReceiver();
    /// @notice Thrown when the receiver bps do not sum to exactly 100%.
    error ReceiverBpsSumNot100();

    /// Hooks (implemented by the wrapper) ///

    /// @dev The ERC20 fee asset the pools are denominated in (the vault asset).
    function _feeAsset() internal view virtual returns (address);

    /// @dev The integrator's fee share (bps); the remainder accrues to LI.FI.
    function _integratorShareBps() internal view virtual returns (uint16);

    /// @dev The LI.FI fee recipient, read live from the factory at sweep time.
    function _lifiFeeRecipient() internal view virtual returns (address);

    /// Views ///

    /// @notice The configured integrator payout wallets.
    /// @return The receiver addresses.
    function integratorReceivers() external view returns (address[] memory) {
        return _integratorReceivers;
    }

    /// @notice The per-receiver basis points, parallel to `integratorReceivers`.
    /// @return The receiver bps.
    function integratorReceiverBps() external view returns (uint16[] memory) {
        return _integratorReceiverBps;
    }

    /// Internal ///

    /// @dev Validates and stores the integrator receiver set: 1..5 wallets, no zero
    ///      address, equal-length bps summing to exactly 100%.
    function _setIntegratorReceivers(
        address[] calldata _receivers,
        uint16[] calldata _bps
    ) internal {
        uint256 count = _receivers.length;
        if (count == 0 || count > MAX_FEE_RECEIVERS)
            revert InvalidReceiverCount();
        if (_bps.length != count) revert ReceiversLengthMismatch();

        uint256 sum;
        for (uint256 i; i < count; i++) {
            if (_receivers[i] == address(0)) revert ZeroReceiver();
            sum += _bps[i];
        }
        if (sum != FEE_BPS_DENOMINATOR) revert ReceiverBpsSumNot100();

        _integratorReceivers = _receivers;
        _integratorReceiverBps = _bps;
        emit ReceiversSet(_receivers, _bps);
    }

    /// @dev Splits a collected fee into the LI.FI and integrator pools by the instance's
    ///      `integratorShareBps`. Called by the deposit/withdraw skim once fee accrual lands.
    /// @param _feeAssets The collected fee amount, in the vault asset.
    function _routeFee(uint256 _feeAssets) internal {
        if (_feeAssets == 0) return;
        uint256 integratorPart = (_feeAssets * _integratorShareBps()) /
            FEE_BPS_DENOMINATOR;
        integratorFeesAccrued += integratorPart;
        lifiFeesAccrued += _feeAssets - integratorPart;
    }

    /// @dev Sweeps both pools. LI.FI is paid first and independently of the integrator side
    ///      so an integrator can never hold LI.FI's fees hostage (by never configuring
    ///      receivers, or via a receiver that reverts on receipt). If the integrator pool is
    ///      non-zero but no receivers are configured, the integrator portion is left accrued
    ///      for a later sweep rather than reverting. (LI.FI's last-resort path against a
    ///      reverting integrator receiver is `_payLifiFees` alone, exposed as `sweepLifiFees`.)
    function _distributeAccruedFees() internal {
        _payLifiFees();
        _payIntegratorFees();
    }

    /// @dev Pays the LI.FI pool to the live factory recipient. CEI: the pool is zeroed before
    ///      the transfer, so a reentrant sweep finds it empty. No-op when empty.
    function _payLifiFees() internal {
        uint256 amount = lifiFeesAccrued;
        if (amount == 0) return;
        lifiFeesAccrued = 0;

        address recipient = _lifiFeeRecipient();
        SafeERC20.safeTransfer(IERC20(_feeAsset()), recipient, amount);
        emit LifiFeesSwept(amount, recipient);
    }

    /// @dev Distributes the integrator pool across its wallets by bps. The last receiver
    ///      absorbs the integer-division remainder so the pool zeroes exactly; a receiver
    ///      with bps==0, or whose floored share rounds to 0 on a tiny pool, receives nothing.
    ///      Skips (leaves the pool accrued) when no receivers are configured rather than
    ///      reverting, so it never blocks the LI.FI payout. CEI: the pool is zeroed first.
    function _payIntegratorFees() private {
        uint256 amount = integratorFeesAccrued;
        if (amount == 0) return;

        address[] memory receivers = _integratorReceivers;
        if (receivers.length == 0) return;
        integratorFeesAccrued = 0;

        address asset = _feeAsset();
        uint16[] memory bps = _integratorReceiverBps;
        uint256 distributed;
        uint256 last = receivers.length - 1;
        for (uint256 i; i <= last; i++) {
            uint256 share = i == last
                ? amount - distributed
                : (amount * bps[i]) / FEE_BPS_DENOMINATOR;
            distributed += share;
            if (share > 0)
                SafeERC20.safeTransfer(IERC20(asset), receivers[i], share);
        }

        emit IntegratorFeesSwept(amount);
    }
}
