// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @title RegisterVaultWrapperImpl
/// @author LI.FI (https://li.fi)
/// @notice Points the UpgradeableBeacon at a new wrapper implementation,
///         atomically upgrading every existing clone. Must be called by the
///         beacon owner (governance; the 48h timelock once S10 lands).
/// @dev Reads BEACON and NEW_IMPL from environment. In production this call is
///      scheduled/executed through the timelock; here it is the raw payload.
/// @custom:version 1.0.0
contract DeployScript is Script {
    error ZeroPrivateKey();
    error ZeroBeacon();
    error ZeroImpl();

    function run() public {
        uint256 ownerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address beaconAddress = vm.envAddress("BEACON");
        address newImpl = vm.envAddress("NEW_IMPL");

        if (ownerPrivateKey == 0) revert ZeroPrivateKey();
        if (beaconAddress == address(0)) revert ZeroBeacon();
        if (newImpl == address(0)) revert ZeroImpl();

        vm.startBroadcast(ownerPrivateKey);
        UpgradeableBeacon(beaconAddress).upgradeTo(newImpl);
        vm.stopBroadcast();
    }
}
