// SPDX-License-Identifier: UNLICENSED
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

        // If you need to read an address from your config file or from a network deploy log that is supposed to be a contract, use the
        // following helper function which makes sure that the address contains code (and has a optional flag for allowing address(0)):
        //
        // address example = _getConfigContractAddress(json,string.concat(".", network, ".example"));
        //
        // in the address is not a supposed to be an EOA, you can use the following standard approach:
        address compact = json.readAddress(".COMPACT");
        address lifiIntentCompactSettler = json.readAddress(
            ".LIFI_ESCROW_INPUT_SETTLER"
        );

        return abi.encode(compact, lifiIntentCompactSettler);
    }
}
