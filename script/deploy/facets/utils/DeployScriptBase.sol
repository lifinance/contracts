// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

contract DeployScriptBase is ScriptBase {
    address internal predicted;
    CREATE3Factory internal factory;
    bytes32 internal salt;

    constructor(string memory contractName) {
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("DEPLOYSALT");
        bool deployToDefaultDiamondAddress = vm.envBool(
            "DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS"
        );

        // if LiFiDiamond should be deployed to 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
        // then set this value in config.sh:
        // DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=true
        if (
            keccak256(abi.encodePacked(contractName)) ==
            keccak256(abi.encodePacked("LiFiDiamond")) &&
            deployToDefaultDiamondAddress
        ) salt = vm.envBytes32("DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT");
        else salt = keccak256(abi.encodePacked(saltPrefix, contractName));
        factory = CREATE3Factory(factoryAddress);
        predicted = factory.getDeployed(deployerAddress, salt);
    }

    function getConstructorArgs() internal virtual returns (bytes memory) {}

    function deploy(
        bytes memory creationCode
    ) internal virtual returns (address payable deployed) {
        bytes memory constructorArgs = getConstructorArgs();

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            emit log("Contract is already deployed");
            return payable(predicted);
        }

        // reproduce and log calldata that is sent to CREATE3
        bytes memory create3Calldata = abi.encodeWithSelector(
            CREATE3Factory.deploy.selector,
            salt,
            bytes.concat(creationCode, constructorArgs)
        );
        emit log("Contract is already deployed");
        emit log_bytes(create3Calldata);

        deployed = payable(
            factory.deploy(salt, bytes.concat(creationCode, constructorArgs))
        );

        vm.stopBroadcast();
    }

    /// @notice Checks if the given address is a contract (including EIP‑7702 AA‑wallets)
    ///         Returns true for any account with runtime code or with the 0xef0100 prefix (EIP‑7702).
    ///         Limitations:
    ///         - Still returns false during construction phase of a contract
    ///         - Cannot distinguish between EOA and self-destructed contract
    /// @param _contractAddr The address to be checked
    function isContract(address _contractAddr) internal view returns (bool) {
        return LibAsset.isContract(_contractAddr);
    }

    function isDeployed() internal view returns (bool) {
        return isContract(predicted);
    }
}
