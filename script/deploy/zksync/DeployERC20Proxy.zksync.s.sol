// SPDX-License-Identifier: UNLICENSED
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

        address predictedExecutor = _getPredictedExecutorAddressForZkSync(
            refundWalletAddress
        );

        emit log_named_address(
            "LI.FI: Predicted Executor Address: ",
            predictedExecutor
        );

        return abi.encode(refundWalletAddress, predictedExecutor);
    }

    /// @dev zkSync CREATE2 addresses depend on constructor args; resolve the ERC20Proxy/Executor fixed point.
    function _getPredictedExecutorAddressForZkSync(
        address refundWalletAddress
    ) internal returns (address predictedExecutor) {
        string memory erc20SaltPrefix = vm.envString("DEPLOYSALT");
        string memory executorSaltPrefix = vm.envString("EXECUTOR_DEPLOYSALT");
        bytes32 erc20BytecodeHash = getZkSyncBytecodeHash("ERC20Proxy");
        bytes32 executorBytecodeHash = getZkSyncBytecodeHash("Executor");
        bytes32 erc20Salt = keccak256(
            abi.encodePacked(erc20SaltPrefix, "ERC20Proxy")
        );
        bytes32 executorSalt = keccak256(
            abi.encodePacked(executorSaltPrefix, "Executor")
        );

        address erc20Proxy;
        predictedExecutor = address(0);

        for (uint256 i = 0; i < 8; ) {
            erc20Proxy = predictCreate2Address(
                erc20BytecodeHash,
                erc20Salt,
                abi.encode(refundWalletAddress, predictedExecutor)
            );

            address nextExecutor = predictCreate2Address(
                executorBytecodeHash,
                executorSalt,
                abi.encode(erc20Proxy, refundWalletAddress)
            );

            if (nextExecutor == predictedExecutor && i > 0) {
                break;
            }

            predictedExecutor = nextExecutor;

            unchecked {
                ++i;
            }
        }
    }
}
