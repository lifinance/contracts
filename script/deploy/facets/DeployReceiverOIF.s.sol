// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ReceiverOIF } from "lifi/Periphery/ReceiverOIF.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ReceiverOIF") {}

    function run()
        public
        returns (ReceiverOIF deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ReceiverOIF(deploy(type(ReceiverOIF).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
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

        string memory path = string.concat(
            root,
            "/config/lifiintentescrow.json"
        );
        // allowNonContractAddress: true — OIFOutputSettlerSimple is a reserved, deterministically
        // deployed vanity address, identical on every EVM chain (Tron cannot reproduce it and
        // carries its own address under the `tron` key in the same config file). ReceiverOIF is deployed on a chain
        // before the settler exists there, so the ref legitimately has no code yet (see EXSC-748).
        // It is a real non-zero address, so allowZeroAddress stays false.
        address outputSettler = _getConfigContractAddress(
            path,
            ".OIFOutputSettlerSimple",
            false, // allowZeroAddress
            true // allowNonContractAddress (settler may not be deployed on this chain yet)
        );

        // get Executor address from deploy log
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        address executor = _getConfigContractAddress(path, ".Executor");

        return abi.encode(refundWalletAddress, executor, outputSettler);
    }
}
