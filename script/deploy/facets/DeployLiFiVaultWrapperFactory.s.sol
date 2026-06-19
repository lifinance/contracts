// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";

/// @title DeployLiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys the mock wrapper implementation, its upgradeable beacon, the
///         vault wrapper factory (mock impl is a temporary stand-in until S1), and
///         the ERC-4626 yield adapter.
/// @dev Deploy order: MockVaultWrapper → UpgradeableBeacon(impl) → LiFiVaultWrapperFactory(beacon, …) → ERC4626Adapter
///      Reads OWNER, EMERGENCY_PAUSER, ONBOARDING_MANAGER, and LIFI_FEE_RECIPIENT from environment.
///      The deployer key (PRIVATE_KEY) is not the governance owner, so this script
///      cannot approve the adapter or allowlist underlyings. After deployment,
///      governance must call setAdapterApproved(adapter) and setUnderlyingAllowed(underlying)
///      on the factory before any wrapper can be deployed.
/// @custom:version 1.0.0
contract DeployScript is Script {
    error ZeroPrivateKey();
    error ZeroOwner();
    error ZeroEmergencyPauser();
    error ZeroOnboardingManager();
    error ZeroLifiFeeRecipient();

    function run()
        public
        returns (
            LiFiVaultWrapperFactory factory,
            UpgradeableBeacon beacon,
            MockVaultWrapper impl,
            ERC4626Adapter erc4626Adapter
        )
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address owner = vm.envAddress("OWNER");
        address emergencyPauser = vm.envAddress("EMERGENCY_PAUSER");
        address onboardingManager = vm.envAddress("ONBOARDING_MANAGER");
        address lifiFeeRecipient = vm.envAddress("LIFI_FEE_RECIPIENT");

        if (deployerPrivateKey == 0) revert ZeroPrivateKey();
        if (owner == address(0)) revert ZeroOwner();
        if (emergencyPauser == address(0)) revert ZeroEmergencyPauser();
        if (onboardingManager == address(0)) revert ZeroOnboardingManager();
        if (lifiFeeRecipient == address(0)) revert ZeroLifiFeeRecipient();

        vm.startBroadcast(deployerPrivateKey);

        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        beacon.transferOwnership(owner);
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            emergencyPauser,
            onboardingManager,
            lifiFeeRecipient
        );
        erc4626Adapter = new ERC4626Adapter();

        vm.stopBroadcast();
    }
}
