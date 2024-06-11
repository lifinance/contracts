// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { NonStandardSelectorsRegistryFacet } from "lifi/Facets/NonStandardSelectorsRegistryFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;
    struct Config {
        bytes4[] selectors;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("NonStandardSelectorsRegistryFacet");
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/nonstdselectors.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".selectors")
        );
        Config memory config = abi.decode(rawConfig, (Config));
        bytes memory callData = abi.encodeWithSelector(
            NonStandardSelectorsRegistryFacet
                .batchSetNonStandardSelectors
                .selector,
            config.selectors,
            true
        );
        return callData;
    }
}
