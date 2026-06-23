// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DeployVaultWrapperTimelock
/// @author LI.FI (https://li.fi)
/// @notice Deploys the dedicated 48h vanilla OpenZeppelin TimelockController that
///         governs the vault wrapper subsystem (factory slow-path + beacon upgrades).
/// @dev Vanilla OZ TimelockController (not LiFiTimelockController, which is a 3h
///      Diamond-coupled instance). Roles: the LI.FI multisig is proposer AND
///      canceller (OZ grants both to each proposer); the executor role is open
///      (address(0)), so anyone may execute a queued operation once the 48h delay
///      elapses; the optional admin is renounced (address(0)), leaving the timelock
///      self-administered.
///
///      Wiring: deploy this first, then run DeployLiFiVaultWrapperFactory with
///      OWNER set to the address deployed here. That makes the timelock both the
///      factory owner (gating every onlyOwner slow-path config call) and the beacon
///      owner (gating UpgradeableBeacon.upgradeTo). The emergency pauser stays a
///      separate role so the circuit breaker fires without the 48h delay.
///
///      Reads MULTISIG (the LI.FI Safe, proposer/canceller) from environment.
///      Full DeployScriptBase / CREATE3 / deployment-log integration is S14 (EXSC-420).
/// @custom:version 1.0.0
contract DeployScript is Script {
    /// @notice The dedicated governance delay for the vault wrapper subsystem.
    uint256 internal constant MIN_DELAY = 48 hours;

    error ZeroPrivateKey();
    error ZeroMultisig();

    function run() public returns (TimelockController timelock) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address multisig = vm.envAddress("MULTISIG");

        if (deployerPrivateKey == 0) revert ZeroPrivateKey();
        if (multisig == address(0)) revert ZeroMultisig();

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

        vm.stopBroadcast();
    }
}
