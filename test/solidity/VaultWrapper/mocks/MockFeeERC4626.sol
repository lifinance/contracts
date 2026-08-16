// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { FixedPointMathLib } from "solmate/utils/FixedPointMathLib.sol";
import { SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

/// @notice Compliant ERC-4626 charging a bps exit fee whose assets LEAVE the vault (to
///         `feeSink`). Exact-out `withdraw` delivers exactly `assets` (burning grossed-up
///         shares); exact-in `redeem` delivers the net; both send the fee to `feeSink` so
///         a sole depositor's redeemable claim actually shrinks. Used to prove the wrapper
///         charges a source exit fee to the exiting user, not remaining holders.
contract MockFeeERC4626 is MockERC4626 {
    using FixedPointMathLib for uint256;
    using SafeTransferLib for ERC20;

    uint256 public immutable EXIT_FEE_BPS; // 100 = 1%
    address public immutable FEE_SINK;

    constructor(
        ERC20 _asset,
        string memory _name,
        string memory _symbol,
        uint256 _exitFeeBps,
        address _feeSink
    ) MockERC4626(_asset, _name, _symbol) {
        EXIT_FEE_BPS = _exitFeeBps;
        FEE_SINK = _feeSink;
    }

    function _exitFee(uint256 gross) internal view returns (uint256) {
        return gross.mulDivUp(EXIT_FEE_BPS, 10_000);
    }

    /// @dev Exact-in: net of the exit fee.
    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256) {
        uint256 gross = super.previewRedeem(shares);
        return gross - _exitFee(gross);
    }

    /// @dev Exact-out: grossed-up shares so the net delivered equals `assets`.
    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        uint256 gross = assets.mulDivUp(10_000, 10_000 - EXIT_FEE_BPS);
        return super.previewWithdraw(gross);
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        return previewRedeem(balanceOf[owner]);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256 assets) {
        uint256 gross = super.previewRedeem(shares);
        uint256 fee = _exitFee(gross);
        assets = gross - fee;

        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max)
                allowance[owner][msg.sender] = allowed - shares;
        }
        _burn(owner, shares);
        asset.safeTransfer(receiver, assets);
        asset.safeTransfer(FEE_SINK, fee);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256 shares) {
        shares = previewWithdraw(assets);
        // Fee basis mirrors previewWithdraw's grossing, so `fee` is exactly the bps
        // fee; any share/asset rounding surplus stays in the vault, not the sink.
        uint256 gross = assets.mulDivUp(10_000, 10_000 - EXIT_FEE_BPS);
        uint256 fee = gross - assets;

        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max)
                allowance[owner][msg.sender] = allowed - shares;
        }
        _burn(owner, shares);
        asset.safeTransfer(receiver, assets);
        asset.safeTransfer(FEE_SINK, fee);
    }
}
