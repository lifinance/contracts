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
        diamondImmutableAddress = networkLogJSON.readAddress(
            ".LiFiDiamondImmutable"
        );
    }

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

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

        // ------- ERC20Proxy
        address erc20ProxyAddressByDiamond = PeripheryRegistryFacet(
            diamondImmutableAddress
        ).getPeripheryContract("ERC20Proxy");
        // check if contract is registered in diamond and if owner is already correctly assigned

        if (
            erc20ProxyAddressByDiamond != address(0) &&
            Ownable(erc20ProxyAddressByDiamond).owner() != address(0)
        ) {
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.ERC20Proxy"
            );

            address executorAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.Executor"
            );

            // set Executor contract as authorized caller, if not already done
            if (
                !ERC20Proxy(contractAddress).authorizedCallers(executorAddress)
            )
                ERC20Proxy(contractAddress).setAuthorizedCaller(
                    executorAddress,
                    true
                );

            // renounceOwnership
            Ownable(contractAddress).renounceOwnership();
        }

        // ------- FeeCollector
        address feeCollectorAddressByDiamond = PeripheryRegistryFacet(
            diamondImmutableAddress
        ).getPeripheryContract("FeeCollector");
        // check if contract is registered in diamond and if owner is already correctly assigned
        if (
            feeCollectorAddressByDiamond != address(0) &&
            TransferrableOwnership(feeCollectorAddressByDiamond).owner() !=
            withdrawWalletAddress
        ) {
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
        address receiverAddressByDiamond = PeripheryRegistryFacet(
            diamondImmutableAddress
        ).getPeripheryContract("Receiver");
        // check if contract is registered in diamond and if owner is already correctly assigned
        if (
            receiverAddressByDiamond != address(0) &&
            TransferrableOwnership(receiverAddressByDiamond).owner() !=
            refundWalletAddress
        ) {
            // get contract address
            contractAddress = diamondLogJSON.readAddress(
                ".LiFiDiamondImmutable.Periphery.Receiver"
            );

            // transfer ownership to refund wallet
            TransferrableOwnership(contractAddress).transferOwnership(
                refundWalletAddress
            );
        }

        // ------- ServiceFeeCollector
        address serviceFeeCollectorAddressByDiamond = PeripheryRegistryFacet(
            diamondImmutableAddress
        ).getPeripheryContract("ServiceFeeCollector");
        // check if contract is registered in diamond and if owner is already correctly assigned
        if (
            serviceFeeCollectorAddressByDiamond != address(0) &&
            TransferrableOwnership(serviceFeeCollectorAddressByDiamond)
                .owner() !=
            withdrawWalletAddress
        ) {
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
