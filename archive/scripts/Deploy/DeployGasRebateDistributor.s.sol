// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GasRebateDistributor } from "lifi/Periphery/GasRebateDistributor.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GasRebateDistributor") {}

    function run()
        public
        returns (GasRebateDistributor deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GasRebateDistributor(
            deploy(type(GasRebateDistributor).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        address contractOwner = deployerAddress;

        // read config file to extract network-specific deploy parameters
        string memory path = string.concat(
            root,
            "/config/gasRebateDistributor.json"
        );
        string memory json = vm.readFile(path);

        bytes32 merkleRoot = json.readBytes32(
            string.concat(".", network, ".merkleRoot")
        );
        uint256 deadline = json.readUint(
            string.concat(".", network, ".deadline")
        );
        address tokenAddress = json.readAddress(
            string.concat(".", network, ".rebateTokenAddress")
        );

        return abi.encode(contractOwner, merkleRoot, deadline, tokenAddress);
    }
}
