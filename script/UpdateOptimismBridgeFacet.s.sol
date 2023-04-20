// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address assetId;
        address bridge;
    }

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".OptimismBridgeFacet");

        path = string.concat(root, "/config/optimism.json");
        json = vm.readFile(path);
        address standardBridge = json.readAddress(
            string.concat(".", network, ".standardBridge")
        );
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            OptimismBridgeFacet.initOptimism.selector,
            configs,
            standardBridge
        );

        vm.startBroadcast(deployerPrivateKey);

        // OptimismBridge
        bytes4[] memory exclude = new bytes4[](1);
        exclude[0] = OptimismBridgeFacet.initOptimism.selector;
        buildDiamondCut(getSelectors("OptimismBridgeFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
