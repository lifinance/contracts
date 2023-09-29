// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("CCIPFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = CCIPFacet.initCCIP.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/ccip.json");
        json = vm.readFile(path);
        bytes memory rawChainSelectors = json.parseRaw(".chainSelectors");
        CCIPFacet.ChainSelector[] memory chainSelectors = abi.decode(
            rawChainSelectors,
            (CCIPFacet.ChainSelector[])
        );

        bytes memory callData = abi.encodeWithSelector(
            CCIPFacet.initCCIP.selector,
            chainSelectors
        );

        return callData;
    }
}
