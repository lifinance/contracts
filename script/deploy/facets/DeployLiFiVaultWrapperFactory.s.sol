// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";

/// @title DeployLiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys the mock wrapper implementation, its upgradeable beacon, and
///         the vault wrapper factory (mock impl is a temporary stand-in until S1).
/// @dev Deploy order: MockVaultWrapper → UpgradeableBeacon(impl) → LiFiVaultWrapperFactory(beacon, …)
///      Reads OWNER, EMERGENCY_PAUSER, and ONBOARDING_MANAGER from environment.
/// @custom:version 1.0.0
contract DeployScript is Script {
    function run()
        public
        returns (
            LiFiVaultWrapperFactory factory,
            UpgradeableBeacon beacon,
            MockVaultWrapper impl
        )
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address owner = vm.envAddress("OWNER");
        address emergencyPauser = vm.envAddress("EMERGENCY_PAUSER");
        address onboardingManager = vm.envAddress("ONBOARDING_MANAGER");

        vm.startBroadcast(deployerPrivateKey);

        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            emergencyPauser,
            onboardingManager
        );

        vm.stopBroadcast();
    }
}
