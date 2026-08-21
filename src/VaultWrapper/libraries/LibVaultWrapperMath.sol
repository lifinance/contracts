// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LibVaultWrapperMath
/// @author LI.FI (https://li.fi)
/// @notice Stateless arithmetic for the LI.FI vault wrapper fee engine: asset-side
///         deposit/withdrawal fees (the fee is a percentage of the net amount, so gross =
///         net + fee), time-based management-fee dilution, high-water-mark performance-fee
///         dilution, and the fee-inclusive share/asset conversions. Centralizing the math
///         here gives auditing and fuzzing a single, side-effect-free surface; all state,
///         minting, and routing stay in the wrapper.
/// @custom:version 1.0.0
library LibVaultWrapperMath {
    using Math for uint256;

    /// @notice Basis-point denominator (100% = 10000 bps).
    uint256 internal constant BASIS_POINT_SCALE = 10_000;

    /// @notice Seconds in a fee year, fixed at 365 days for management accrual.
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @notice Fixed-point scale of the price-per-share values (`pricePerShare` results
    ///         and the performance-fee high-water mark).
    /// @dev The performance fee measures gains on this grid AND anchors its watermark on
    ///      it, so one unit of the grid is the smallest gain the fee can see: a coarse grid
    ///      turns per-accrual rounding into a real slice of AUM, and accrual frequency is
    ///      caller-controlled (`distributeFees` is permissionless). One unit is
    ///      `10 ** offset / PPS_SCALE` of AUM, so `10 ** -(assetDecimals + 6)` while the
    ///      offset tracks `18 - assetDecimals`, and finer once it bottoms out at
    ///      `MIN_DECIMALS_OFFSET`: 1e-10 of AUM for a 4-decimal asset (the coarsest
    ///      onboarded), 1e-12 at 6 decimals, which even one block of yield clears. At 1e18
    ///      it was `10 ** -assetDecimals`: a whole USDC on a 1M USDC vault, which ordinary
    ///      traffic crosses every few minutes. Headroom: par pps is
    ///      `PPS_SCALE / 10 ** offset` (1e6..1e18 across the supported offsets) against the
    ///      watermark's `uint192` ceiling of ~6.3e57.
    uint256 internal constant PPS_SCALE = 1e24;

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

    /// @notice Price per share as a `PPS_SCALE`-scaled fixed-point value, rounded down.
    /// @dev `convertToAssets(PPS_SCALE)` under OZ's virtual-offset convention:
    ///      `pps = (totalAssets + 1) * PPS_SCALE / (totalSupply + 10**offset)`. The same
    ///      convention as the share/asset conversions so the performance watermark is
    ///      measured on exactly the price depositors transact at. Floored throughout:
    ///      gain measurement and the watermark ratchet must share one rounding direction,
    ///      or the mark lands off the price the fee was measured at and the gap is either
    ///      re-charged or forgiven on the next accrual.
    /// @param _totalSupply Current share supply.
    /// @param _totalAssets Gross assets under management.
    /// @param _decimalsOffset The ERC-4626 virtual-share decimals offset.
    /// @return The current price per share, scaled by `PPS_SCALE`.
    function pricePerShare(
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) internal pure returns (uint256) {
        return
            (_totalAssets + 1).mulDiv(
                PPS_SCALE,
                _totalSupply + 10 ** _decimalsOffset,
                Math.Rounding.Floor
            );
    }

    /// @notice Performance fee in assets on the share-price gain above a high-water mark.
    /// @dev `gainAssets = totalSupply * (pps - hwm) / PPS_SCALE` (only real holder shares
    ///      participate; the virtual offset shares are excluded), then
    ///      `feeAssets = feeOnRaw(gainAssets, rateBps)`. Returns 0 when the current price
    ///      per share is at or below the watermark, so a net loss is never charged.
    ///      Clamped strictly below `_totalAssets` so the dilution-share denominator stays
    ///      positive even at extreme watermark/rate inputs.
    ///      Precision: the price per share is a floored `PPS_SCALE`-scaled integer, so a
    ///      gain smaller than one unit of that grid leaves it unchanged and accrues nothing
    ///      that round; the gain stays in AUM and is charged once cumulative gains cross a
    ///      unit. `PPS_SCALE` is sized so that unit is far below one block of yield for
    ///      every onboardable asset (see its doc), so the fee an accrual sequence collects
    ///      does not depend on how often it is taken.
    /// @param _totalAssets Gross assets under management at accrual time.
    /// @param _totalSupply Current share supply.
    /// @param _hwmPps The high-water mark, a `PPS_SCALE`-scaled price per share.
    /// @param _rateBps Performance fee rate in basis points.
    /// @param _decimalsOffset The ERC-4626 virtual-share decimals offset.
    /// @return feeAssets The performance fee owed, in assets.
    function performanceFeeAssets(
        uint256 _totalAssets,
        uint256 _totalSupply,
        uint256 _hwmPps,
        uint16 _rateBps,
        uint8 _decimalsOffset
    ) internal pure returns (uint256 feeAssets) {
        if (_totalAssets == 0 || _totalSupply == 0 || _rateBps == 0) return 0;

        uint256 pps = pricePerShare(
            _totalSupply,
            _totalAssets,
            _decimalsOffset
        );
        if (pps <= _hwmPps) return 0;

        uint256 gainAssets = _totalSupply.mulDiv(
            pps - _hwmPps,
            PPS_SCALE,
            Math.Rounding.Floor
        );
        feeAssets = feeOnRaw(gainAssets, _rateBps);
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
