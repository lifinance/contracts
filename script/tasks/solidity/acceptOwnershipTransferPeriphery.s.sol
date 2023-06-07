// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/Script.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";

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
        withdrawPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY_WITHDRAW_WALLET"));
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
        diamondImmutableAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable"
        );
    }

    function run() public returns (bool) {
        // gather required periphery contract addresses
        address feeCollectorAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable.Periphery.FeeCollector"
        );
        address receiverAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable.Periphery.Receiver"
        );
        address relayerCelerIMAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable.Periphery.RelayerCelerIM"
        );
        address serviceFeeCollectorAddress = diamondLogJSON.readAddress(
            ".LiFiDiamondImmutable.Periphery.ServiceFeeCollector"
        );

        // start broadcast for withdraw wallet
        vm.startBroadcast(withdrawPrivateKey);

        // accept ownership transfer for FeeCollector / ServiceFeeCollector
        TransferrableOwnership(feeCollectorAddress).confirmOwnershipTransfer();
        TransferrableOwnership(serviceFeeCollectorAddress).confirmOwnershipTransfer();

        // end broadcast for withdraw wallet
        vm.stopBroadcast();


        // start broadcast for refund wallet
        vm.startBroadcast(refundPrivateKey);

        // accept ownership transfer for FeeCollector / ServiceFeeCollector
        TransferrableOwnership(receiverAddress).confirmOwnershipTransfer();
        TransferrableOwnership(relayerCelerIMAddress).confirmOwnershipTransfer();

        // end broadcast for refund wallet
        vm.stopBroadcast();

        return true;
    }
}
