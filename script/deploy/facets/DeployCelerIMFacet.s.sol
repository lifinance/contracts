// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacetMutable } from "lifi/Facets/CelerIMFacetMutable.sol";
import { CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerIMFacet") {}

    error CelerImFacetImmutableIsArchived();

    function run()
        public
        returns (CelerIMFacetBase deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        // check which diamond to use (from env variable)
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        // check which kind of diamond is being deployed
        bool deployMutable = keccak256(abi.encodePacked(diamondType)) ==
            keccak256(abi.encodePacked("LiFiDiamond"));

        // select the correct version of the CelerIM contract for deployment
        if (deployMutable) {
            deployed = CelerIMFacetMutable(
                deploy(type(CelerIMFacetMutable).creationCode)
            );
        } else {
            revert CelerImFacetImmutableIsArchived();
        }
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get messageBus address
        string memory path = string.concat(root, "/config/cbridge.json");

        address messageBus = _getConfigContractAddress(
            path,
            string.concat(".", network, ".messageBus")
        );

        // get address of cfUSDC token (required for mainnet only, otherwise address(0))
        address cfUSDCAddress;
        if (
            keccak256(abi.encodePacked(network)) ==
            keccak256(abi.encodePacked("mainnet"))
        ) {
            cfUSDCAddress = _getConfigContractAddress(
                path,
                string.concat(".", network, ".cfUSDC")
            );
        }

        // get path of network deploy file
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        // check which diamond to use (from env variable)
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        // check which kind of diamond is being deployed
        bool deployMutable = keccak256(abi.encodePacked(diamondType)) ==
            keccak256(abi.encodePacked("LiFiDiamond"));

        // get address of the correct diamond contract from network log file
        address diamondAddress = deployMutable
            ? _getConfigContractAddress(path, ".LiFiDiamond")
            : _getConfigContractAddress(path, ".LiFiDiamondImmutable");

        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // prepare constructorArgs
        return
            abi.encode(
                messageBus,
                refundWalletAddress,
                diamondAddress,
                cfUSDCAddress
            );
    }
}
