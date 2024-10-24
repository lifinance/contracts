// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamondImmutable } from "lifi/LiFiDiamondImmutable.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    LibDiamond.FacetCut[] internal cut;
    address internal diamondImmutable;
    DiamondCutFacet internal cutter;

    constructor() DeployScriptBase("LiFiDiamondImmutable") {}

    function run()
        public
        returns (LiFiDiamondImmutable deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiDiamondImmutable(
            deploy(type(LiFiDiamondImmutable).creationCode)
        );
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
