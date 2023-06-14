// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacetMutable } from "lifi/Facets/CelerIMFacetMutable.sol";
import { CelerIMFacetImmutable } from "lifi/Facets/CelerIMFacetImmutable.sol";
import { CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    address internal diamondAddress;
    string internal globalConfigPath;
    string internal globalConfigJson;

    constructor() DeployScriptBase("CelerIMFacet") {}

    function run()
        public
        returns (CelerIMFacetBase deployed, bytes memory constructorArgs)
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
            cfUSDCAddress = json.readAddress(
                string.concat(".", network, ".cfUSDC")
            );
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

        // check which diamond to use (from env variable)
        string memory diamondType = vm.envString("DIAMOND_TYPE");
        // check which kind of diamond is being deployed
        bool deployMutable = keccak256(abi.encodePacked(diamondType)) ==
        keccak256(abi.encodePacked("LiFiDiamond"));

        // get address of the correct diamond contract from network log file
        diamondAddress = deployMutable ?
            json.readAddress(string.concat(".LiFiDiamond")) :
            json.readAddress(string.concat(".LiFiDiamondImmutable"));

        // get path of global config file
        globalConfigPath = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // prepare constructorArgs
        constructorArgs = abi.encode(
            messageBus,
            refundWalletAddress,
            diamondAddress,
            cfUSDCAddress
        );

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CelerIMFacetBase(payable(predicted)), constructorArgs);
        }

        // select the correct version of the CelerIM contract for deployment
        if (deployMutable)
            deployed = CelerIMFacetMutable(
                payable(
                    factory.deploy(
                        salt,
                        bytes.concat(
                            type(CelerIMFacetMutable).creationCode,
                            constructorArgs
                        )
                    )
                )
            );
        else
            deployed = CelerIMFacetImmutable(
                payable(
                    factory.deploy(
                        salt,
                        bytes.concat(
                            type(CelerIMFacetImmutable).creationCode,
                            constructorArgs
                        )
                    )
                )
            );

        vm.stopBroadcast();
    }
}
