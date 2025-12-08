// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScriptBase is ScriptBase {
    using stdJson for string;

    /// @dev The CREATE2 salt for this contract deployment
    bytes32 internal salt;
    string internal contractName;

    constructor(string memory _contractName) {
        contractName = _contractName;
        string memory saltPrefix = vm.envString("DEPLOYSALT");
        salt = keccak256(abi.encodePacked(saltPrefix, contractName));
    }

    function getConstructorArgs() internal virtual returns (bytes memory) {}

    function deploy(
        bytes memory creationCode
    ) internal virtual returns (address payable deployed) {
        bytes memory constructorArgs = getConstructorArgs();

        // Get bytecode hash from zkout for accurate CREATE2 prediction
        bytes32 bytecodeHash = getZkSyncBytecodeHash(contractName);

        // Predict CREATE2 address using zkSync's ContractDeployer
        // NOTE: foundry-zksync routes CREATE2 through ZKSYNC_CREATE2_FACTORY,
        // so we use that as the sender for prediction
        address predicted = predictCreate2Address(
            bytecodeHash,
            salt,
            constructorArgs
        );

        if (LibAsset.isContract(predicted)) {
            return payable(predicted);
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy using CREATE2 opcode - foundry-zksync routes through ZKSYNC_CREATE2_FACTORY
        bytes memory deploymentBytecode = bytes.concat(
            creationCode,
            constructorArgs
        );
        assembly {
            let len := mload(deploymentBytecode)
            let data := add(deploymentBytecode, 0x20)
            deployed := create2(0, data, len, sload(salt.slot))
        }

        vm.stopBroadcast();
    }
}
