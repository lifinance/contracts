// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { FraxFacet } from "lifi/Facets/FraxFacet.sol";
import { IFraxHopV2 } from "lifi/Interfaces/IFraxHopV2.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("FraxFacet") {}

    function run()
        public
        returns (FraxFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = FraxFacet(deploy(type(FraxFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/frax.json");

        address hop = _getConfigContractAddress(
            path,
            string.concat(".hop.", network)
        );

        // tipFeeManager and pathUsd are non-zero only on Tempo (precompile addresses, no bytecode);
        // frax.json lists only those networks, so every other chain reads address(0) here.
        address tipFeeManager = _getOptionalConfigContractAddress(
            path,
            string.concat(".tipFeeManager.", network)
        );
        address pathUsd = _getOptionalConfigContractAddress(
            path,
            string.concat(".pathUsd.", network)
        );

        return abi.encode(IFraxHopV2(hop), tipFeeManager, pathUsd);
    }
}
