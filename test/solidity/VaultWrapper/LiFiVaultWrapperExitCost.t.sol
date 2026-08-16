// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { defaultReceivers } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";
import { MockFeeERC4626 } from "test/solidity/VaultWrapper/mocks/MockFeeERC4626.sol";

/// @notice Regression coverage for cost-aware exact-out `previewWithdraw`: when the
///         underlying yield source charges an exit fee, the wrapper must price the
///         exiting caller's share burn off the position value the source actually
///         consumes, not off the requested assets alone — otherwise the source's exit
///         fee is socialized onto remaining holders instead of being paid by the exiter.
contract LiFiVaultWrapperExitCostTest is Test {
    MockERC20 internal asset;
    MockFeeERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal sourceFeeSink = makeAddr("sourceFeeSink");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint256 internal constant SOURCE_FEE_BPS = 100; // 1%

    /// @dev This test contract is the `factory` (it deploys the beacon proxies), so the
    ///      wrapper reads the global circuit breaker back from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockFeeERC4626(
            asset,
            "Yield Token",
            "yTKN",
            SOURCE_FEE_BPS,
            sourceFeeSink
        );
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper(address(this))),
            address(this)
        );
        wrapper = _newWrapper(address(underlying));
    }

    function test_WithdrawDoesNotDiluteRemainingHolder() public {
        _deposit(alice, DEPOSIT);
        _deposit(bob, DEPOSIT);

        uint256 bobClaimBefore = wrapper.convertToAssets(
            wrapper.balanceOf(bob)
        );

        vm.prank(alice);
        wrapper.withdraw(500e18, alice, alice);

        uint256 bobClaimAfter = wrapper.convertToAssets(
            wrapper.balanceOf(bob)
        );

        assertApproxEqAbs(bobClaimAfter, bobClaimBefore, 2);
    }

    /// Helpers ///

    function _splits8000() internal pure returns (uint16[4] memory) {
        return [uint16(8000), 8000, 8000, 8000];
    }

    function _newWrapper(
        address _underlying
    ) internal returns (LiFiVaultWrapper w) {
        FeeConfig memory fees; // all wrapper fees 0 -> isolates the SOURCE fee
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                _underlying,
                address(adapter),
                vaultAdmin,
                _splits8000(),
                fees,
                defaultReceivers(),
                address(0)
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }
}
