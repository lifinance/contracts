// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        address facet = json.readAddress(".MultichainFacet");

        path = string.concat(root, "/config/multichain.json");
        json = vm.readFile(path);
        address[] memory routers = json.readAddressArray(
            string.concat(".", network, ".routers")
        );
        address anyNative = json.readAddress(
            string.concat(".", network, ".anyNative")
        );

        // get anyTokenMappings from config and parse into array
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );

        // parse raw data from config into anyMappings array
        MultichainFacet.AnyMapping[] memory addressMappings = abi.decode(
            rawConfig,
            (MultichainFacet.AnyMapping[])
        );

        // prepare calldata for call of initMultichain function
        bytes memory callData = abi.encodeWithSelector(
            MultichainFacet.initMultichain.selector,
            anyNative,
            routers
        );

        // add facet and call init function
        bytes4[] memory exclude = new bytes4[](1);
        exclude[0] = MultichainFacet.initMultichain.selector;
        buildDiamondCut(getSelectors("MultichainFacet", exclude), facet);
        if (noBroadcast) {
            if (cut.length > 0) {
                callData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    address(facet),
                    callData
                );
            }
            return (facets, callData);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }

        // call updateAddressMappings function with data from config
        MultichainFacet(diamond).updateAddressMappings(addressMappings);

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
