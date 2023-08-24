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
        console.log("in getCallData#1");

        bytes memory rawContracts = json.parseRaw(".chains");
        address[] memory whitelistedContracts = abi.decode(
            rawContracts,
            (address[])
        );
        WhitelistConfig[] memory whitelistCfg = new WhitelistConfig[](
            whitelistedContracts.length
        );
        console.log("in getCallData#2");
        for (uint i; i < whitelistedContracts.length; i++) {
            whitelistCfg[i] = WhitelistConfig(whitelistedContracts[i], true);
        }

        console.log("in getCallData#3");
        bytes memory callData = abi.encodeWithSelector(
            OFTWrapperFacet.initOFTWrapper.selector,
            cidCfg,
            whitelistCfg
        );

        console.log("in getCallData#4");
        return callData;
    }
}
