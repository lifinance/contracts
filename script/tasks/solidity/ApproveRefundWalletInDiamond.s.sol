// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

        // approve refundWallet to execute certain functions (as defined in config/global.json)
        // @DEV: this function will fail on Gnosis (several transactions in one run seem to not be accepted by RPC)
        // @DEV: Workaround: approve each function selector in a single script execution
        approveRefundWallet();

        vm.stopBroadcast();
        return true;
    }
}
