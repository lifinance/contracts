// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LIFIIntentEscrowFacet } from "lifi/Facets/LIFIIntentEscrowFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LIFIIntentEscrowFacet") {}

    function run()
        public
        returns (LIFIIntentEscrowFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LIFIIntentEscrowFacet(
            deploy(type(LIFIIntentEscrowFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/lifiintent.json");
        string memory json = vm.readFile(path);

        address lifiIntentEscrowSettler = json.readAddress(
            ".LIFI_ESCROW_INPUT_SETTLER"
        );

        return abi.encode(lifiIntentEscrowSettler);
    }
}
