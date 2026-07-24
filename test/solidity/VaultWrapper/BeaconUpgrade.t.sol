// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { MockERC4626Underlying } from "./mocks/MockERC4626Underlying.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { DeployParams, FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { defaultReceivers } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";

/// @notice Upgrade target proving a beacon upgrade is observable through clones:
///         inherits LiFiVaultWrapper (identical storage + interface) and adds a
///         version() selector absent from V1.
contract MockVaultWrapperV2 is LiFiVaultWrapper {
    constructor(address _expectedFactory) LiFiVaultWrapper(_expectedFactory) {}

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
    address internal assetToken = address(new MockERC20("Asset", "AST", 18));
    bytes32 internal constant NS = bytes32("Coinbase");

    function setUp() public virtual {
        // The factory is the fourth CREATE in this setUp (implV1, implV2, beacon,
        // factory); both implementations bind that factory at construction.
        address predictedFactory = vm.computeCreateAddress(
            address(this),
            vm.getNonce(address(this)) + 3
        );
        implV1 = new LiFiVaultWrapper(predictedFactory);
        implV2 = new MockVaultWrapperV2(predictedFactory);
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
            accessGate: address(0),
            receivers: defaultReceivers()
        });
        vm.prank(onboarder);
        return factory.deploy(params);
    }

    function test_CloneDelegatesToCurrentImpl() public {
        address clone = _deployClone(0);
        assertEq(LiFiVaultWrapper(clone).name(), "LI.FI Earn AST");
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
