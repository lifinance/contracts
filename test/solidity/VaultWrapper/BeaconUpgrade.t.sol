// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";
import { MockVaultWrapperV2 } from "./mocks/MockVaultWrapperV2.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { MockERC4626Underlying } from "./mocks/MockERC4626Underlying.sol";
import { DeployParams, FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

contract BeaconUpgradeTest is Test {
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    MockVaultWrapper internal implV1;
    MockVaultWrapperV2 internal implV2;
    ERC4626Adapter internal adapter;
    MockERC4626Underlying internal underlying;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal assetToken = makeAddr("asset");
    bytes32 internal constant NS = bytes32("Coinbase");

    function setUp() public {
        implV1 = new MockVaultWrapper();
        implV2 = new MockVaultWrapperV2();
        beacon = new UpgradeableBeacon(address(implV1));
        beacon.transferOwnership(owner);
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            pauser,
            onboarder,
            lifiRecipient
        );
        adapter = new ERC4626Adapter();
        underlying = new MockERC4626Underlying(assetToken);
        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        vm.stopPrank();
    }

    function _deployClone(uint256 nonce_) internal returns (address) {
        FeeConfig memory fees;
        DeployParams memory params = DeployParams({
            namespace: NS,
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: nonce_,
            fees: fees,
            integratorShareBps: type(uint16).max,
            initData: ""
        });
        vm.prank(onboarder);
        return factory.deploy(params);
    }

    function test_CloneDelegatesToCurrentImpl() public {
        address clone = _deployClone(0);
        assertEq(MockVaultWrapper(clone).name(), "Mock Vault Wrapper");
        assertEq(beacon.implementation(), address(implV1));
    }

    function test_UpgradePropagatesToAllExistingClones() public {
        address cloneA = _deployClone(0);
        address cloneB = _deployClone(1);

        // V1 has no version() selector — the call reverts before the upgrade.
        vm.expectRevert();
        MockVaultWrapperV2(cloneA).version();

        vm.prank(owner);
        beacon.upgradeTo(address(implV2));

        assertEq(beacon.implementation(), address(implV2));
        assertEq(MockVaultWrapperV2(cloneA).version(), 2);
        assertEq(MockVaultWrapperV2(cloneB).version(), 2);

        address cloneC = _deployClone(2);
        assertEq(MockVaultWrapperV2(cloneC).version(), 2);
    }

    function test_OnlyOwnerCanUpgrade() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        beacon.upgradeTo(address(implV2));

        assertEq(beacon.implementation(), address(implV1));
    }

    function test_UpgradeToNonContractReverts() public {
        vm.prank(owner);
        vm.expectRevert("UpgradeableBeacon: implementation is not a contract");
        beacon.upgradeTo(makeAddr("eoa"));
    }
}
