// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { ThorSwapFacet } from "lifi/Facets/ThorSwapFacet.sol";
import { IThorSwap } from "lifi/Interfaces/IThorSwap.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".ThorSwapFacet");

        path = string.concat(root, "/config/thorswap.json");
        json = vm.readFile(path);
        address[] memory allowedAddresses = json.readAddressArray(
            string.concat(".", network, ".allowedRouters")
        );

        IThorSwap[] memory allowedRouters = new IThorSwap[](
            allowedAddresses.length
        );

        for (uint256 i = 0; i < allowedAddresses.length; i++) {
            allowedRouters[i] = IThorSwap(allowedAddresses[i]);
        }

        bytes memory callData = abi.encodeWithSelector(
            ThorSwapFacet.initThorSwap.selector,
            allowedRouters
        );

        vm.startBroadcast(deployerPrivateKey);

        // ThorSwap
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude = new bytes4[](1);
            exclude[0] = ThorSwapFacet.initThorSwap.selector;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("ThorSwapFacet", exclude)
                })
            );
            cutter.diamondCut(cut, facet, callData);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
