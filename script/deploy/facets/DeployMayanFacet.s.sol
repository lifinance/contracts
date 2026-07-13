// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("MayanFacet") {}

    function run()
        public
        returns (MayanFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = MayanFacet(deploy(type(MayanFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/mayan.json");

        address bridge = _getConfigContractAddress(
            path,
            string.concat(".bridges.", network, ".bridge")
        );

        string memory json = vm.readFile(path);

        // check if production or staging
        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = json.readAddress(".staging.backendSigner");
        } else {
            backendSigner = json.readAddress(".production.backendSigner");
        }

        return abi.encode(bridge, backendSigner);
    }
}
