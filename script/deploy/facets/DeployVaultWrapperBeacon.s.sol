// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";

/// @title DeployVaultWrapperBeacon
/// @author LI.FI (https://li.fi)
/// @notice Deploys the wrapper implementation and its UpgradeableBeacon, then
///         transfers beacon ownership to the governance owner. The mock impl is
///         a temporary stand-in until S1. Reads OWNER from environment.
/// @dev Deploy order: MockVaultWrapper → UpgradeableBeacon(impl) → transferOwnership(OWNER).
///      Gating the beacon owner behind the 48h timelock is S10 (EXSC-418).
/// @custom:version 1.0.0
contract DeployScript is Script {
    error ZeroPrivateKey();
    error ZeroOwner();

    function run()
        public
        returns (UpgradeableBeacon beacon, MockVaultWrapper impl)
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address owner = vm.envAddress("OWNER");

        if (deployerPrivateKey == 0) revert ZeroPrivateKey();
        if (owner == address(0)) revert ZeroOwner();

        vm.startBroadcast(deployerPrivateKey);
        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        beacon.transferOwnership(owner);
        vm.stopBroadcast();
    }
}
