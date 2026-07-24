// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SymbiosisFacet") {}

    function run()
        public
        returns (SymbiosisFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = SymbiosisFacet(deploy(type(SymbiosisFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/symbiosis.json");

        address metaRouter = _getConfigContractAddress(
            path,
            string.concat(".", network, ".metaRouter")
        );
        address gateway = _getConfigContractAddress(
            path,
            string.concat(".", network, ".gateway")
        );
        // OnchainSwapV3 is optional: chains without the syBTC->Bitcoin path may
        // omit the keys entirely (defaults to address(0)) or set them to address(0).
        string memory json = vm.readFile(path);
        string memory onchainSwapV3Key = string.concat(
            ".",
            network,
            ".onchainSwapV3"
        );
        string memory onchainSwapV3GatewayKey = string.concat(
            ".",
            network,
            ".onchainSwapV3Gateway"
        );
        address onchainSwapV3 = json.keyExists(onchainSwapV3Key)
            ? _getConfigContractAddress(path, onchainSwapV3Key, true)
            : address(0);
        address onchainSwapV3Gateway = json.keyExists(onchainSwapV3GatewayKey)
            ? _getConfigContractAddress(path, onchainSwapV3GatewayKey, true)
            : address(0);

        // backend signer gates the OnchainSwapV3 (syBTC -> Bitcoin) path
        string memory globalJson = vm.readFile(
            string.concat(root, "/config/global.json")
        );
        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = globalJson.readAddress(".backendSigner.staging");
        } else {
            backendSigner = globalJson.readAddress(
                ".backendSigner.production"
            );
        }

        return
            abi.encode(
                metaRouter,
                gateway,
                onchainSwapV3,
                onchainSwapV3Gateway,
                backendSigner
            );
    }
}
