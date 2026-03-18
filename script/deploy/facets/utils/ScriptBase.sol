// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { stdJson } from "forge-std/Script.sol";

contract ScriptBase is Script, DSTest {
    using stdJson for string;

    error NotAContract(string key);

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

    /// @param path JSON config file path (e.g. root + "/config/networks.json")
    /// @param key JSON key for the address (e.g. ".tempo.wrappedNativeAddress")
    /// @return contractAddress The address read from config; must have code unless overload with flags is used
    function _getConfigContractAddress(
        string memory path,
        string memory key
    ) internal returns (address contractAddress) {
        return _getConfigContractAddress(path, key, false, false);
    }

    /// @param path JSON config file path (e.g. root + "/config/networks.json")
    /// @param key JSON key for the address (e.g. ".tempo.wrappedNativeAddress")
    /// @param allowZeroAddress If true, address(0) is allowed and returned without further checks
    /// @param allowNonContractAddress If true, skip the "address has code" check (e.g. for dummy like tempo's wrappedNative)
    /// @return contractAddress The address read from config
    function _getConfigContractAddress(
        string memory path,
        string memory key,
        bool allowZeroAddress,
        bool allowNonContractAddress
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

        // skip contract-code check when placeholder/dummy addresses are allowed (e.g. tempo wrappedNative)
        if (allowNonContractAddress) return contractAddress;

        // check if address contains code
        if (!LibAsset.isContract(contractAddress))
            revert(
                string.concat(key, " in file ", path, " is not a contract")
            );

        return contractAddress;
    }
}
