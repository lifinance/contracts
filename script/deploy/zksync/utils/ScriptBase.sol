// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { stdJson } from "forge-std/Script.sol";

/// @notice Interface for zkSync's ContractDeployer system contract
interface IContractDeployer {
    function getNewAddressCreate2(
        address _sender,
        bytes32 _bytecodeHash,
        bytes32 _salt,
        bytes calldata _input
    ) external view returns (address newAddress);
}

contract ScriptBase is Script, DSTest {
    using stdJson for string;

    error NotAContract(string key);

    /// @dev zkSync ContractDeployer system contract address
    address internal constant DEPLOYER_SYSTEM_CONTRACT =
        0x0000000000000000000000000000000000008006;

    /// @dev zkSync CREATE2 factory address
    /// @dev foundry-zksync routes CREATE2 deployments through this contract,
    ///      so it must be used as the sender when predicting CREATE2 addresses
    address internal constant ZKSYNC_CREATE2_FACTORY =
        0x0000000000000000000000000000000000010000;

    uint256 internal deployerPrivateKey;
    address internal deployerAddress;
    string internal root;
    string internal network;
    string internal fileSuffix;

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        deployerAddress = vm.addr(deployerPrivateKey);
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");
    }

    /// @notice Predicts the CREATE2 address for a zkSync contract deployment
    /// @dev Uses the CREATE2 factory as sender since foundry-zksync routes through it
    /// @param _bytecodeHash The zkSync bytecode hash (from zkout JSON .hash field)
    /// @param _salt The CREATE2 salt
    /// @param _constructorInput The constructor input data (empty bytes for no-arg constructors)
    /// @return predicted The predicted deployment address
    function predictCreate2Address(
        bytes32 _bytecodeHash,
        bytes32 _salt,
        bytes memory _constructorInput
    ) internal view returns (address predicted) {
        predicted = IContractDeployer(DEPLOYER_SYSTEM_CONTRACT)
            .getNewAddressCreate2(
                ZKSYNC_CREATE2_FACTORY,
                _bytecodeHash,
                _salt,
                _constructorInput
            );
    }

    /// @notice Reads the zkSync bytecode hash from a compiled contract's zkout JSON
    /// @param _contractName The contract name (e.g., "WhitelistManagerFacet")
    /// @return bytecodeHash The zkSync bytecode hash
    function getZkSyncBytecodeHash(
        string memory _contractName
    ) internal returns (bytes32 bytecodeHash) {
        string memory path = string.concat(
            root,
            "/zkout/",
            _contractName,
            ".sol/",
            _contractName,
            ".json"
        );
        string memory jsonFile = vm.readFile(path);
        bytecodeHash = jsonFile.readBytes32(".hash");
    }

    // reads an address from a config file and makes sure that the address contains code
    function _getConfigContractAddress(
        string memory path,
        string memory key
    ) internal returns (address contractAddress) {
        return _getConfigContractAddress(path, key, false);
    }

    // reads an address from a config file and makes sure that the address contains code
    function _getConfigContractAddress(
        string memory path,
        string memory key,
        bool allowZeroAddress
    ) internal returns (address contractAddress) {
        // load json file
        string memory json = vm.readFile(path);

        // read address
        contractAddress = json.readAddress(key);

        // only allow address(0) values if flag is set accordingly, otherwise revert
        if (contractAddress == address(0)) {
            if (allowZeroAddress) return contractAddress;
            revert(
                string.concat(
                    "Found address(0) for key ",
                    key,
                    " in file ",
                    path,
                    " which is not allowed here"
                )
            );
        }

        // check if address contains code
        if (!LibAsset.isContract(contractAddress)) {
            revert(
                string.concat(key, " in file ", path, " is not a contract")
            );
        }
    }
}
