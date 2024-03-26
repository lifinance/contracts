// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

contract DeployExecutor2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "Executor";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(Executor).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory _fileSuffix,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/deployments/",
            _network,
            ".",
            _fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);

        address erc20Proxy = json.readAddress(".ERC20Proxy");

        return abi.encode(erc20Proxy);
    }
}
