// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PioneerFacet } from "lifi/Facets/PioneerFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    error PioneerAddress0();

    constructor() DeployScriptBase("PioneerFacet") {}

    function run()
        public
        returns (PioneerFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = PioneerFacet(
            deploy(
                abi.encodePacked(
                    type(PioneerFacet).creationCode,
                    constructorArgs
                )
            )
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/pioneer.json");
        string memory json = vm.readFile(path);

        // If you need to read an address from your config file or from a network deploy log that is supposed to be a contract, use the
        // following helper function which makes sure that the address contains code (and has a optional flag for allowing address(0)):
        //
        // address example = _getConfigContractAddress(json,string.concat(".", network, ".example"));
        //
        // in the address is not a supposed to be an EOA, you can use the following standard approach:
        address pioneer = json.readAddress(
            string.concat(".", network, ".PIONEER_ADDRESS")
        );

        if (pioneer == address(0)) revert PioneerAddress0();

        return abi.encode(pioneer);
    }
}
