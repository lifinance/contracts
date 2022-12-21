// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { HopFacetSplit } from "lifi/Facets/HopFacetSplit.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacetSplit") {}

    function run() public returns (HopFacetSplit deployed, bytes memory constructorArgs) {
        vm.startBroadcast(deployerPrivateKey);
        console.log("Preparing...");
        address deployerAddress = vm.addr(deployerPrivateKey);

        address bridgeUSDC = 0x76b22b8C1079A44F1211D867D68b1eda76a635A7; // ammWrapper POLYGON
        address bridgeNative = 0x884d1Aa15F9957E1aEAA86a82a72e49Bc2bfCbe3; // ammWrapper POLYGON
        address USDC_POLYGON = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;

        constructorArgs = abi.encode(bridgeNative, deployerAddress);
        console.log("Deploying now...");

        if (isDeployed()) {
            return (HopFacetSplit(predicted), constructorArgs);
        }

        deployed = HopFacetSplit(factory.deploy(salt, bytes.concat(type(HopFacetSplit).creationCode, constructorArgs)));

        HopFacetSplit.Config[] memory configs = new HopFacetSplit.Config[](1);
        configs[0] = HopFacetSplit.Config(USDC_POLYGON, bridgeUSDC);
        console.log("HopFacetSplit deployed at ", address(deployed));
        deployed.initHop(configs);
        console.log("HopFacetSplit initialized");

        vm.stopBroadcast();
    }
}
