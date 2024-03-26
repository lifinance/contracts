// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacetMutable } from "lifi/Facets/CelerIMFacetMutable.sol";
import { CelerIMFacetImmutable } from "lifi/Facets/CelerIMFacetImmutable.sol";
import { CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";

contract DeployCelerIMFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "CelerIMFacet";
    }

    function _creationCode() internal view override returns (bytes memory) {
        // check which diamond to use (from env variable)
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        // check which kind of diamond is being deployed
        bool deployMutable = keccak256(abi.encodePacked(diamondType)) ==
            keccak256(abi.encodePacked("LiFiDiamond"));

        // select the correct version of the CelerIM contract for deployment
        if (deployMutable) {
            return type(CelerIMFacetMutable).creationCode;
        } else {
            return type(CelerIMFacetImmutable).creationCode;
        }
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory _fileSuffix,
        address
    ) internal override returns (bytes memory) {
        // get messageBus address
        string memory path = string.concat(root, "/config/cbridge.json");
        string memory json = vm.readFile(path);

        address messageBus = json.readAddress(
            string.concat(".", _network, ".messageBus")
        );

        address cfUSDCAddress;
        if (
            keccak256(abi.encodePacked(_network)) ==
            keccak256(abi.encodePacked("mainnet"))
        ) {
            cfUSDCAddress = json.readAddress(
                string.concat(".", _network, ".cfUSDC")
            );
        }

        // get path of network deploy file
        path = string.concat(
            root,
            "/deployments/",
            _network,
            ".",
            _fileSuffix,
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
