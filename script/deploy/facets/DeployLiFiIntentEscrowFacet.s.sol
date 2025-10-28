// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiIntentEscrowFacet } from "lifi/Facets/LiFiIntentEscrowFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LiFiIntentEscrowFacet") {}

    function run()
        public
        returns (LiFiIntentEscrowFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiIntentEscrowFacet(
            deploy(type(LiFiIntentEscrowFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/config/lifiintentescrow.json"
        );
        string memory json = vm.readFile(path);

        address lifiIntentEscrowSettler = json.readAddress(
            ".LIFI_ESCROW_INPUT_SETTLER"
        );

        return abi.encode(lifiIntentEscrowSettler);
    }
}
