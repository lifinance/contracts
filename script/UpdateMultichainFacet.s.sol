// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".MultichainFacet");

        path = string.concat(root, "/config/multichain.json");
        json = vm.readFile(path);
        address[] memory routers = json.readAddressArray(
            string.concat(".", network, ".routers")
        );
        address anyNative = json.readAddress(
            string.concat(".", network, ".anyNative")
        );
        // TODO
        // MultichainFacet.AnyMapping[] mappings =

        bytes memory callData = abi.encodeWithSelector(
            MultichainFacet.initMultichain.selector,
            anyNative,
            routers
        );

        vm.startBroadcast(deployerPrivateKey);

        // add and init
        bytes4[] memory exclude = new bytes4[](1);
        exclude[0] = MultichainFacet.initMultichain.selector;
        buildDiamondCut(getSelectors("MultichainFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }

        // set token mapping
        // TODO
        // updateAddressMappings

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
