// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/Script.sol";
import { console } from "test/solidity/utils/Console.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

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
    uint256 internal refundPrivateKey;

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
        bool useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");
        diamond = useDefaultDiamond
            ? networkLogJSON.readAddress(".LiFiDiamond")
            : networkLogJSON.readAddress(".LiFiDiamondImmutable");

        refundPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY_REFUND_WALLET"));
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

        // ------- cBridgeFacetPacked
        address cbridgeFacetPackedAddressByDiamond = DiamondLoupeFacet(diamond)
            .facetAddress(
                CBridgeFacetPacked
                    .startBridgeTokensViaCBridgeNativePacked
                    .selector
            );
        // check if contract is registered in diamond and if owner is already correctly assigned or pending
        if (
            cbridgeFacetPackedAddressByDiamond != address(0) &&
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .owner() !=
            refundWalletAddress &&
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .pendingOwner() !=
            refundWalletAddress
        ) {
            // transfer ownership to refund wallet
            console.log("cBridgeFacetPacked transferOwnership");
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .transferOwnership(refundWalletAddress);
        }
        console.log(
            "cBridgeFacetPacked owner",
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond).owner()
        );
        console.log(
            "cBridgeFacetPacked pendingOwner",
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .pendingOwner()
        );

        vm.stopBroadcast();

        // -- confirm transfer
        vm.startBroadcast(refundPrivateKey);

        // accept ownership transfer for Receiver / RelayerCelerIM
        if (
            cbridgeFacetPackedAddressByDiamond != address(0) &&
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .pendingOwner() ==
            refundWalletAddress
        ) {
            console.log("cBridgeFacetPacked confirm");
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .confirmOwnershipTransfer();
        }
        console.log(
            "cBridgeFacetPacked owner",
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond).owner()
        );
        console.log(
            "cBridgeFacetPacked pendingOwner",
            TransferrableOwnership(cbridgeFacetPackedAddressByDiamond)
                .pendingOwner()
        );

        vm.stopBroadcast();
        return true;
    }
}
