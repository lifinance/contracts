// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { Script } from "forge-std/Script.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";

abstract contract DeployScript is Script {
    string internal root;

    constructor() {
        root = vm.projectRoot();
    }

    function run(
        address _deployerAddress,
        address _create3FactoryAddress,
        string calldata _network,
        string calldata _saltPrefix,
        bool _isProduction
    ) external returns (address deployed, bytes memory constructorArgs) {
        string memory fileSuffix = "";
        if (!_isProduction) {
            fileSuffix = ".staging";
        }
        constructorArgs = _getConstructorArgs(
            _network,
            fileSuffix,
            _deployerAddress
        );
        CREATE3Factory factory = CREATE3Factory(_create3FactoryAddress);
        bytes32 salt = keccak256(
            abi.encodePacked(_saltPrefix, _contractName())
        );
        address predicted = factory.getDeployed(_deployerAddress, salt);

        vm.startBroadcast();

        if (isDeployed(predicted)) {
            deployed = predicted;
            return (deployed, constructorArgs);
        }

        deployed = factory.deploy(
            salt,
            bytes.concat(_creationCode(), constructorArgs)
        );

        vm.stopBroadcast();

        return (deployed, constructorArgs);
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory _fileSuffix,
        address _deployerAddress
    ) internal virtual returns (bytes memory);

    function _creationCode() internal virtual returns (bytes memory);

    function _contractName() internal pure virtual returns (string memory);

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }

    function isDeployed(address _contractAddr) internal view returns (bool) {
        return isContract(_contractAddr);
    }
}
