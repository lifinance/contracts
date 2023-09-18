// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        address facet = json.readAddress(".CCIPFacet");

        path = string.concat(root, "/config/ccip.json");
        json = vm.readFile(path);

        address[] memory exampleAllowedTokens = json.readAddressArray(
            string.concat(".", network, ".exampleAllowedTokens")
        );

        /// You can remove this if you don't need to call init on the facet
        bytes memory callData = abi.encodeWithSelector(
            CCIPFacet.initCCIP.selector,
            exampleAllowedTokens
        );

        // CCIP
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("CCIPFacet", exclude), facet);
        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    address(facet), // address(0) if not calling init
                    callData // "" if not calling init
                );
            }
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(
                cut,
                address(facet), // address(0) if not calling init
                callData // "" if not calling init
            );
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
