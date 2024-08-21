// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("MultichainFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = MultichainFacet.initMultichain.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/multichain.json");
        json = vm.readFile(path);
        address[] memory routers = json.readAddressArray(
            string.concat(".", network, ".routers")
        );
        address anyNative = json.readAddress(
            string.concat(".", network, ".anyNative")
        );

        // prepare calldata for call of initMultichain function
        bytes memory callData = abi.encodeWithSelector(
            MultichainFacet.initMultichain.selector,
            anyNative,
            routers
        );

        return callData;
    }
}
