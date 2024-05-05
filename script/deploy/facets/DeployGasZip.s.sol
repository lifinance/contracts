// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GasZip } from "lifi/Periphery/GasZip.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GasZip") {}

    function run()
        public
        returns (GasZip deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GasZip(deploy(type(GasZip).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory gasZipConfig = string.concat(
            root,
            "/config/gaszip.json"
        );

        string memory gasZipConfigJson = vm.readFile(gasZipConfig);

        address gasZipRouter = gasZipConfigJson.readAddress(
            string.concat(".gasZipRouters.", network)
        );
        address owner = gasZipConfigJson.readAddress(
            string.concat(".withdrawWallet")
        );

        return abi.encode(owner, gasZipRouter);
    }
}
