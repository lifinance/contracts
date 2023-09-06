// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase, console } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    struct WhitelistConfig {
        address contractAddress;
        bool whitelisted;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("OFTWrapperFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = OFTWrapperFacet.initOFTWrapper.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/oftwrapper.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".chains");
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        console.log("rawChains.length: ", rawChains.length);
        console.log("cidCfg[0].chainId: ", cidCfg[0].chainId);
        console.log(
            "cidCfg[0].layerZeroChainId: ",
            cidCfg[0].layerZeroChainId
        );
        console.log("cidCfg[1].chainId: ", cidCfg[1].chainId);
        console.log(
            "cidCfg[1].layerZeroChainId: ",
            cidCfg[1].layerZeroChainId
        );

        bytes memory rawContracts = json.parseRaw(
            string.concat(".whitelistedOftBridgeContracts", ".", network)
        );
        console.log("rawContracts.length: ", rawContracts.length);
        address[] memory whitelistedContracts = abi.decode(
            rawContracts,
            (address[])
        );

        console.log(
            "whitelistedContracts.length: ",
            whitelistedContracts.length
        );
        WhitelistConfig[] memory whitelistCfg = new WhitelistConfig[](
            whitelistedContracts.length
        );
        for (uint i; i < whitelistedContracts.length; i++) {
            whitelistCfg[i] = WhitelistConfig(whitelistedContracts[i], true);
        }

        console.log(
            "whitelistCfg[0].contractAddress: ",
            whitelistCfg[0].contractAddress
        );
        console.log(
            "whitelistCfg[0].whitelisted: ",
            whitelistCfg[0].whitelisted
        );
        console.log(
            "whitelistCfg[1].contractAddress: ",
            whitelistCfg[1].contractAddress
        );
        console.log(
            "whitelistCfg[1].whitelisted: ",
            whitelistCfg[1].whitelisted
        );

        bytes memory callData = abi.encodeWithSelector(
            OFTWrapperFacet.initOFTWrapper.selector,
            cidCfg,
            whitelistCfg
        );
        console.log("callData.length: ", callData.length);

        return callData;
    }
}
