// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase, console } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (bool)
    {
        vm.startBroadcast(deployerPrivateKey);

        // approve refundWallet to execute certain functions (as defined in config/global.json)
        // exclude this step for localanvil network. Does not work there for some reason
        if (
            keccak256(abi.encodePacked(network)) !=
            keccak256(abi.encodePacked("localanvil"))
        ) approveRefundWallet();

        vm.stopBroadcast();
        return true;
    }
}
