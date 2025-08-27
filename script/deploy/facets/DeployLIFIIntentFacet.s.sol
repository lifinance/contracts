// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LIFIIntentFacet } from "lifi/Facets/LIFIIntentFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LIFIIntentFacet") {}

    function run()
        public
        returns (LIFIIntentFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LIFIIntentFacet(deploy(type(LIFIIntentFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/lifiintent.json");
        string memory json = vm.readFile(path);

        // If you need to read an address from your config file or from a network deploy log that is supposed to be a contract, use the
        // following helper function which makes sure that the address contains code (and has a optional flag for allowing address(0)):
        //
        // address example = _getConfigContractAddress(json,string.concat(".", network, ".example"));
        //
        // in the address is not a supposed to be an EOA, you can use the following standard approach:
        address compact = json.readAddress(".COMPACT");
        address lifiIntentCompactSettler = json.readAddress(
            ".LIFI_COMPACT_INPUT_SETTLER"
        );

        return abi.encode(compact, lifiIntentCompactSettler);
    }
}
