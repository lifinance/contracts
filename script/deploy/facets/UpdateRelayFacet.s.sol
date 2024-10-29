// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";

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
        return update("RelayFacet");
    }
}
