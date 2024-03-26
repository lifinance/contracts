// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";

contract DeployWormholeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "WormholeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(WormholeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/wormhole.json");
        string memory json = vm.readFile(path);

        address wormholeRouter = json.readAddress(
            string.concat(".routers.", _network)
        );

        return abi.encode(wormholeRouter);
    }
}
