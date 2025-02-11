// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script, console } from "forge-std/Script.sol";
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

    // reads an address from a config file and makes sure that the address contains code
    function _getConfigContractAddress(
        string memory path,
        string memory key,
        bool allowZeroAddress // if zeroAddress is found, it will not check for contract and stil return the address
    ) internal returns (address contractAddress) {
        // load json file
        string memory json = vm.readFile(path);

        // read address
        contractAddress = json.readAddress(key);

        // only allow address(0) values if flag is set accordingly, otherwise revert
        if (contractAddress == address(0))
            if (allowZeroAddress) return contractAddress;
            else
                revert(
                    string.concat(
                        "Found address(0) for key ",
                        key,
                        " in file ",
                        path,
                        " which is not allowed here"
                    )
                );

        // check if address contains code
        if (!LibAsset.isContract(contractAddress))
            revert(
                string.concat(key, " in file ", path, " is not a contract")
            );
    }
}
