// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployHopFacetPacked2 is DeployScript {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    function _contractName() internal pure override returns (string memory) {
        return "HopFacetPacked";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(HopFacetPacked).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address _deployerAddress
    ) internal view override returns (bytes memory) {
        string memory path = string.concat(root, "/config/hop.json");
        string memory json = vm.readFile(path);

        bytes memory rawConfig = json.parseRaw(
            string.concat(".", _network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        // Find the ammWrapper address for the native token on this chain
        address ammWrapper;
        for (uint256 i = 0; i < configs.length; i++) {
            if (
                configs[i].token == 0x0000000000000000000000000000000000000000
            ) {
                ammWrapper = configs[i].ammWrapper;
            }
        }

        return abi.encode(_deployerAddress, ammWrapper);
    }
}
