// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AoriV2Facet } from "lifi/Facets/AoriV2Facet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        uint256 a;
        bool b;
        address c;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AoriV2Facet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        // Use this to exclude any selectors that might clash with other facets in the diamond
        // or selectors you don't want accessible e.g. init() functions.
        // You can remove this function if it's not needed.
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = AoriV2Facet.initAoriV2.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        // Use this to get initialization calldata that will be executed
        // when adding the facet to a diamond.
        // You can remove this function it it's not needed.
        path = string.concat(root, "/config/aoriV2.json");
        json = vm.readFile(path);
        bytes memory rawConfigs = json.parseRaw(".configs");
        Config[] memory cfg = abi.decode(rawConfigs, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            AoriV2Facet.initAoriV2.selector,
            cfg
        );

        return callData;
    }
}
