// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ERC20Proxy") {}

    function run()
        public
        returns (ERC20Proxy deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ERC20Proxy(deploy(type(ERC20Proxy).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        string memory globalConfigJson = vm.readFile(globalConfigPath);

        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        // zkSync CREATE2 addresses depend on the constructor args, which makes the ERC20Proxy and
        // Executor addresses mutually dependent (each constructor takes the other's address). Unlike
        // EVM CREATE3 — where the address is independent of constructor args — there is no convergent
        // way to predict the Executor address before it is deployed, so the Executor cannot be
        // pre-authorized at construction here. Deploy without pre-authorization (executor =
        // address(0)); refundWallet (the ERC20Proxy owner) authorizes the Executor afterwards via
        // setAuthorizedCaller. deployAllContracts handles this as a dedicated zkEVM step, since the
        // deploy wallet does not hold the refundWallet key.
        return abi.encode(refundWalletAddress, address(0));
    }
}
