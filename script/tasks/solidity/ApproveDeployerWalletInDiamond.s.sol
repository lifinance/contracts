// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

        // approve deployerWallet to execute certain functions (as defined in config/global.json)
        // exclude this step for localanvil network. Does not work there for some reason

        // @DEV: this function will fail on Gnosis (several transactions in one run seem to not be accepted by RPC)
        // @DEV: Workaround: approve each function selector in a single script execution
        if (
            keccak256(abi.encodePacked(network)) !=
            keccak256(abi.encodePacked("localanvil"))
        ) approveDeployerWallet();

        vm.stopBroadcast();
        return true;
    }
}
