// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GenericSwapper } from "lifi/Periphery/GenericSwapper.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GenericSwapper") {}

    function run()
        public
        returns (GenericSwapper deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GenericSwapper(deploy(type(GenericSwapper).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);
        address dexAggregatorAddress = json.readAddress(".LiFiDEXAggregator");
        address feeCollectorAddress = json.readAddress(".FeeCollector");

        return abi.encode(dexAggregatorAddress, feeCollectorAddress);
    }
}
