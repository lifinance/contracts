// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { HopFacetSplit } from "lifi/Facets/HopFacetSplit.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { Script } from "forge-std/Script.sol";

contract DanielsPlayground is Script {
    uint256 internal deployerPrivateKey;
    address internal deployerAddress;
    HopFacetSplit facet;
    HopFacetSplit.HopData hopData;
    ILiFi.BridgeData internal bridgeData;

    constructor() {}

    function run() public {
        console.log("Starting script");

        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        deployerAddress = vm.addr(deployerPrivateKey);

        console.log("deployer address : ", deployerAddress);

        vm.startBroadcast(deployerPrivateKey);
        address USDC_POLYGON = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
        uint256 amountERC20 = 10000; // 0.1 USDC

        console.log("get hop standalone contract");
        facet = HopFacetSplit(0x141a2366277c98E9ec5588b25Cb04c8bC046Aab3); // address of hopFacetSplit

        console.log("prepare bridgeData");
        bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "hopSplit",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_POLYGON,
            receiver: deployerAddress,
            minAmount: amountERC20,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        console.log("prepare hopData");
        hopData = HopFacetSplit.HopData({
            bonderFee: 5121167728634000706,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20
        });

        console.log("run transaction with ERC20");
        // ERC20(USDC_POLYGON).approve(address(facet), amountERC20);
        // facet.startBridgeTokensViaHopERC20(bridgeData, hopData);

        console.log("run transaction with native");
        console.log("prepare bridgeData");
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 10 ether;

        facet.startBridgeTokensViaHopNative{ value: bridgeData.minAmount + hopData.bonderFee }(bridgeData, hopData);

        console.log("reached end of script");
        vm.stopBroadcast();
    }
}
