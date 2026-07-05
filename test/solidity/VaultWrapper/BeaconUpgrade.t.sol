// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { MockERC4626Underlying } from "./mocks/MockERC4626Underlying.sol";
import { DeployParams, FeeConfig, IntegratorReceivers } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Upgrade target proving a beacon upgrade is observable through clones:
///         inherits LiFiVaultWrapper (identical storage + interface) and adds a
///         version() selector absent from V1.
contract MockVaultWrapperV2 is LiFiVaultWrapper {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract BeaconUpgradeTest is Test {
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal implV1;
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

    function setUp() public virtual {
        implV1 = new LiFiVaultWrapper();
        implV2 = new MockVaultWrapperV2();
        beacon = new UpgradeableBeacon(address(implV1), address(this));
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
        address[] memory wallets = new address[](1);
        wallets[0] = address(0xFEE1);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        DeployParams memory params = DeployParams({
            namespace: NS,
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: nonce_,
            fees: fees,
            integratorShareBps: [
                type(uint16).max,
                type(uint16).max,
                type(uint16).max,
                type(uint16).max
            ],
            initData: "",
            receivers: IntegratorReceivers({ wallets: wallets, bps: bps })
        });
        vm.prank(onboarder);
        return factory.deploy(params);
    }

    function test_CloneDelegatesToCurrentImpl() public {
        address clone = _deployClone(0);
        assertEq(LiFiVaultWrapper(clone).name(), "LI.FI Earn VW");
        assertEq(beacon.implementation(), address(implV1));
    }

    function test_UpgradePropagatesToAllExistingClones() public {
        address cloneA = _deployClone(0);
        address cloneB = _deployClone(1);

        // V1 has no version() selector — empty revert; bare expectRevert() is intentional.
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
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                attacker
            )
        );
        beacon.upgradeTo(address(implV2));

        assertEq(beacon.implementation(), address(implV1));
    }

    function test_UpgradeToNonContractReverts() public {
        address eoa = makeAddr("eoa");

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                UpgradeableBeacon.BeaconInvalidImplementation.selector,
                eoa
            )
        );
        beacon.upgradeTo(eoa);
    }
}
