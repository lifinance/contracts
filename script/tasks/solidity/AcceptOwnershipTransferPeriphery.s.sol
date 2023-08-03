// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/Script.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

contract DeployScript is Script {
    using stdJson for string;

    string internal path;
    string internal diamondLogJSON;
    string internal globalConfigJson;
    uint256 internal withdrawPrivateKey;
    uint256 internal refundPrivateKey;
    string internal network;
    string internal fileSuffix;
    string internal root;
    address internal diamondImmutableAddress;
    address internal contractAddress;

    constructor() {
        withdrawPrivateKey = uint256(
            vm.envBytes32("PRIVATE_KEY_WITHDRAW_WALLET")
        );
        refundPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY_REFUND_WALLET"));
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
        diamondLogJSON = vm.readFile(path);
        // FIXME: Diamond should be selectable from script
        diamondImmutableAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable"
        );
    }

    function run() public returns (bool) {
        // get new wallet addresses
        // > get correct path of config
        path = string.concat(root, "/config/global.json");
        // > read file into json variable
        globalConfigJson = vm.readFile(path);
        // > extract values
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        // gather required periphery contract addresses
        PeripheryRegistryFacet peripheryReg = PeripheryRegistryFacet(
            diamondImmutableAddress
        );
        address feeCollectorAddress = peripheryReg.getPeripheryContract(
            "FeeCollector"
        );
        address receiverAddress = peripheryReg.getPeripheryContract(
            "Receiver"
        );
        address relayerCelerIMAddress = peripheryReg.getPeripheryContract(
            "RelayerCelerIM"
        );
        address serviceFeeCollectorAddress = peripheryReg.getPeripheryContract(
            "ServiceFeeCollector"
        );

        // start broadcast for withdraw wallet
        vm.startBroadcast(withdrawPrivateKey);

        // accept ownership transfer for FeeCollector / ServiceFeeCollector if pending
        if (
            feeCollectorAddress != address(0) &&
            TransferrableOwnership(feeCollectorAddress).owner() !=
            withdrawWalletAddress &&
            TransferrableOwnership(feeCollectorAddress).pendingOwner() ==
            withdrawWalletAddress
        ) {
            TransferrableOwnership(feeCollectorAddress)
                .confirmOwnershipTransfer();
        }
        if (
            serviceFeeCollectorAddress != address(0) &&
            TransferrableOwnership(serviceFeeCollectorAddress).owner() !=
            withdrawWalletAddress &&
            TransferrableOwnership(serviceFeeCollectorAddress)
                .pendingOwner() ==
            withdrawWalletAddress
        ) {
            TransferrableOwnership(serviceFeeCollectorAddress)
                .confirmOwnershipTransfer();
        }

        // end broadcast for refund wallet
        vm.stopBroadcast();

        // start broadcast for refund wallet
        vm.startBroadcast(refundPrivateKey);

        // accept ownership transfer for Receiver / RelayerCelerIM
        if (
            receiverAddress != address(0) &&
            TransferrableOwnership(receiverAddress).owner() !=
            refundWalletAddress &&
            TransferrableOwnership(receiverAddress).pendingOwner() ==
            refundWalletAddress
        ) {
            TransferrableOwnership(receiverAddress).confirmOwnershipTransfer();
        }
        if (
            relayerCelerIMAddress != address(0) &&
            TransferrableOwnership(relayerCelerIMAddress).owner() !=
            refundWalletAddress &&
            TransferrableOwnership(relayerCelerIMAddress).pendingOwner() ==
            refundWalletAddress
        ) {
            TransferrableOwnership(relayerCelerIMAddress)
                .confirmOwnershipTransfer();
        }

        // end broadcast for refund wallet
        vm.stopBroadcast();

        return true;
    }
}
