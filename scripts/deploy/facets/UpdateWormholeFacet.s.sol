// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        uint256 chainId;
        uint16 wormholeChainId;
    }

    function run()
        public
        returns (address[] memory facets, IDiamondCut.FacetCut[] memory cut)
    {
        address facet = json.readAddress(".WormholeFacet");

        path = string.concat(root, "/config/wormhole.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(".chains");
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            WormholeFacet.initWormhole.selector,
            configs
        );

        vm.startBroadcast(deployerPrivateKey);

        // Wormhole
        bytes4[] memory exclude = new bytes4[](1);
        exclude[0] = WormholeFacet.initWormhole.selector;
        buildDiamondCut(getSelectors("WormholeFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
