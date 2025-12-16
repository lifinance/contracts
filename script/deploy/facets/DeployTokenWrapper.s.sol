// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { stdJson } from "forge-std/Script.sol";
import { InvalidContract } from "lifi/Errors/GenericErrors.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("TokenWrapper") {}

    function run()
        public
        returns (TokenWrapper deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = TokenWrapper(deploy(type(TokenWrapper).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory path = string.concat(root, "/config/networks.json");

        // extract wrapped token address for the given network
        address wrappedNativeAddress = _getConfigContractAddress(
            path,
            string.concat(".", network, ".wrappedNativeAddress")
        );

        // Try to get converter address, default to address(0) if not found
        address converterAddress;
        try
            vm.parseJsonAddress(
                vm.readFile(path),
                string.concat(".", network, ".converterAddress")
            )
        returns (address addr) {
            converterAddress = addr;
        } catch {
            converterAddress = address(0);
        }

        // Verify converter is a contract if address is non-zero
        if (converterAddress != address(0)) {
            if (converterAddress.code.length == 0) revert InvalidContract();
        }

        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        return
            abi.encode(
                wrappedNativeAddress,
                converterAddress,
                refundWalletAddress
            );
    }
}
