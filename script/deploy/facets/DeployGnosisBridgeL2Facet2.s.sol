// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeL2Facet } from "lifi/Facets/GnosisBridgeL2Facet.sol";

contract DeployGnosisBridgeL2Facet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "GnosisBridgeL2Facet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(GnosisBridgeL2Facet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/gnosis.json");
        string memory json = vm.readFile(path);

        address xDaiBridge = json.readAddress(
            string.concat(".", _network, ".xDaiBridge")
        );

        return abi.encode(xDaiBridge);
    }
}
