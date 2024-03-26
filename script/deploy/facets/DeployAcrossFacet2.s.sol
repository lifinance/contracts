// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";

contract DeployAcrossFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "AcrossFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(AcrossFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/across.json");
        string memory json = vm.readFile(path);

        address acrossSpokePool = json.readAddress(
            string.concat(".", _network, ".acrossSpokePool")
        );
        address weth = json.readAddress(string.concat(".", _network, ".weth"));

        return abi.encode(acrossSpokePool, weth);
    }
}
