// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/Script.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

contract DeployScript is Script {
    using stdJson for string;

    string internal path;
    string internal json;
    string internal globalConfigJson;
    uint256 internal deployerPrivateKey;
    string internal network;
    string internal fileSuffix;
    string internal root;
    address internal diamond;
    address internal contractAddress;

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        diamond = json.readAddress(".LiFiDiamondImmutable");
    }

    function run() public {
        vm.startBroadcast(deployerPrivateKey);
        console.log(
            "in script transferOwnershipOfPeripheryContractsForImmutable"
        );

        // get correct path of diamond log
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".diamond.immutable.",
            fileSuffix,
            "json"
        );

        // read file into json variable
        json = vm.readFile(path);

        // get correct path of diamond log
        path = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(path);
        address refundWalletAddress = json.readAddress(".refundWallet");
        address withdrawWalletAddress = json.readAddress(".withdrawWallet");

        // ------- ERC20Proxy
        if (
            PeripheryRegistryFacet(diamond).getPeripheryContract(
                "ERC20Proxy"
            ) != address(0)
        ) {
            console.log("ERC20Proxy now");
            // get contract address
            contractAddress = json.readAddress(".Periphery.ERC20Proxy");
            address executor = json.readAddress(".Periphery.Executor");
            console.log("contractAddress: ", contractAddress);

            // set Executor contract as authorized caller
            ERC20Proxy(contractAddress).setAuthorizedCaller(executor, true);

            // renounceOwnership
            console.log("before");
            Ownable(contractAddress).renounceOwnership();
            console.log("after");
        }

        // ------- FeeCollector
        if (
            PeripheryRegistryFacet(diamond).getPeripheryContract(
                "FeeCollector"
            ) != address(0)
        ) {
            console.log("FeeCollector now");
            // get contract address
            contractAddress = json.readAddress(".Periphery.FeeCollector");
            console.log("contractAddress: ", contractAddress);

            // transfer ownership to withdraw wallet
            // TODO: write script to confirm ownership transfers by wallet
            console.log("before");
            TransferrableOwnership(contractAddress).transferOwnership(
                withdrawWalletAddress
            );
            console.log("after");
        }

        // ------- Receiver
        if (
            PeripheryRegistryFacet(diamond).getPeripheryContract("Receiver") !=
            address(0)
        ) {
            console.log("Receiver now");
            // get contract address
            contractAddress = json.readAddress(".Periphery.Receiver");
            console.log("contractAddress: ", contractAddress);

            // transfer ownership to refund wallet
            // TODO: write script to confirm ownership transfers by wallet
            console.log("before");
            TransferrableOwnership(contractAddress).transferOwnership(
                refundWalletAddress
            );
            console.log("after");
        }

        // ------- RelayerCelerIM
        if (
            PeripheryRegistryFacet(diamond).getPeripheryContract(
                "RelayerCelerIM"
            ) != address(0)
        ) {
            console.log("RelayerCelerIM now");
            // get contract address
            contractAddress = json.readAddress(".Periphery.RelayerCelerIM");
            console.log("contractAddress: ", contractAddress);

            // transfer ownership to refund wallet
            // TODO: write script to confirm ownership transfers by wallet
            console.log("before");
            TransferrableOwnership(contractAddress).transferOwnership(
                refundWalletAddress
            );
            console.log("after");
        }

        // ------- ServiceFeeCollector
        if (
            PeripheryRegistryFacet(diamond).getPeripheryContract(
                "ServiceFeeCollector"
            ) != address(0)
        ) {
            console.log("ServiceFeeCollector now");
            // get contract address
            contractAddress = json.readAddress(
                ".Periphery.ServiceFeeCollector"
            );
            console.log("contractAddress: ", contractAddress);

            // transfer ownership to withdraw wallet
            // TODO: write script to confirm ownership transfers by wallet
            console.log("before");
            TransferrableOwnership(contractAddress).transferOwnership(
                withdrawWalletAddress
            );
            console.log("after");
        }

        vm.stopBroadcast();
    }
}
