// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";

/// @title DeployLiFiVaultWrapperFactory
/// @author LI.FI (https://li.fi)
/// @notice Deploys and wires the vault wrapper system: the dedicated 48h timelock,
///         the vault wrapper implementation, its upgradeable beacon, the vault wrapper
///         factory, and the ERC-4626 yield adapter. The timelock owns both the factory
///         and the beacon, so every factory slow-path call and every beacon upgrade is
///         gated by the 48h delay.
/// @dev Deploy order: TimelockController → LiFiVaultWrapper → UpgradeableBeacon(impl) →
///      LiFiVaultWrapperFactory(beacon, owner=timelock, …) → ERC4626Adapter, with the
///      beacon ownership transferred to the timelock.
///      Timelock roles: the LI.FI multisig is proposer AND canceller (OZ grants both to
///      each proposer); the executor role is open (address(0)); the optional admin is
///      renounced (address(0)), so the timelock is self-administered.
///      Reads MULTISIG, EMERGENCY_PAUSER, ONBOARDING_MANAGER, and LIFI_FEE_RECIPIENT from
///      environment. Because the factory owner is the 48h timelock, post-deploy governance
///      actions — setAdapterApproved(adapter) and setUnderlyingAllowed(underlying), required
///      before any wrapper can be deployed — must be scheduled through the timelock.
///      Full DeployScriptBase / CREATE3 / deployment-log integration is S14 (EXSC-420).
/// @custom:version 1.2.0
contract DeployLiFiVaultWrapperFactory is Script {
    /// @notice The dedicated governance delay for the vault wrapper subsystem.
    uint256 internal constant MIN_DELAY = 48 hours;

    error ZeroPrivateKey();
    error ZeroMultisig();
    error ZeroEmergencyPauser();
    error ZeroOnboardingManager();
    error ZeroLifiFeeRecipient();

    function run()
        public
        returns (
            LiFiVaultWrapperFactory factory,
            TimelockController timelock,
            UpgradeableBeacon beacon,
            LiFiVaultWrapper impl,
            ERC4626Adapter erc4626Adapter
        )
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address multisig = vm.envAddress("MULTISIG");
        address emergencyPauser = vm.envAddress("EMERGENCY_PAUSER");
        address onboardingManager = vm.envAddress("ONBOARDING_MANAGER");
        address lifiFeeRecipient = vm.envAddress("LIFI_FEE_RECIPIENT");

        if (deployerPrivateKey == 0) revert ZeroPrivateKey();
        if (multisig == address(0)) revert ZeroMultisig();
        if (emergencyPauser == address(0)) revert ZeroEmergencyPauser();
        if (onboardingManager == address(0)) revert ZeroOnboardingManager();
        if (lifiFeeRecipient == address(0)) revert ZeroLifiFeeRecipient();

        address[] memory proposers = new address[](1);
        proposers[0] = multisig;

        address[] memory executors = new address[](1);
        executors[0] = address(0);

        vm.startBroadcast(deployerPrivateKey);

        timelock = new TimelockController(
            MIN_DELAY,
            proposers,
            executors,
            address(0)
        );

        impl = new LiFiVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        beacon.transferOwnership(address(timelock));
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            address(timelock),
            emergencyPauser,
            onboardingManager,
            lifiFeeRecipient
        );
        erc4626Adapter = new ERC4626Adapter();

        vm.stopBroadcast();
    }
}
