// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";

interface Deployer {
    /// @dev While the `_salt` parameter is not used anywhere here,
    /// it is still needed for consistency between `create` and
    /// `create2` functions (required by the compiler).
    function create(
        bytes32 _salt,
        bytes32 _bytecodeHash,
        bytes calldata _input
    ) external payable returns (address newAddress);
}

contract DeployScriptBase is ScriptBase {
    address internal constant DEPLOYER =
        0x0000000000000000000000000000000000008006;

    function getConstructorArgs() internal virtual returns (bytes memory) {}

    function deploy(
        bytes memory creationCode
    ) internal virtual returns (address payable deployed) {
        bytes memory constructorArgs = getConstructorArgs();

        vm.startBroadcast(deployerPrivateKey);

        bytes32 salt = bytes32(0);
        deployed = payable(
            Deployer(DEPLOYER).create(
                salt,
                keccak256(creationCode),
                constructorArgs
            )
        );

        vm.stopBroadcast();
    }

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }
}
