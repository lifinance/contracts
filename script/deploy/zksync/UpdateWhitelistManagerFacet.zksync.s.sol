// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { JSONParserLib } from "solady/utils/JSONParserLib.sol";
import { LibSort } from "solady/utils/LibSort.sol";

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

    /// @notice Override getSelectors to read from a simple JSON file instead of using FFI
    /// @dev This avoids the "zk vm halted" error when using FFI with large JSON files
    function getSelectors(
        string memory _facetName,
        bytes4[] memory _exclude
    ) internal override returns (bytes4[] memory selectors) {
        // Read selectors from a simple JSON file instead of using FFI
        string memory selectorsPath = string.concat(
            root,
            "/config/",
            _facetName,
            ".selectors.json"
        );

        string memory selectorsJson = vm.readFile(selectorsPath);

        // Parse JSON array
        JSONParserLib.Item memory root = JSONParserLib.parse(selectorsJson);
        uint256 selectorCount = JSONParserLib.size(root);
        selectors = new bytes4[](selectorCount);

        // Create exclude set for fast lookup
        bytes4[] memory excludeTemp = _exclude;
        uint256 excludeCount = excludeTemp.length;

        uint256 actualCount = 0;
        for (uint256 i = 0; i < selectorCount; i++) {
            JSONParserLib.Item memory item = JSONParserLib.at(root, i);
            string memory selectorStr = JSONParserLib.decodeString(
                JSONParserLib.value(item)
            );
            bytes4 selector = bytes4(vm.parseBytes(selectorStr));

            // Check if selector should be excluded
            bool shouldExclude = false;
            for (uint256 j = 0; j < excludeCount; j++) {
                if (selector == excludeTemp[j]) {
                    shouldExclude = true;
                    break;
                }
            }

            if (!shouldExclude) {
                selectors[actualCount] = selector;
                actualCount++;
            }
        }

        // Resize array if any selectors were excluded
        if (actualCount < selectorCount) {
            bytes4[] memory trimmed = new bytes4[](actualCount);
            for (uint256 i = 0; i < actualCount; i++) {
                trimmed[i] = selectors[i];
            }
            selectors = trimmed;
        }
    }

    function getCallData() internal override returns (bytes memory) {
        // vm.pauseGasMetering();
        // --- 1. Read Selectors to Remove ---
        bytes4[] memory selectorsToRemove = _readSelectorsToRemove();

        // --- 2. Read Whitelist JSON ---
        string memory whitelistJson = _readWhitelistJson();

        // --- 3. Parse Whitelist ---
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _parseWhitelistJson(whitelistJson);

        // --- 4. Read deployerWallet from global.json ---
        address deployerWallet = _readDeployerWallet();

        // --- 5. ABI-Encode Call Data ---
        bytes memory callData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove,
            contracts,
            selectors,
            deployerWallet
        );
        // vm.resumeGasMetering();
        return callData;
    }

    function _readSelectorsToRemove() internal view returns (bytes4[] memory) {
        string memory selectorsToRemovePath = string.concat(
            root,
            "/config/functionSelectorsToRemove.json"
        );
        string memory selectorsToRemoveJson = vm.readFile(
            selectorsToRemovePath
        );

        // Parse JSON
        JSONParserLib.Item memory selectorsRoot = JSONParserLib.parse(
            selectorsToRemoveJson
        );
        // prettier-ignore
        JSONParserLib.Item memory selectorsArray = JSONParserLib.at(selectorsRoot, "\"functionSelectorsToRemove\"");
        uint256 selectorCount = JSONParserLib.size(selectorsArray);
        string[] memory rawSelectorsToRemove = new string[](selectorCount);
        for (uint256 i = 0; i < selectorCount; i++) {
            JSONParserLib.Item memory selectorItem = JSONParserLib.at(
                selectorsArray,
                i
            );
            rawSelectorsToRemove[i] = JSONParserLib.decodeString(
                JSONParserLib.value(selectorItem)
            );
        }
        // Convert string selectors to bytes4
        bytes4[] memory selectorsToRemove = new bytes4[](
            rawSelectorsToRemove.length
        );
        for (uint256 i = 0; i < rawSelectorsToRemove.length; i++) {
            selectorsToRemove[i] = bytes4(
                vm.parseBytes(rawSelectorsToRemove[i])
            );
        }
        return selectorsToRemove;
    }

    function _readWhitelistJson() internal view returns (string memory) {
        string memory whitelistJson;
        string memory fallbackPath = string.concat(
            root,
            "/config/whitelist.json"
        );
        if (bytes(fileSuffix).length == 0) {
            whitelistJson = vm.readFile(fallbackPath);
        } else {
            // A suffix (e.g., "staging.") is provided
            string memory stagingPath = string.concat(
                root,
                "/config/whitelist.",
                fileSuffix,
                "json"
            );
            try vm.readFile(stagingPath) returns (string memory stagingJson) {
                whitelistJson = stagingJson;
            } catch {
                whitelistJson = vm.readFile(fallbackPath);
            }
        }
        return whitelistJson;
    }

    function _readDeployerWallet() internal view returns (address) {
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );
        string memory globalConfigJson = vm.readFile(globalConfigPath);
        JSONParserLib.Item memory globalRoot = JSONParserLib.parse(
            globalConfigJson
        );
        JSONParserLib.Item memory deployerWalletItem = JSONParserLib.at(
            globalRoot,
            '"deployerWallet"'
        );
        string memory deployerWalletStr = JSONParserLib.decodeString(
            JSONParserLib.value(deployerWalletItem)
        );
        return vm.parseAddress(deployerWalletStr);
    }

    /// @notice Orchestrates the parsing of the entire whitelist JSON.
    function _parseWhitelistJson(
        string memory whitelistJson
    )
        internal
        view
        returns (address[] memory allContracts, bytes4[][] memory allSelectors)
    {
        // Parse JSON once
        JSONParserLib.Item memory root = JSONParserLib.parse(whitelistJson);

        // 1. Parse the ".DEXS" section
        (
            address[] memory dexContracts,
            bytes4[][] memory dexSelectors
        ) = _parseDexsSection(root);

        // 2. Parse the ".PERIPHERY" section
        (
            address[] memory peripheryContracts,
            bytes4[][] memory peripherySelectors
        ) = _parsePeripherySection(root);

        // 3. Merge the results from both sections
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

        // 4. Aggregate duplicates
        (allContracts, allSelectors) = _aggregateByAddress(
            allContracts,
            allSelectors
        );
    }

    /// @notice Aggregates duplicate addresses and merges their unique selectors.
    /// @param contracts An array of addresses, may contain duplicates.
    /// @param selectors An array of selector arrays corresponding to the addresses.
    /// @return outContracts A trimmed array of unique addresses.
    /// @return outSelectors A trimmed array of merged selector arrays.
    /// example
    /// Input:
    /// contracts:  [0xA, 0xB, 0xA]
    /// selectors: [[0x1], [0x2], [0x3]]
    /// Output:
    /// outContracts: [0xA, 0xB]
    /// outSelectors: [[0x1, 0x3], [0x2]]
    function _aggregateByAddress(
        address[] memory contracts,
        bytes4[][] memory selectors
    )
        internal
        pure
        returns (address[] memory outContracts, bytes4[][] memory outSelectors)
    {
        uint256 n = contracts.length;
        if (n == 0) {
            return (new address[](0), new bytes4[][](0));
        }
        bool[] memory visited = new bool[](n);
        outContracts = new address[](n); // Oversized, will be trimmed
        outSelectors = new bytes4[][](n); // Oversized, will be trimmed
        uint256 outCount = 0;

        for (uint256 i = 0; i < n; i++) {
            if (visited[i]) continue; // Already processed this one
            visited[i] = true;

            // Create a deep copy of the selectors to start merging into
            bytes4[] memory merged = _copyArrayBytes4(selectors[i]);

            // Look for duplicates of contracts[i] in the rest of the array
            for (uint256 j = i + 1; j < n; j++) {
                if (!visited[j] && contracts[j] == contracts[i]) {
                    visited[j] = true;
                    // Found a duplicate, merge its selectors
                    merged = _mergeUniqueBytes4(merged, selectors[j]);
                }
            }
            // Add the aggregated entry
            outContracts[outCount] = contracts[i];
            outSelectors[outCount] = merged;
            outCount++;
        }

        // Trim the oversized arrays to the actual count of unique addresses
        address[] memory trimmedContracts = new address[](outCount);
        bytes4[][] memory trimmedSelectors = new bytes4[][](outCount);
        for (uint256 k = 0; k < outCount; k++) {
            trimmedContracts[k] = outContracts[k];
            trimmedSelectors[k] = outSelectors[k];
        }
        return (trimmedContracts, trimmedSelectors);
    }

    /**
     * @notice Utility to create a deep copy of a bytes4 array.
     * @dev Uses LibSort.copy by casting bytes4[] to uint256[] since bytes4 fits in uint256.
     * @param src The source array to copy.
     * @return dst A new `memory` array with the same content as `src`.
     */
    function _copyArrayBytes4(
        bytes4[] memory src
    ) internal pure returns (bytes4[] memory dst) {
        // Cast bytes4[] to uint256[] for LibSort.copy, then cast back
        uint256[] memory srcUint = _toUints(src);
        uint256[] memory dstUint = LibSort.copy(srcUint);
        dst = _toBytes4(dstUint);
    }

    /// @notice Helper to cast bytes4[] to uint256[] for LibSort operations.
    function _toUints(
        bytes4[] memory a
    ) private pure returns (uint256[] memory casted) {
        /// @solidity memory-safe-assembly
        assembly {
            casted := a
        }
    }

    /// @notice Helper to cast uint256[] back to bytes4[].
    function _toBytes4(
        uint256[] memory a
    ) private pure returns (bytes4[] memory casted) {
        /// @solidity memory-safe-assembly
        assembly {
            casted := a
        }
    }

    /// @notice Merges two bytes4 arrays, ensuring the result has no duplicates.
    /// @param baseArr The base array.
    /// @param addArr The array with elements to add.
    /// @return A new array containing all elements from `baseArr` and unique elements from `addArr`.
    /// example
    /// baseArr: [0x11, 0x22]
    /// addArr:  [0x22, 0x33]
    /// Returns: [0x11, 0x22, 0x33]
    function _mergeUniqueBytes4(
        bytes4[] memory baseArr,
        bytes4[] memory addArr
    ) internal pure returns (bytes4[] memory) {
        // 1. Count how many new, unique elements are in `addArr`
        uint256 addCount = 0;
        for (uint256 i = 0; i < addArr.length; i++) {
            if (!_containsBytes4(baseArr, addArr[i])) {
                addCount++;
            }
        }

        if (addCount == 0) return baseArr; // Nothing to add

        // 2. Create new array of the correct size
        bytes4[] memory merged = new bytes4[](baseArr.length + addCount);

        // 3. Copy base elements
        uint256 idx = 0;
        for (uint256 i = 0; i < baseArr.length; i++) {
            merged[idx++] = baseArr[i];
        }

        // 4. Copy new elements
        for (uint256 i = 0; i < addArr.length; i++) {
            if (!_containsBytes4(baseArr, addArr[i])) {
                merged[idx++] = addArr[i];
            }
        }
        return merged;
    }

    /// @notice Helper function to check if a `bytes4` value exists in an array.
    /// @param arr The array to search.
    /// @param val The value to find.
    /// @return true if `val` is in `arr`, false otherwise.
    function _containsBytes4(
        bytes4[] memory arr,
        bytes4 val
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == val) return true;
        }
        return false;
    }

    /// @notice Parses the ".DEXS" section of the whitelist JSON.
    function _parseDexsSection(
        JSONParserLib.Item memory root
    )
        internal
        view
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // prettier-ignore
        JSONParserLib.Item memory dexs = JSONParserLib.at(root, "\"DEXS\"");

        (uint256 totalContracts, uint256 totalDexs) = _countDexsContracts(
            dexs
        );

        contracts = new address[](totalContracts);
        selectors = new bytes4[][](totalContracts);

        uint256 contractIndex = 0;
        contractIndex = _populateDexsContracts(
            dexs,
            contracts,
            selectors,
            contractIndex,
            totalDexs
        );
    }

    /// @notice Parses the ".PERIPHERY" section of the whitelist JSON.
    function _parsePeripherySection(
        JSONParserLib.Item memory root
    )
        internal
        view
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // prettier-ignore
        JSONParserLib.Item memory periphery = JSONParserLib.at(root, "\"PERIPHERY\"");
        // prettier-ignore
        JSONParserLib.Item memory networkPeriphery = JSONParserLib.at(periphery, string.concat("\"", network, "\""));

        // Check if network section exists
        if (JSONParserLib.isUndefined(networkPeriphery)) {
            revert(
                string.concat(
                    "PERIPHERY section does not exist for network: ",
                    network
                )
            );
        }

        uint256 totalContracts = _countPeripheryContracts(networkPeriphery);

        contracts = new address[](totalContracts);
        selectors = new bytes4[][](totalContracts);

        uint256 contractIndex = 0;
        contractIndex = _populatePeripheryContracts(
            networkPeriphery,
            contracts,
            selectors,
            contractIndex
        );
    }

    /// @notice Counts the total number of contracts in the ".DEXS" section.
    function _countDexsContracts(
        JSONParserLib.Item memory dexs
    ) internal view returns (uint256 totalContracts, uint256 totalDexs) {
        totalDexs = JSONParserLib.size(dexs);

        for (uint256 dexIndex = 0; dexIndex < totalDexs; dexIndex++) {
            JSONParserLib.Item memory dex = JSONParserLib.at(dexs, dexIndex);
            // prettier-ignore
            JSONParserLib.Item memory contracts = JSONParserLib.at(dex, "\"contracts\"");
            // prettier-ignore
            JSONParserLib.Item memory networkContracts = JSONParserLib.at(contracts, string.concat("\"", network, "\""));

            // Add contract count for this network (0 if undefined)
            if (!JSONParserLib.isUndefined(networkContracts)) {
                totalContracts += JSONParserLib.size(networkContracts);
            }
        }
    }

    /// @notice Counts the total number of contracts in the ".PERIPHERY" section.
    function _countPeripheryContracts(
        JSONParserLib.Item memory networkPeriphery
    ) internal pure returns (uint256 totalContracts) {
        return JSONParserLib.size(networkPeriphery);
    }

    /// @notice Populates arrays from the ".DEXS" section.
    function _populateDexsContracts(
        JSONParserLib.Item memory dexs,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 totalDexs
    ) internal view returns (uint256) {
        for (uint256 dexIndex = 0; dexIndex < totalDexs; dexIndex++) {
            JSONParserLib.Item memory dex = JSONParserLib.at(dexs, dexIndex);
            contractIndex = _processDexContracts(
                dex,
                contracts,
                selectors,
                contractIndex
            );
        }
        return contractIndex;
    }

    /// @notice Helper for `_populateDexsContracts`. Processes a single DEX entry.
    function _processDexContracts(
        JSONParserLib.Item memory dex,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal view returns (uint256) {
        // prettier-ignore
        JSONParserLib.Item memory contractsObj = JSONParserLib.at(dex, "\"contracts\"");
        // prettier-ignore
        JSONParserLib.Item memory networkContracts = JSONParserLib.at(contractsObj, string.concat("\"", network, "\""));

        if (JSONParserLib.isUndefined(networkContracts)) {
            return contractIndex;
        }

        uint256 contractCount = JSONParserLib.size(networkContracts);
        if (contractCount > 0) {
            contractIndex = _populateContractsForDex(
                networkContracts,
                contracts,
                selectors,
                contractIndex,
                contractCount
            );
        }
        return contractIndex;
    }

    /// @notice Helper for `_processDexContracts`. Populates data for all
    /// contracts within a single DEX entry.
    function _populateContractsForDex(
        JSONParserLib.Item memory networkContracts,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 contractCount
    ) internal pure returns (uint256) {
        for (uint256 j = 0; j < contractCount; j++) {
            (
                address contractAddr,
                bytes4[] memory contractSelectors
            ) = _parseContractDataFromItem(networkContracts, j);
            contracts[contractIndex] = contractAddr;
            selectors[contractIndex] = contractSelectors;
            contractIndex++;
        }
        return contractIndex;
    }

    /// @notice Parses a single contract entry from the ".DEXS" section.
    /// @dev Uses JSONParserLib for efficient JSON parsing without string searching.
    /// @param whitelistJson The full whitelist JSON string.
    /// @param dexIndex The DEX index.
    /// @param contractIndex The contract index within the network array.
    function _parseContractData(
        string memory whitelistJson,
        uint256 dexIndex,
        uint256 contractIndex
    )
        internal
        view
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        // Parse JSON once using JSONParserLib
        JSONParserLib.Item memory root = JSONParserLib.parse(whitelistJson);

        // Navigate to .DEXS[dexIndex].contracts.{network}[contractIndex]
        // prettier-ignore
        JSONParserLib.Item memory dexs = JSONParserLib.at(root, "\"DEXS\"");
        JSONParserLib.Item memory dex = JSONParserLib.at(dexs, dexIndex);
        // prettier-ignore
        JSONParserLib.Item memory contracts = JSONParserLib.at(dex, "\"contracts\"");
        // prettier-ignore
        JSONParserLib.Item memory networkContracts = JSONParserLib.at(contracts, string.concat("\"", network, "\""));

        return _parseContractDataFromItem(networkContracts, contractIndex);
    }

    /// @notice Parses a single contract entry from a network contracts array item.
    /// @dev Internal helper that works with already-parsed JSON items.
    /// @param networkContracts The parsed network contracts array item.
    /// @param contractIndex The contract index within the array.
    function _parseContractDataFromItem(
        JSONParserLib.Item memory networkContracts,
        uint256 contractIndex
    )
        internal
        pure
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        // Get the contract at the specified index
        JSONParserLib.Item memory contractItem = JSONParserLib.at(
            networkContracts,
            contractIndex
        );

        // Parse contract address
        // prettier-ignore
        JSONParserLib.Item memory addressItem = JSONParserLib.at(contractItem, "\"address\"");
        string memory addressStr = JSONParserLib.decodeString(
            JSONParserLib.value(addressItem)
        );
        contractAddr = vm.parseAddress(addressStr);

        // Parse functions object
        // prettier-ignore
        JSONParserLib.Item memory functions = JSONParserLib.at(contractItem, "\"functions\"");

        // Check if functions object exists and is not empty
        if (
            JSONParserLib.isUndefined(functions) ||
            !JSONParserLib.isObject(functions)
        ) {
            contractSelectors = new bytes4[](1);
            contractSelectors[0] = bytes4(0xffffffff);
            return (contractAddr, contractSelectors);
        }

        // Get all children (selector keys) from the functions object
        JSONParserLib.Item[] memory functionItems = JSONParserLib.children(
            functions
        );
        uint256 selectorCount = functionItems.length;

        if (selectorCount == 0) {
            contractSelectors = new bytes4[](1);
            contractSelectors[0] = bytes4(0xffffffff);
            return (contractAddr, contractSelectors);
        }

        // Extract selectors from keys
        contractSelectors = new bytes4[](selectorCount);
        for (uint256 i = 0; i < selectorCount; i++) {
            // Get the key (selector as string like "0x12345678")
            string memory selectorKey = JSONParserLib.decodeString(
                JSONParserLib.key(functionItems[i])
            );
            // Parse selector string to bytes4
            contractSelectors[i] = bytes4(vm.parseBytes(selectorKey));
        }
    }

    /// @notice Populates arrays from the ".PERIPHERY" section.
    function _populatePeripheryContracts(
        JSONParserLib.Item memory networkPeriphery,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal pure returns (uint256) {
        uint256 contractCount = JSONParserLib.size(networkPeriphery);

        for (uint256 k = 0; k < contractCount; k++) {
            (
                address contractAddr,
                bytes4[] memory contractSelectors
            ) = _parsePeripheryContractData(networkPeriphery, k);
            contracts[contractIndex] = contractAddr;
            selectors[contractIndex] = contractSelectors;
            contractIndex++;
        }

        return contractIndex;
    }

    /// @notice Parses a single contract entry from the ".PERIPHERY" section.
    function _parsePeripheryContractData(
        JSONParserLib.Item memory networkPeriphery,
        uint256 contractIndex
    )
        internal
        pure
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        // Get the contract at the specified index
        JSONParserLib.Item memory contractItem = JSONParserLib.at(
            networkPeriphery,
            contractIndex
        );

        // 1. Parse contract address
        // prettier-ignore
        JSONParserLib.Item memory addressItem = JSONParserLib.at(contractItem, "\"address\"");
        string memory addressStr = JSONParserLib.decodeString(
            JSONParserLib.value(addressItem)
        );
        contractAddr = vm.parseAddress(addressStr);

        // 2. Parse selectors array
        // prettier-ignore
        JSONParserLib.Item memory selectorsItem = JSONParserLib.at(contractItem, "\"selectors\"");

        if (
            JSONParserLib.isUndefined(selectorsItem) ||
            !JSONParserLib.isArray(selectorsItem)
        ) {
            contractSelectors = new bytes4[](0);
            return (contractAddr, contractSelectors);
        }

        uint256 selectorCount = JSONParserLib.size(selectorsItem);
        contractSelectors = new bytes4[](selectorCount);

        for (uint256 m = 0; m < selectorCount; m++) {
            JSONParserLib.Item memory selectorItem = JSONParserLib.at(
                selectorsItem,
                m
            );
            // prettier-ignore
            JSONParserLib.Item memory selectorValue = JSONParserLib.at(selectorItem, "\"selector\"");
            string memory selectorStr = JSONParserLib.decodeString(
                JSONParserLib.value(selectorValue)
            );
            contractSelectors[m] = bytes4(vm.parseBytes(selectorStr));
        }
    }
}
