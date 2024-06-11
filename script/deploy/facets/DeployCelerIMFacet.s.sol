// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacetMutable } from "lifi/Facets/CelerIMFacetMutable.sol";
import { CelerIMFacetImmutable } from "lifi/Facets/CelerIMFacetImmutable.sol";
import { CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerIMFacet") {}

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
            deployed = CelerIMFacetImmutable(
                deploy(type(CelerIMFacetImmutable).creationCode)
            );
        }
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get messageBus address
        string memory path = string.concat(root, "/config/cbridge.json");
        string memory json = vm.readFile(path);

        address messageBus = json.readAddress(
            string.concat(".", network, ".messageBus")
        );

        address cfUSDCAddress;
        if (
            keccak256(abi.encodePacked(network)) ==
            keccak256(abi.encodePacked("mainnet"))
        ) {
            cfUSDCAddress = json.readAddress(
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
        json = vm.readFile(path);

        // check which diamond to use (from env variable)
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        // check which kind of diamond is being deployed
        bool deployMutable = keccak256(abi.encodePacked(diamondType)) ==
            keccak256(abi.encodePacked("LiFiDiamond"));

        // get address of the correct diamond contract from network log file
        address diamondAddress = deployMutable
            ? json.readAddress(".LiFiDiamond")
            : json.readAddress(".LiFiDiamondImmutable");

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
