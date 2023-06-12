// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacet } from "lifi/Facets/CelerIMFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    address internal diamondAddress;
    string internal globalConfigPath;
    string internal globalConfigJson;

    constructor() DeployScriptBase("CelerIMFacet") {}

    function run()
        public
        returns (CelerIMFacet deployed, bytes memory constructorArgs)
    {
        // get messageBus address
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/cbridge.json"
        );
        string memory json = vm.readFile(path);
        address messageBus = json.readAddress(
            string.concat(".", network, ".messageBus")
        );

        address cfUSDCAddress;
        if (
            keccak256(abi.encodePacked(network)) ==
            keccak256(abi.encodePacked("mainnet"))
        ) {
            cfUSDCAddress = json.readAddress(string.concat(".", network, ".cfUSDC"));
        }

        // get path of network deploy file
        path = string.concat(
            vm.projectRoot(),
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);

        // check which diamond to use (from env variable) and get its address from network deploy file
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        if (
            keccak256(abi.encodePacked(diamondType)) ==
            keccak256(abi.encodePacked("LiFiDiamond"))
        )
            diamondAddress = json.readAddress(string.concat(".LiFiDiamond"));
        else
            diamondAddress = json.readAddress(string.concat(".LiFiDiamondImmutable"));

        // get path of global config file
        globalConfigPath = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // prepare constructorArgs
        constructorArgs = abi.encode(messageBus, refundWalletAddress, diamondAddress, cfUSDCAddress);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CelerIMFacet(payable(predicted)), constructorArgs);
        }

        deployed = CelerIMFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CelerIMFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
