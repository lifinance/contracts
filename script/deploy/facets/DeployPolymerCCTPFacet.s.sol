// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("PolymerCCTPFacet") {}

    function run()
        public
        returns (PolymerCCTPFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = PolymerCCTPFacet(
            deploy(type(PolymerCCTPFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/polymercctp.json");

        address tokenMessenger = _getConfigContractAddress(
            path,
            string.concat(".", network, ".tokenMessengerV2")
        );

        address usdc = _getConfigContractAddress(
            path,
            string.concat(".", network, ".usdc")
        );

        // polymerFeeReceiver is an EOA
        string memory json = vm.readFile(path);
        address polymerFeeReceiver = json.readAddress(
            string.concat(".", network, ".polymerFeeReceiver")
        );

        return abi.encode(tokenMessenger, usdc, polymerFeeReceiver);
    }
}
