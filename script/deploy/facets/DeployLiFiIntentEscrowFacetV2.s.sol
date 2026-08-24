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

        // allowNonContractAddress: true — lifiEscrowInputSettler is a reserved, deterministically
        // deployed vanity address, identical on every EVM chain (Tron cannot reproduce it and
        // carries its own address under the `tron` key in the same config file). The facet is deployed on a chain
        // before the settler exists there, so the ref legitimately has no code yet (see EXSC-748).
        // It is a real non-zero address, so allowZeroAddress stays false.
        address lifiIntentEscrowSettler = _getConfigContractAddress(
            path,
            ".lifiEscrowInputSettler",
            false, // allowZeroAddress
            true // allowNonContractAddress (settler may not be deployed on this chain yet)
        );

        return abi.encode(lifiIntentEscrowSettler);
    }
}
