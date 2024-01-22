// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";

contract DeployHyphenFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "HyphenFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(HyphenFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/hyphen.json");
        string memory json = vm.readFile(path);

        address hyphenRouter = json.readAddress(
            string.concat(".", _network, ".hyphenRouter")
        );

        return abi.encode(hyphenRouter);
    }
}
