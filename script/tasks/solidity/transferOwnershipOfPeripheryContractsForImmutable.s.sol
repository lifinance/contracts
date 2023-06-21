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
    string internal networkLogJSON;
    string internal diamondLogJSON;
    string internal globalConfigJson;
    uint256 internal deployerPrivateKey;
    string internal network;
    string internal fileSuffix;
    string internal root;
    address internal diamondImmutableAddress;
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
        networkLogJSON = vm.readFile(path);
        console.log("A");
        diamondImmutableAddress = networkLogJSON.readAddress(
            ".LiFiDiamondImmutable"
        );
        console.log("B");
    }

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

        console.log("C");
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
        diamondLogJSON = vm.readFile(path);

        // get correct path of diamond log
        path = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(path);
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );
        console.log("D");

        // ------- ERC20Proxy
        if (
            PeripheryRegistryFacet(diamondImmutableAddress)
                .getPeripheryContract("ERC20Proxy") != address(0)
        ) {
            console.log(
                "changing ownership of FeeCollector to address(0) now"
            ); // todo remove
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.ERC20Proxy"
            );
            address executorAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.Executor"
            );

            // set Executor contract as authorized caller
            ERC20Proxy(contractAddress).setAuthorizedCaller(
                executorAddress,
                true
            );

            // renounceOwnership
            Ownable(contractAddress).renounceOwnership();
        }

        // ------- FeeCollector
        if (
            PeripheryRegistryFacet(diamondImmutableAddress)
                .getPeripheryContract("FeeCollector") != withdrawWalletAddress
        ) {
            console.log(
                "changing ownership of FeeCollector to withdrawWalletAddress now"
            ); // todo remove
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.FeeCollector"
            );

            // transfer ownership to withdraw wallet
            TransferrableOwnership(contractAddress).transferOwnership(
                withdrawWalletAddress
            );
        }

        // ------- Receiver
        if (
            PeripheryRegistryFacet(diamondImmutableAddress)
                .getPeripheryContract("Receiver") != refundWalletAddress
        ) {
            console.log(
                "changing ownership of Receiver to refundWalletAddress now"
            ); // todo remove
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.Receiver"
            );

            // transfer ownership to refund wallet
            TransferrableOwnership(contractAddress).transferOwnership(
                refundWalletAddress
            );
        }

        // ------- RelayerCelerIM
        if (
            PeripheryRegistryFacet(diamondImmutableAddress)
                .getPeripheryContract("RelayerCelerIM") != refundWalletAddress
        ) {
            console.log(
                "changing ownership of RelayerCelerIM to refundWalletAddress now"
            ); // todo remove
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.RelayerCelerIM"
            );

            // transfer ownership to refund wallet
            TransferrableOwnership(contractAddress).transferOwnership(
                refundWalletAddress
            );
        }

        // ------- ServiceFeeCollector
        if (
            PeripheryRegistryFacet(diamondImmutableAddress)
                .getPeripheryContract("ServiceFeeCollector") !=
            withdrawWalletAddress
        ) {
            console.log(
                "changing ownership of ServiceFeeCollector to withdrawWalletAddress now"
            ); // todo remove
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.ServiceFeeCollector"
            );

            // transfer ownership to withdraw wallet
            TransferrableOwnership(contractAddress).transferOwnership(
                withdrawWalletAddress
            );
        }

        vm.stopBroadcast();
        return true;
    }
}
