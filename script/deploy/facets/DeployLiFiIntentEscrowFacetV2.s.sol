// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { LiFiIntentEscrowFacetV2 } from "lifi/Facets/LiFiIntentEscrowFacetV2.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("LiFiIntentEscrowFacetV2") {}

    function run()
        public
        returns (
            LiFiIntentEscrowFacetV2 deployed,
            bytes memory constructorArgs
        )
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiIntentEscrowFacetV2(
            deploy(type(LiFiIntentEscrowFacetV2).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/config/lifiintentescrow.json"
        );

        address lifiIntentEscrowSettler = _getConfigContractAddress(
            path,
            string.concat(".lifiEscrowInputSettler.", network)
        );

        return abi.encode(lifiIntentEscrowSettler);
    }
}
