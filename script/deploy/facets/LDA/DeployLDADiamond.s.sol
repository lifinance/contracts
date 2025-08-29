// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LDADiamond } from "lifi/Periphery/LDA/LDADiamond.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LDADiamond") {}

    function run()
        public
        returns (LDADiamond deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = LDADiamond(deploy(type(LDADiamond).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        address diamondCut = _getConfigContractAddress(
            path,
            ".DiamondCutFacet"
        );

        return abi.encode(deployerAddress, diamondCut);
    }
}
