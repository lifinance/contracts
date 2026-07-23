// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";
import { MockERC4626Underlying } from "../mocks/MockERC4626Underlying.sol";
import { MockLossyERC4626 } from "../mocks/MockLossyERC4626.sol";
import { MockCappedERC4626 } from "../mocks/MockCappedERC4626.sol";

/// @dev Runs the adapter's delegatecall-only methods in its own storage context, the
///      way a wrapper would (the harness holds the source position).
contract AdapterCallHarness {
    error AdapterCallFailed();

    function route(
        address _adapter,
        bytes memory _data
    ) external returns (uint256 result) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory ret) = _adapter.delegatecall(_data);
        if (!ok) revert AdapterCallFailed();
        result = abi.decode(ret, (uint256));
    }
}

contract ERC4626AdapterTest is Test {
    ERC4626Adapter internal adapter;
    MockERC20 internal token;
    MockERC4626 internal source;
    AdapterCallHarness internal harness;
    address internal assetToken = makeAddr("asset");
    address internal holder = makeAddr("holder");

    function setUp() public {
        adapter = new ERC4626Adapter();
        token = new MockERC20("Token", "TKN", 18);
        source = new MockERC4626(token, "Yield", "yTKN");
        harness = new AdapterCallHarness();
    }

    /// resolveAsset (existing behavior) ///

    function test_ResolveAssetReturnsAssetForValidVault() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(assetToken);
        assertEq(adapter.resolveAsset(address(vault)), assetToken);
    }

    function test_ResolveAssetRevertsOnNoCode() public {
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(makeAddr("eoa"));
    }

    function test_ResolveAssetRevertsOnZeroAsset() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(address(0));
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(address(vault));
    }

    /// max* passthrough ///

    function test_MaxDepositPassesThroughSourceCap() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        capped.setDepositCap(500e18);

        assertEq(adapter.maxDeposit(address(capped), holder), 500e18);
        assertEq(
            adapter.maxDeposit(address(source), holder),
            type(uint256).max
        );
    }

    function test_MaxWithdrawPassesThroughSourceLiquidity() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        _seed(address(capped), holder, 1_000e18);
        capped.setLiquidity(300e18);

        assertEq(adapter.maxWithdraw(address(capped), holder), 300e18);
    }

    function test_MaxViewsFallBackToZeroWhenSourceViewReverts() public {
        MockCappedERC4626 capped = new MockCappedERC4626(token);
        capped.setRevertOnLimitViews(true);

        assertEq(adapter.maxDeposit(address(capped), holder), 0);
        assertEq(adapter.maxWithdraw(address(capped), holder), 0);
    }

    function test_MaxViewsFallBackToZeroWhenUnderlyingHasNoCode() public {
        address eoa = makeAddr("underlyingEoa");

        assertEq(adapter.maxDeposit(eoa, holder), 0);
        assertEq(adapter.maxWithdraw(eoa, holder), 0);
    }

    /// previewWithdrawUpTo ///

    function test_PreviewWithdrawUpToMatchesRequestOnStandardSource() public {
        _seed(address(source), holder, 1_000e18);

        assertEq(
            adapter.previewWithdrawUpTo(address(source), holder, 400e18),
            400e18
        );
    }

    function test_PreviewWithdrawUpToCapsAtHolderPosition() public {
        _seed(address(source), holder, 100e18);

        // Requesting more than the position realizes only the position.
        assertEq(
            adapter.previewWithdrawUpTo(address(source), holder, 400e18),
            100e18
        );
    }

    function test_PreviewWithdrawUpToNetsSourceExitFee() public {
        // A lossy source grosses exact-out requests up itself, so a within-position
        // target still realizes in full; make the position smaller than the target
        // to force the whole-position haircut visible.
        MockLossyERC4626 small = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(small), holder, 100e18);
        uint256 realizable = adapter.previewWithdrawUpTo(
            address(small),
            holder,
            400e18
        );

        // Whole position redeemed, 1% fee carved out: 99e18.
        assertEq(realizable, 99e18);
    }

    /// previewWithdrawCost ///

    function test_PreviewWithdrawCostEqualsRequestOnStandardSource() public {
        _seed(address(source), holder, 1_000e18);

        assertEq(adapter.previewWithdrawCost(address(source), 400e18), 400e18);
    }

    function test_PreviewWithdrawCostExceedsRequestOnLossySource() public {
        MockLossyERC4626 lossy = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(lossy), holder, 1_000e18);

        uint256 cost = adapter.previewWithdrawCost(address(lossy), 396e18);

        // Delivering 396e18 exact-out burns shares worth ~400e18 (1% fee grossed up).
        assertGt(cost, 396e18);
        assertApproxEqAbs(cost, 400e18, 2);
    }

    /// withdrawUpTo (delegatecall) ///

    function test_WithdrawUpToRealizesRequestOnStandardSource() public {
        _seed(address(source), address(harness), 1_000e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, 400e18);
        assertEq(token.balanceOf(address(harness)), 400e18);
    }

    function test_WithdrawUpToCapsAtPositionInsteadOfReverting() public {
        _seed(address(source), address(harness), 100e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, 100e18);
    }

    function test_WithdrawUpToReturnsActualProceedsFromLossySource() public {
        MockLossyERC4626 lossy = new MockLossyERC4626(token, 100); // 1% exit fee
        _seed(address(lossy), address(harness), 100e18);

        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(lossy), 400e18)
            )
        );

        // Whole position, 1% source fee carved out.
        assertEq(withdrawn, 99e18);
        assertEq(token.balanceOf(address(harness)), 99e18);
    }

    function test_WithdrawUpToReturnsZeroOnEmptyPosition() public {
        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, 0);
        assertEq(token.balanceOf(address(harness)), 0);
    }

    function test_WithdrawUpToAtInflatedSharePriceNeverOvershoots() public {
        _seed(address(source), address(harness), 1_000e18);
        token.mint(address(source), 333e18); // donation: PPS now non-integer

        uint256 quoted = adapter.previewWithdrawUpTo(
            address(source),
            address(harness),
            400e18
        );
        uint256 withdrawn = harness.route(
            address(adapter),
            abi.encodeCall(
                IYieldAdapter.withdrawUpTo,
                (address(token), address(source), 400e18)
            )
        );

        assertEq(withdrawn, quoted);
        assertLe(withdrawn, 400e18);
    }

    /// Helpers ///

    function _seed(
        address _vault,
        address _receiver,
        uint256 _amount
    ) internal {
        token.mint(address(this), _amount);
        token.approve(_vault, _amount);
        MockERC4626(_vault).deposit(_amount, _receiver);
    }
}
