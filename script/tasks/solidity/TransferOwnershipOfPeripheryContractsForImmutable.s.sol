// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
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
import { console } from "test/solidity/utils/Console.sol";

contract DeployScript is Script {
    using stdJson for string;

    string internal path;
    string internal networkLogJSON;
    string internal globalConfigJson;
    uint256 internal deployerPrivateKey;
    string internal network;
    string internal fileSuffix;
    string internal root;
    address internal diamond;
    address internal contractAddress;
    // TODO: I only want to change the owner of other contracts for now
    bool internal makeErc20ProxyImmutable = false;

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
        // FIXME: Check if selection work in combination with makeImmutable script
        bool useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");
        diamond = useDefaultDiamond
            ? networkLogJSON.readAddress(".LiFiDiamond")
            : networkLogJSON.readAddress(".LiFiDiamondImmutable");
    }

    function run() public returns (bool) {
        vm.startBroadcast(deployerPrivateKey);

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

        // ------- ERC20Proxy
        address erc20ProxyAddressByDiamond = PeripheryRegistryFacet(diamond)
            .getPeripheryContract("ERC20Proxy");
        address executorAddressByDiamond = PeripheryRegistryFacet(diamond)
            .getPeripheryContract("Executor");
        // check if contract is registered in diamond and if owner is already correctly assigned

        if (
            erc20ProxyAddressByDiamond != address(0) &&
            Ownable(erc20ProxyAddressByDiamond).owner() != address(0)
        ) {
            // set Executor contract as authorized caller, if not already done
            if (
                !ERC20Proxy(erc20ProxyAddressByDiamond).authorizedCallers(
                    executorAddressByDiamond
                )
            )
                ERC20Proxy(erc20ProxyAddressByDiamond).setAuthorizedCaller(
                    executorAddressByDiamond,
                    true
                );

            // renounceOwnership
            if (makeErc20ProxyImmutable) {
                Ownable(erc20ProxyAddressByDiamond).renounceOwnership();
            }
        }

        // ------- FeeCollector
        // TODO: Hot Wallet owns the FeeCollector currently
        // address feeCollectorAddressByDiamond = PeripheryRegistryFacet(
        //     diamond
        // ).getPeripheryContract("FeeCollector");
        // // check if contract is registered in diamond and if owner is already correctly assigned or pending
        // if (
        //     feeCollectorAddressByDiamond != address(0) &&
        //     TransferrableOwnership(feeCollectorAddressByDiamond).owner() !=
        //     withdrawWalletAddress &&
        //     TransferrableOwnership(feeCollectorAddressByDiamond).pendingOwner() !=
        //     withdrawWalletAddress
        // ) {
        //     // transfer ownership to withdraw wallet
        //     TransferrableOwnership(feeCollectorAddressByDiamond).transferOwnership(
        //         withdrawWalletAddress
        //     );
        // }

        // ------- Receiver
        address receiverAddressByDiamond = PeripheryRegistryFacet(diamond)
            .getPeripheryContract("Receiver");
        // check if contract is registered in diamond and if owner is already correctly assigned or pending
        if (
            receiverAddressByDiamond != address(0) &&
            TransferrableOwnership(receiverAddressByDiamond).owner() !=
            refundWalletAddress &&
            TransferrableOwnership(receiverAddressByDiamond).pendingOwner() !=
            refundWalletAddress
        ) {
            // transfer ownership to refund wallet
            TransferrableOwnership(receiverAddressByDiamond).transferOwnership(
                refundWalletAddress
            );
        }

        // ------- ServiceFeeCollector
        address serviceFeeCollectorAddressByDiamond = PeripheryRegistryFacet(
            diamond
        ).getPeripheryContract("ServiceFeeCollector");
        // check if contract is registered in diamond and if owner is already correctly assigned or pending
        if (
            serviceFeeCollectorAddressByDiamond != address(0) &&
            TransferrableOwnership(serviceFeeCollectorAddressByDiamond)
                .owner() !=
            withdrawWalletAddress &&
            TransferrableOwnership(serviceFeeCollectorAddressByDiamond)
                .pendingOwner() !=
            withdrawWalletAddress
        ) {
            // transfer ownership to withdraw wallet
            TransferrableOwnership(serviceFeeCollectorAddressByDiamond)
                .transferOwnership(withdrawWalletAddress);
        }

        vm.stopBroadcast();
        return true;
    }
}
