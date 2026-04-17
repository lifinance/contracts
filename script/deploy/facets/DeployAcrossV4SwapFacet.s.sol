// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossV4SwapFacet") {}

    function run()
        public
        returns (AcrossV4SwapFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossV4SwapFacet(
            deploy(type(AcrossV4SwapFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/across.json");
        string memory networksPath = string.concat(
            root,
            "/config/networks.json"
        );

        address spokePoolPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".spokePoolPeriphery"),
            true,
            false
        );
        address spokePool = _getConfigContractAddress(
            path,
            string.concat(".", network, ".acrossSpokePool")
        );

        // allowNonContractAddress: true — some networks use a dummy wrappedNative (e.g. tempo uses
        // address(1); see config/networks.json devNotes) when we don't activate the native path;
        // the dummy is not address(0), so allowZeroAddress stays false; we only bypass the contract-code check.
        address wrappedNative = _getConfigContractAddress(
            networksPath,
            string.concat(".", network, ".wrappedNativeAddress"),
            false, // allowZeroAddress (dummy is e.g. address(1), not zero)
            true // allowNonContractAddress (dummy has no code)
        );
        address sponsoredOftSrcPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".sponsoredOftSrcPeriphery"),
            true,
            false
        );
        address sponsoredCctpSrcPeriphery = _getConfigContractAddress(
            path,
            string.concat(".", network, ".sponsoredCctpSrcPeriphery"),
            true,
            false
        );

        // check if production or staging
        string memory globalPath = string.concat(root, "/config/global.json");
        string memory globalJson = vm.readFile(globalPath);
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
                spokePoolPeriphery,
                spokePool,
                wrappedNative,
                sponsoredOftSrcPeriphery,
                sponsoredCctpSrcPeriphery,
                backendSigner
            );
    }
}
