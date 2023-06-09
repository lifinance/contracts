// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    IDiamondCut.FacetCut[] internal cut;
    address internal diamondImmutable;
    DiamondCutFacet internal cutter;

    constructor() DeployScriptBase("LiFiDiamond") {
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");

        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);
        diamondImmutable = json.readAddress(".LiFiDiamondImmutable");
        cutter = DiamondCutFacet(diamondImmutable);
    }

    function run()
        public
        returns (LiFiDiamond deployed, bytes memory constructorArgs)
    {
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

        constructorArgs = abi.encode(deployerAddress, diamondCut);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (LiFiDiamond(payable(predicted)), constructorArgs);
        }

        deployed = LiFiDiamond(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(LiFiDiamond).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
