// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    struct Bridge {
        address assetId;
        address bridge;
    }

    function run() public returns (address[] memory facets) {
        // load config
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        vm.startBroadcast(deployerPrivateKey);

        // Update bridges in HopFacet via the Diamond
        for (uint256 i = 0; i < configs.length; i++) {
            Bridge memory b;
            Config memory c = configs[i];
            b.assetId = c.token;
            b.bridge = c.ammWrapper == address(0) ? c.bridge : c.ammWrapper;
            HopFacet(diamond).registerBridge(b.assetId, b.bridge);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
