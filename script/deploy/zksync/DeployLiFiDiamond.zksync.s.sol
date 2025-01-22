// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LiFiDiamond") {}

    function run()
        public
        returns (LiFiDiamond deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiDiamond(deploy(type(LiFiDiamond).creationCode));
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
        string memory json = vm.readFile(path);

        address diamondCut = json.readAddress(".DiamondCutFacet");

        return abi.encode(deployerAddress, diamondCut);
    }
}
