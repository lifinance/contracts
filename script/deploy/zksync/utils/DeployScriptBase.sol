// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase } from "../../facets/utils/ScriptBase.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

interface IContractDeployer {
    function getNewAddressCreate2(
        address _sender,
        bytes32 _bytecodeHash,
        bytes32 _salt,
        bytes calldata _input
    ) external view returns (address newAddress);
}

contract DeployScriptBase is ScriptBase {
    /// @dev The prefix used to create CREATE2 addresses.
    bytes32 internal salt;
    string internal contractName;
    address internal constant DEPLOYER_CONTRACT_ADDRESS =
        0x0000000000000000000000000000000000008006;

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
        bytes memory deploymentBytecode = bytes.concat(
            creationCode,
            constructorArgs
        );

        // Predict CREATE2 address using zkSync's ContractDeployer
        address predicted = IContractDeployer(DEPLOYER_CONTRACT_ADDRESS)
            .getNewAddressCreate2(
                deployerAddress,
                keccak256(deploymentBytecode),
                salt,
                constructorArgs
            );

        if (LibAsset.isContract(predicted)) {
            return payable(predicted);
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy a contract using the CREATE2 opcode for deterministic addr
        assembly {
            let len := mload(deploymentBytecode)
            let data := add(deploymentBytecode, 0x20)
            deployed := create2(0, data, len, sload(salt.slot))
        }

        vm.stopBroadcast();
    }
}
