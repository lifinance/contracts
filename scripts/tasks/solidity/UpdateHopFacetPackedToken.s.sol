// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    address[] internal bridges;
    address[] internal tokensToApprove;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".HopFacetPacked");

        // load config
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        // parse config
        for (uint256 i = 0; i < configs.length; i++) {
            Config memory c = configs[i];
            bridges.push(c.ammWrapper == address(0) ? c.bridge : c.ammWrapper);
            tokensToApprove.push(c.token);
        }

        bridges.push(HopFacetPacked(facet).exchangeAddress());
        tokensToApprove.push(HopFacetPacked(facet).l2CanonicalToken());

        vm.startBroadcast(deployerPrivateKey);

        HopFacetPacked(facet).setApprovalForHopBridges(
            bridges,
            tokensToApprove
        );

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
