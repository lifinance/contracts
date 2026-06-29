// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LibVaultWrapperMath
/// @author LI.FI (https://li.fi)
/// @notice Stateless arithmetic for the LI.FI vault wrapper fee engine: asset-side
///         deposit/withdrawal fees (the fee is a percentage of the net amount, so gross =
///         net + fee), time-based management-fee dilution, and the fee-inclusive share/asset
///         conversions. Centralizing the math here gives auditing and fuzzing a single,
///         side-effect-free surface; all state, minting, and routing stay in the wrapper.
/// @custom:version 1.0.0
library LibVaultWrapperMath {
    using Math for uint256;

    /// @notice Basis-point denominator (100% = 10000 bps).
    uint256 internal constant BASIS_POINT_SCALE = 10_000;

    /// @notice Seconds in a fee year, fixed at 365 days for management accrual.
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @notice Fee taken on top of a net amount (gross = net + fee).
    /// @dev Used where `_assets` is the net amount the user wants moved (previewMint,
    ///      previewWithdraw): the fee is added so the user supplies/owes the gross.
    ///      Rounds up so the fee favours the vault/holders.
    /// @param _assets The net amount the fee is computed on.
    /// @param _feeBps The fee rate in basis points.
    /// @return The fee amount in assets.
    function feeOnRaw(
        uint256 _assets,
        uint16 _feeBps
    ) internal pure returns (uint256) {
        return _assets.mulDiv(_feeBps, BASIS_POINT_SCALE, Math.Rounding.Ceil);
    }

    /// @notice Fee extracted from a gross amount (net = gross - fee).
    /// @dev Used where `_assets` is the gross amount supplied/redeemed (previewDeposit,
    ///      previewRedeem): the fee is carved out so deposit<->mint and withdraw<->redeem
    ///      are exact inverses. Rounds up so the fee favours the vault/holders.
    /// @param _assets The gross amount the fee is extracted from.
    /// @param _feeBps The fee rate in basis points.
    /// @return The fee amount in assets.
    function feeOnTotal(
        uint256 _assets,
        uint16 _feeBps
    ) internal pure returns (uint256) {
        return
            _assets.mulDiv(
                _feeBps,
                _feeBps + BASIS_POINT_SCALE,
                Math.Rounding.Ceil
            );
    }

    /// @notice Linear pro-rata management fee in assets accrued over an elapsed period.
    /// @dev `feeAssets = totalAssets * rateBps * elapsed / (10000 * SECONDS_PER_YEAR)`.
    ///      Clamped strictly below `_totalAssets` so the dilution-share denominator stays
    ///      positive even at extreme rate/time inputs. Returns 0 on any zero input.
    /// @param _totalAssets Gross assets under management at accrual time.
    /// @param _rateBps Management fee rate in basis points.
    /// @param _elapsed Seconds since the last accrual.
    /// @return feeAssets The management fee owed, in assets.
    function managementFeeAssets(
        uint256 _totalAssets,
        uint16 _rateBps,
        uint256 _elapsed
    ) internal pure returns (uint256 feeAssets) {
        if (_totalAssets == 0 || _rateBps == 0 || _elapsed == 0) return 0;

        feeAssets = _totalAssets.mulDiv(
            uint256(_rateBps) * _elapsed,
            BASIS_POINT_SCALE * SECONDS_PER_YEAR,
            Math.Rounding.Floor
        );
        if (feeAssets >= _totalAssets) feeAssets = _totalAssets - 1;
    }

    /// @notice Shares to mint so that minting dilutes existing holders by `_feeAssets`.
    /// @dev Mirrors OZ's offset convention:
    ///      `feeShares = feeAssets * (totalSupply + 10**offset) / (totalAssets + 1 - feeAssets)`,
    ///      rounded down. Returns 0 when there is nothing to dilute or the denominator would
    ///      not be strictly positive (caller is expected to clamp `_feeAssets < _totalAssets`).
    /// @param _feeAssets The fee value, in assets, to convert into dilution shares.
    /// @param _totalSupply Current share supply.
    /// @param _totalAssets Gross assets under management.
    /// @param _decimalsOffset The ERC-4626 virtual-share decimals offset.
    /// @return feeShares The number of shares to mint to the fee recipient.
    function dilutionShares(
        uint256 _feeAssets,
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) internal pure returns (uint256 feeShares) {
        if (_feeAssets == 0 || _totalAssets + 1 <= _feeAssets) return 0;

        feeShares = _feeAssets.mulDiv(
            _totalSupply + 10 ** _decimalsOffset,
            _totalAssets + 1 - _feeAssets,
            Math.Rounding.Floor
        );
    }

    /// @notice Shares for an asset amount, valued against a fee-inclusive effective supply.
    /// @dev OZ's ERC-4626 conversion with the pending dilution fee-shares added to the supply,
    ///      so the result reflects the post-accrual share price.
    /// @param _assets The asset amount to value.
    /// @param _totalSupply Current share supply.
    /// @param _pendingFeeShares Dilution shares pending since the last accrual.
    /// @param _totalAssets Gross assets under management.
    /// @param _decimalsOffset The ERC-4626 virtual-share decimals offset.
    /// @param _rounding Rounding direction.
    /// @return The corresponding share amount.
    function convertToShares(
        uint256 _assets,
        uint256 _totalSupply,
        uint256 _pendingFeeShares,
        uint256 _totalAssets,
        uint8 _decimalsOffset,
        Math.Rounding _rounding
    ) internal pure returns (uint256) {
        return
            _assets.mulDiv(
                _totalSupply + _pendingFeeShares + 10 ** _decimalsOffset,
                _totalAssets + 1,
                _rounding
            );
    }

    /// @notice Assets for a share amount, valued against a fee-inclusive effective supply.
    /// @dev Mirror of `convertToShares`; the effective supply includes the pending dilution
    ///      fee-shares so the result reflects the post-accrual share price.
    /// @param _shares The share amount to value.
    /// @param _totalSupply Current share supply.
    /// @param _pendingFeeShares Dilution shares pending since the last accrual.
    /// @param _totalAssets Gross assets under management.
    /// @param _decimalsOffset The ERC-4626 virtual-share decimals offset.
    /// @param _rounding Rounding direction.
    /// @return The corresponding asset amount.
    function convertToAssets(
        uint256 _shares,
        uint256 _totalSupply,
        uint256 _pendingFeeShares,
        uint256 _totalAssets,
        uint8 _decimalsOffset,
        Math.Rounding _rounding
    ) internal pure returns (uint256) {
        return
            _shares.mulDiv(
                _totalAssets + 1,
                _totalSupply + _pendingFeeShares + 10 ** _decimalsOffset,
                _rounding
            );
    }
}
