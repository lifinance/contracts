// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    function run()
        public
        returns (address[] memory facets, IDiamondCut.FacetCut[] memory cut)
    {
        address facet = json.readAddress(".OFTWrapperFacet");

        path = string.concat(root, "/config/oftwrapper.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(string.concat(".chains"));
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        bytes memory callData = abi.encodeWithSelector(
            OFTWrapperFacet.initOFTWrapper.selector,
            cidCfg
        );

        vm.startBroadcast(deployerPrivateKey);

        // OFTWrapper
        bytes4[] memory exclude = new bytes4[](1);
        exclude[0] = OFTWrapperFacet.initOFTWrapper.selector;
        buildDiamondCut(getSelectors("OFTWrapperFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
