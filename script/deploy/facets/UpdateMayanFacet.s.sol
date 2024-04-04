// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        uint256 chainId;
        uint16 wormholeChainId;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("MayanFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = MayanFacet.initMayan.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/mayan.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(".chains");
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.initMayan.selector,
            configs
        );

        return callData;
    }
}
