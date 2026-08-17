// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFactoryStackBase } from "test/solidity/VaultWrapper/VaultWrapperFactoryStackBase.sol";
import { MockLiquidityCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockLiquidityCappedERC4626.sol";

contract LiFiVaultWrapperLiquidityTest is VaultWrapperFactoryStackBase {
    MockERC20 internal asset;
    MockLiquidityCappedERC4626 internal source;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal integrator = makeAddr("integrator");
    address internal alice = makeAddr("alice");

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        source = new MockLiquidityCappedERC4626(asset, "Yield", "yTKN");

        _bringUpFactory(address(source), [uint16(5000), 1000, 2000, 2000]);
        _deployWrapper(_params());

        asset.mint(alice, 1_000e18);
        vm.startPrank(alice);
        asset.approve(address(wrapper), 1_000e18);
        wrapper.deposit(1_000e18, alice);

        vm.stopPrank();
    }

    function _params() private view returns (DeployParams memory) {
        FeeReceiver[] memory receivers = new FeeReceiver[](1);
        receivers[0] = FeeReceiver({ wallet: integrator, bps: 10000 });

        return
            DeployParams({
                namespace: bytes32("LI.FI-Earn"),
                vaultWrapperAdmin: vaultAdmin,
                adapter: address(adapter),
                underlying: address(source),
                nonce: 0,
                fees: FeeConfig({ rateBps: [uint16(0), 0, 0, 0] }),
                integratorShareBps: [uint16(8000), 8000, 8000, 8000],
                accessGate: address(0),
                receivers: receivers
            });
    }

    function test_MaxRedeemEqualsBalanceWhenSourceUnlimited() public {
        source.setWithdrawable(1_000_000e18);

        assertEq(wrapper.maxRedeem(alice), wrapper.balanceOf(alice));
    }

    function test_MaxRedeemClampsToSourceLiquidity() public {
        source.setWithdrawable(300e18);

        assertLt(wrapper.maxRedeem(alice), wrapper.balanceOf(alice));
        assertApproxEqAbs(
            wrapper.convertToAssets(wrapper.maxRedeem(alice)),
            300e18,
            2
        );
    }

    function test_MaxWithdrawInheritsLiquidityClamp() public {
        source.setWithdrawable(300e18);

        assertApproxEqAbs(wrapper.maxWithdraw(alice), 300e18, 2);
    }

    function test_RedeemAtClampedMaxSucceeds() public {
        source.setWithdrawable(300e18);
        uint256 shares = wrapper.maxRedeem(alice);

        vm.prank(alice);
        uint256 assets = wrapper.redeem(shares, alice, alice);

        assertGt(assets, 0);
        assertApproxEqAbs(assets, 300e18, 2);
    }

    function testRevert_RedeemAboveClampedMax() public {
        source.setWithdrawable(300e18);
        uint256 maxShares = wrapper.maxRedeem(alice);
        uint256 shares = maxShares + 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector,
                alice,
                shares,
                maxShares
            )
        );

        vm.prank(alice);
        wrapper.redeem(shares, alice, alice);
    }

    function test_MaxRedeemIsZeroWhenSourceDry() public {
        source.setWithdrawable(0);

        assertEq(wrapper.maxRedeem(alice), 0);
        assertEq(wrapper.maxWithdraw(alice), 0);
    }
}
