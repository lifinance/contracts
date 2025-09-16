// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacetV4") {}

    function run()
        public
        returns (AcrossFacetV4 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AcrossFacetV4(deploy(type(AcrossFacetV4).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory configPath = string.concat(root, "/config/across.json");
        string memory networksPath = string.concat(
            root,
            "/config/networks.json"
        );

        address acrossSpokePool = _getConfigContractAddress(
            configPath,
            string.concat(".", network, ".acrossSpokePool")
        );
        address wrappedNativeAddress = _getConfigContractAddress(
            networksPath,
            string.concat(".", network, ".wrappedNativeAddress")
        );

        // Convert address to bytes32 for V4 interface
        bytes32 wrappedNativeBytes32 = bytes32(
            uint256(uint160(wrappedNativeAddress))
        );

        return abi.encode(acrossSpokePool, wrappedNativeBytes32);
    }
}
