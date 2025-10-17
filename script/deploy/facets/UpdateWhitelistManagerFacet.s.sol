// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("WhitelistManagerFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = WhitelistManagerFacet.migrate.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        // Read selectors to remove from whitelistManager config
        string memory selectorsToRemovePath = string.concat(
            root,
            "/config/whitelistManager.json"
        );
        string memory selectorsToRemoveJson = vm.readFile(
            selectorsToRemovePath
        );
        string[] memory rawSelectorsToRemove = vm.parseJsonStringArray(
            selectorsToRemoveJson,
            ".functionSelectorsToRemove"
        );
        bytes4[] memory selectorsToRemove = new bytes4[](
            rawSelectorsToRemove.length
        );
        for (uint256 i = 0; i < rawSelectorsToRemove.length; i++) {
            selectorsToRemove[i] = bytes4(
                vm.parseBytes(rawSelectorsToRemove[i])
            );
        }

        // Read whitelist.json and extract contract-selector pairs for current network
        string memory whitelistPath = string.concat(
            root,
            "/config/whitelist.json"
        );
        string memory whitelistJson = vm.readFile(whitelistPath);

        // Parse the whitelist.json structure and extract contracts for current network
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _parseWhitelistJson(whitelistJson);

        bytes memory callData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove,
            contracts,
            selectors
        );

        return callData;
    }

    function _parseWhitelistJson(
        string memory whitelistJson
    )
        internal
        returns (address[] memory allContracts, bytes4[][] memory allSelectors)
    {
        // Parse DEXS section
        (
            address[] memory dexContracts,
            bytes4[][] memory dexSelectors
        ) = _parseDexsSection(whitelistJson);

        // Parse PERIPHERY section
        (
            address[] memory peripheryContracts,
            bytes4[][] memory peripherySelectors
        ) = _parsePeripherySection(whitelistJson);

        // Merge results
        uint256 totalContracts = dexContracts.length +
            peripheryContracts.length;
        allContracts = new address[](totalContracts);
        allSelectors = new bytes4[][](totalContracts);

        // Copy DEXS data
        for (uint256 i = 0; i < dexContracts.length; i++) {
            allContracts[i] = dexContracts[i];
            allSelectors[i] = dexSelectors[i];
        }

        // Copy PERIPHERY data
        for (uint256 i = 0; i < peripheryContracts.length; i++) {
            allContracts[dexContracts.length + i] = peripheryContracts[i];
            allSelectors[dexContracts.length + i] = peripherySelectors[i];
        }
    }

    function _parseDexsSection(
        string memory whitelistJson
    )
        internal
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // Count total contracts across all DEXS for the current network
        uint256 totalContracts = _countDexsContracts(whitelistJson);

        // Allocate arrays
        contracts = new address[](totalContracts);
        selectors = new bytes4[][](totalContracts);

        // Populate arrays
        uint256 contractIndex = 0;
        contractIndex = _populateDexsContracts(
            whitelistJson,
            contracts,
            selectors,
            contractIndex
        );
    }

    function _parsePeripherySection(
        string memory whitelistJson
    )
        internal
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // Check if PERIPHERY section exists for current network
        string memory peripheryKey = string.concat(".PERIPHERY.", network);
        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            // Network exists, count contracts
            uint256 totalContracts = _countPeripheryContracts(whitelistJson);

            // Allocate arrays
            contracts = new address[](totalContracts);
            selectors = new bytes4[][](totalContracts);

            // Populate arrays
            uint256 contractIndex = 0;
            contractIndex = _populatePeripheryContracts(
                whitelistJson,
                contracts,
                selectors,
                contractIndex
            );
        } catch {
            // Network not found, return empty arrays
            contracts = new address[](0);
            selectors = new bytes4[][](0);
        }
    }

    function _countDexsContracts(
        string memory whitelistJson
    ) internal returns (uint256 totalContracts) {
        // Count contracts by iterating through DEXS array
        uint256 dexIndex = 0;
        uint256 maxDexs = 1000; // Safety limit to prevent infinite loops and excessive gas usage

        while (dexIndex < maxDexs) {
            string memory dexKey = string.concat(
                ".DEXS[",
                vm.toString(dexIndex),
                "]"
            );
            try vm.parseJson(whitelistJson, dexKey) returns (bytes memory) {
                // DEX exists, check if it has contracts for current network
                string memory networkKey = string.concat(
                    ".DEXS[",
                    vm.toString(dexIndex),
                    "].contracts.",
                    network
                );
                try vm.parseJson(whitelistJson, networkKey) returns (
                    bytes memory
                ) {
                    // Network exists for this DEX, count contracts
                    uint256 contractCount = _getArrayLength(
                        whitelistJson,
                        string.concat(
                            ".DEXS[",
                            vm.toString(dexIndex),
                            "].contracts.",
                            network
                        )
                    );
                    totalContracts += contractCount;
                } catch {
                    // Network not found for this DEX, continue
                }
                dexIndex++;
            } catch {
                // No more DEXS
                break;
            }
        }
    }

    function _countPeripheryContracts(
        string memory whitelistJson
    ) internal returns (uint256 totalContracts) {
        string memory peripheryKey = string.concat(".PERIPHERY.", network);
        return _getArrayLength(whitelistJson, peripheryKey);
    }

    function _populateDexsContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal returns (uint256) {
        uint256 dexIndex = 0;
        uint256 maxDexs = 1000; // Safety limit to prevent infinite loops and excessive gas usage

        while (dexIndex < maxDexs) {
            string memory dexKey = string.concat(
                ".DEXS[",
                vm.toString(dexIndex),
                "]"
            );
            try vm.parseJson(whitelistJson, dexKey) returns (bytes memory) {
                contractIndex = _processDexContracts(
                    whitelistJson,
                    contracts,
                    selectors,
                    contractIndex,
                    dexIndex
                );
                dexIndex++;
            } catch {
                // No more DEXS
                break;
            }
        }
        return contractIndex;
    }

    function _processDexContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 dexIndex
    ) internal returns (uint256) {
        string memory networkKey = string.concat(
            ".DEXS[",
            vm.toString(dexIndex),
            "].contracts.",
            network
        );
        try vm.parseJson(whitelistJson, networkKey) returns (bytes memory) {
            uint256 contractCount = _getArrayLength(
                whitelistJson,
                string.concat(
                    ".DEXS[",
                    vm.toString(dexIndex),
                    "].contracts.",
                    network
                )
            );
            if (contractCount > 0) {
                contractIndex = _populateContractsForDex(
                    whitelistJson,
                    contracts,
                    selectors,
                    contractIndex,
                    dexIndex,
                    contractCount
                );
            }
        } catch {
            // Network not found for this DEX, continue
        }
        return contractIndex;
    }

    function _populateContractsForDex(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 dexIndex,
        uint256 contractCount
    ) internal returns (uint256) {
        for (uint256 j = 0; j < contractCount; j++) {
            (
                address contractAddr,
                bytes4[] memory contractSelectors
            ) = _parseContractData(whitelistJson, dexIndex, j);
            contracts[contractIndex] = contractAddr;
            selectors[contractIndex] = contractSelectors;
            contractIndex++;
        }
        return contractIndex;
    }

    function _parseContractData(
        string memory whitelistJson,
        uint256 dexIndex,
        uint256 contractIndex
    )
        internal
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        string memory contractKey = string.concat(
            ".DEXS[",
            vm.toString(dexIndex),
            "].contracts.",
            network,
            "[",
            vm.toString(contractIndex),
            "]"
        );
        string memory addressKey = string.concat(contractKey, ".address");
        string memory functionsKey = string.concat(contractKey, ".functions");

        // Parse contract address
        string memory addressStr = vm.parseJsonString(
            whitelistJson,
            addressKey
        );
        contractAddr = vm.parseAddress(addressStr);

        // Parse functions - this is a JSON object, not a string
        bytes memory functionsData = vm.parseJson(whitelistJson, functionsKey);
        string memory functionsJson = string(functionsData);
        contractSelectors = _parseFunctionSelectors(functionsJson);
    }

    function _populatePeripheryContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal returns (uint256) {
        string memory peripheryKey = string.concat(".PERIPHERY.", network);
        uint256 contractCount = _getArrayLength(whitelistJson, peripheryKey);

        for (uint256 k = 0; k < contractCount; k++) {
            (
                address contractAddr,
                bytes4[] memory contractSelectors
            ) = _parsePeripheryContractData(whitelistJson, k);
            contracts[contractIndex] = contractAddr;
            selectors[contractIndex] = contractSelectors;
            contractIndex++;
        }

        return contractIndex;
    }

    function _parsePeripheryContractData(
        string memory whitelistJson,
        uint256 contractIndex
    )
        internal
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        string memory contractKey = string.concat(
            ".PERIPHERY.",
            network,
            "[",
            vm.toString(contractIndex),
            "]"
        );
        string memory addressKey = string.concat(contractKey, ".address");
        string memory selectorsKey = string.concat(contractKey, ".selectors");

        // Parse contract address
        string memory addressStr = vm.parseJsonString(
            whitelistJson,
            addressKey
        );
        contractAddr = vm.parseAddress(addressStr);

        // Parse selectors array
        uint256 selectorCount = _getArrayLength(whitelistJson, selectorsKey);
        contractSelectors = new bytes4[](selectorCount);

        for (uint256 m = 0; m < selectorCount; m++) {
            string memory selectorKey = string.concat(
                selectorsKey,
                "[",
                vm.toString(m),
                "].selector"
            );
            string memory selectorStr = vm.parseJsonString(
                whitelistJson,
                selectorKey
            );
            contractSelectors[m] = bytes4(vm.parseBytes(selectorStr));
        }
    }

    function _getArrayLength(
        string memory json,
        string memory key
    ) internal returns (uint256 length) {
        uint256 index = 0;
        uint256 maxLength = 100; // Safety limit to prevent infinite loops

        while (index < maxLength) {
            string memory indexedKey = string.concat(
                key,
                "[",
                vm.toString(index),
                "]"
            );
            try vm.parseJson(json, indexedKey) returns (bytes memory data) {
                // Check if the returned data is not empty
                if (data.length > 0) {
                    index++;
                } else {
                    break;
                }
            } catch {
                break;
            }
        }
        return index;
    }

    function _parseFunctionSelectors(
        string memory functionsJson
    ) internal returns (bytes4[] memory selectors) {
        // Check if functions object is empty
        if (bytes(functionsJson).length <= 2) {
            // "{}" or similar
            // Empty functions object - use empty selector for backward compatibility
            selectors = new bytes4[](1);
            selectors[0] = bytes4(0);
            return selectors;
        }

        // Count selectors first
        uint256 selectorCount = _countSelectorsInJson(functionsJson);

        // Extract selectors
        selectors = new bytes4[](selectorCount);
        _extractSelectorsFromJson(functionsJson, selectors);

        return selectors;
    }

    function _countSelectorsInJson(
        string memory functionsJson
    ) internal pure returns (uint256 selectorCount) {
        bytes memory jsonBytes = bytes(functionsJson);

        // Count selectors by looking for "0x" followed by 8 hex characters
        for (uint256 i = 0; i < jsonBytes.length - 9; i++) {
            if (_isSelectorPattern(jsonBytes, i)) {
                selectorCount++;
            }
        }
    }

    function _extractSelectorsFromJson(
        string memory functionsJson,
        bytes4[] memory selectors
    ) internal {
        bytes memory jsonBytes = bytes(functionsJson);
        uint256 selectorIndex = 0;

        for (
            uint256 i = 0;
            i < jsonBytes.length - 9 && selectorIndex < selectors.length;
            i++
        ) {
            if (_isSelectorPattern(jsonBytes, i)) {
                selectors[selectorIndex] = _extractSelectorAt(jsonBytes, i);
                selectorIndex++;
            }
        }
    }

    function _isSelectorPattern(
        bytes memory jsonBytes,
        uint256 i
    ) internal pure returns (bool) {
        return
            jsonBytes[i] == "" &&
            jsonBytes[i + 1] == "0" &&
            jsonBytes[i + 2] == "x" &&
            _isHexChar(jsonBytes[i + 3]) &&
            _isHexChar(jsonBytes[i + 4]) &&
            _isHexChar(jsonBytes[i + 5]) &&
            _isHexChar(jsonBytes[i + 6]) &&
            _isHexChar(jsonBytes[i + 7]) &&
            _isHexChar(jsonBytes[i + 8]) &&
            _isHexChar(jsonBytes[i + 9]) &&
            _isHexChar(jsonBytes[i + 10]) &&
            jsonBytes[i + 11] == "";
    }

    function _extractSelectorAt(
        bytes memory jsonBytes,
        uint256 i
    ) internal pure returns (bytes4) {
        // Extract the selector string
        bytes memory selectorBytes = new bytes(10);
        for (uint256 j = 0; j < 10; j++) {
            selectorBytes[j] = jsonBytes[i + 1 + j];
        }
        string memory selectorStr = string(selectorBytes);

        return bytes4(vm.parseBytes(selectorStr));
    }

    function _isHexChar(bytes1 char) internal pure returns (bool) {
        return
            (char >= "0" && char <= "9") ||
            (char >= "a" && char <= "f") ||
            (char >= "A" && char <= "F");
    }
}
