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
        // --- 1. Read Selectors to Remove ---
        string memory selectorsToRemovePath = string.concat(
            root,
            "/config/functionSelectorsToRemove.json"
        );
        string memory selectorsToRemoveJson = vm.readFile(
            selectorsToRemovePath
        );
        // Example: `{"functionSelectorsToRemove": ["0x12345678", "0xabcdef01"]}`
        string[] memory rawSelectorsToRemove = vm.parseJsonStringArray(
            selectorsToRemoveJson,
            ".functionSelectorsToRemove"
        );

        // Convert string selectors to bytes4
        bytes4[] memory selectorsToRemove = new bytes4[](
            rawSelectorsToRemove.length
        );
        for (uint256 i = 0; i < rawSelectorsToRemove.length; i++) {
            selectorsToRemove[i] = bytes4(
                vm.parseBytes(rawSelectorsToRemove[i])
            );
        }

        // --- 2. Read Whitelist JSON ---
        string memory whitelistJson;
        string memory fallbackPath = string.concat(
            root,
            "/config/whitelist.json"
        );

        if (bytes(fileSuffix).length == 0) {
            // No suffix provided, use the default production whitelist
            whitelistJson = vm.readFile(fallbackPath);
        } else {
            // A suffix (e.g., "staging.") is provided
            string memory stagingPath = string.concat(
                root,
                "/config/whitelist.",
                fileSuffix, // e.g., "staging."
                "json"
            );
            try vm.readFile(stagingPath) returns (string memory stagingJson) {
                // Staging file exists, use it
                whitelistJson = stagingJson;
            } catch {
                // Staging file not found, fall back to production whitelist
                whitelistJson = vm.readFile(fallbackPath);
            }
        }

        // --- 3. Parse Whitelist ---
        // This helper function does the heavy lifting of parsing the JSON
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _parseWhitelistJson(whitelistJson);

        // --- 4. ABI-Encode Call Data ---
        // This is the data that will be passed to the `migrate` function.
        bytes memory callData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove, // bytes4[]
            contracts, // address[]
            selectors // bytes4[][]
        );

        return callData;
    }

    /// @notice Orchestrates the parsing of the entire whitelist JSON.
    /// @param whitelistJson The raw JSON string content.
    /// @return allContracts An aggregated list of unique contract addresses.
    /// @return allSelectors A list of selector arrays, one for each address.
    function _parseWhitelistJson(
        string memory whitelistJson
    )
        internal
        returns (address[] memory allContracts, bytes4[][] memory allSelectors)
    {
        // 1. Parse the ".DEXS" section of the JSON
        (
            address[] memory dexContracts,
            bytes4[][] memory dexSelectors
        ) = _parseDexsSection(whitelistJson);

        // 2. Parse the ".PERIPHERY" section of the JSON
        (
            address[] memory peripheryContracts,
            bytes4[][] memory peripherySelectors
        ) = _parsePeripherySection(whitelistJson);

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
        // The JSON might have multiple entries for the same address.
        // This function combines them into a single entry with merged selectors.
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
     * @dev Needed because `memory` arrays are pointers; assigning just copies the pointer.
     * @param src The source array to copy.
     * @return dst A new `memory` array with the same content as `src`.
     */
    function _copyArrayBytes4(
        bytes4[] memory src
    ) internal pure returns (bytes4[] memory dst) {
        dst = new bytes4[](src.length);
        for (uint256 i = 0; i < src.length; i++) dst[i] = src[i];
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
        for (uint256 i = 0; i < baseArr.length; i++)
            merged[idx++] = baseArr[i];

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
    /// @dev Uses a two-pass strategy: first count, then allocate, then populate.
    /// @param whitelistJson The raw JSON string.
    /// @return contracts Array of addresses from the DEXS section.
    /// @return selectors Array of selector arrays for each address.
    function _parseDexsSection(
        string memory whitelistJson
    )
        internal
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // 1. Count total contracts for this network to pre-allocate arrays
        uint256 totalContracts = _countDexsContracts(whitelistJson);

        // 2. Allocate arrays
        contracts = new address[](totalContracts);
        selectors = new bytes4[][](totalContracts);

        // 3. Populate arrays with data
        uint256 contractIndex = 0;
        contractIndex = _populateDexsContracts(
            whitelistJson,
            contracts,
            selectors,
            contractIndex
        );
    }

    /// @notice Parses the ".PERIPHERY" section of the whitelist JSON.
    /// @dev Uses a two-pass strategy: first count, then allocate, then populate.
    /// @param whitelistJson The raw JSON string.
    /// @return contracts Array of addresses from the PERIPHERY section.
    /// @return selectors Array of selector arrays for each address.
    function _parsePeripherySection(
        string memory whitelistJson
    )
        internal
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // Check if PERIPHERY section exists for current network
        string memory peripheryKey = string.concat(".PERIPHERY.", network);
        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            // 1. Count contracts
            uint256 totalContracts = _countPeripheryContracts(whitelistJson);

            // 2. Allocate arrays
            contracts = new address[](totalContracts);
            selectors = new bytes4[][](totalContracts);

            // 3. Populate arrays
            uint256 contractIndex = 0;
            contractIndex = _populatePeripheryContracts(
                whitelistJson,
                contracts,
                selectors,
                contractIndex
            );
        } catch {
            // Network not found, throw error
            revert(
                string.concat(
                    "PERIPHERY section does not exist for network: ",
                    network
                )
            );
        }
    }

    /// @notice Counts the total number of contracts in the ".DEXS" section
    /// for the current network.
    /// @param whitelistJson The raw JSON string.
    /// @return totalContracts The total count.
    function _countDexsContracts(
        string memory whitelistJson
    ) internal view returns (uint256 totalContracts) {
        // Get total number of DEXS entries in the ".DEXS" array
        uint256 totalDexs = _getArrayLength(whitelistJson, ".DEXS");

        // Iterate through each DEX entry
        for (uint256 dexIndex = 0; dexIndex < totalDexs; dexIndex++) {
            // Example key: ".DEXS[0].contracts.polygon"
            string memory networkKey = string.concat(
                ".DEXS[",
                vm.toString(dexIndex),
                "].contracts.",
                network
            );

            // Check if this DEX has an entry for the current network
            try vm.parseJson(whitelistJson, networkKey) returns (
                bytes memory
            ) {
                // Network exists, count how many contracts are in its array
                uint256 contractCount = _getArrayLength(
                    whitelistJson,
                    networkKey
                );
                totalContracts += contractCount;
            } catch {
                // Network not found for this DEX, continue to next
            }
        }
    }

    /**
     * @notice Counts the total number of contracts in the ".PERIPHERY" section
     * for the *current network*.
     * @param whitelistJson The raw JSON string.
     * @return totalContracts The total count.
     */
    function _countPeripheryContracts(
        string memory whitelistJson
    ) internal view returns (uint256 totalContracts) {
        // Example key: ".PERIPHERY.polygon"
        string memory peripheryKey = string.concat(".PERIPHERY.", network);

        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            // If the key exists, get the length of the array at that key
            totalContracts = _getArrayLength(whitelistJson, peripheryKey);
        } catch {
            // Network section not found, return 0
        }

        return totalContracts;
    }

    /// @notice Populates the `contracts` and `selectors` arrays with data
    /// from the ".DEXS" section.
    /// @param whitelistJson The raw JSON string.
    /// @param contracts The pre-allocated array to fill with addresses.
    /// @param selectors The pre-allocated array to fill with selector arrays.
    /// @param contractIndex The starting index to write into the arrays.
    /// @return The updated contractIndex after filling.
    function _populateDexsContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal returns (uint256) {
        // Get total number of DEXS
        uint256 totalDexs = _getArrayLength(whitelistJson, ".DEXS");

        // Iterate through each DEX and populate contracts for current network
        for (uint256 dexIndex = 0; dexIndex < totalDexs; dexIndex++) {
            contractIndex = _processDexContracts(
                whitelistJson,
                contracts,
                selectors,
                contractIndex,
                dexIndex
            );
        }

        return contractIndex;
    }

    /// @notice Helper for `_populateDexsContracts`. Processes a single DEX entry.
    function _processDexContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 dexIndex
    ) internal returns (uint256) {
        // Example key: ".DEXS[0].contracts.polygon"
        string memory networkKey = string.concat(
            ".DEXS[",
            vm.toString(dexIndex),
            "].contracts.",
            network
        );
        try vm.parseJson(whitelistJson, networkKey) returns (bytes memory) {
            // Get number of contracts for this specific DEX on this network
            uint256 contractCount = _getArrayLength(whitelistJson, networkKey);
            if (contractCount > 0) {
                // Populate the data for these contracts
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

    /// @notice Helper for `_processDexContracts`. Populates the data for all
    /// contracts within a single DEX entry.
    function _populateContractsForDex(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex,
        uint256 dexIndex,
        uint256 contractCount
    ) internal returns (uint256) {
        // Loop through each contract in the array (e.g., ".DEXS[0].contracts.polygon[0]")
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

    /// @notice Parses a single contract entry from the ".DEXS" section.
    function _parseContractData(
        string memory whitelistJson,
        uint256 dexIndex,
        uint256 contractIndex
    )
        internal
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        // Example key: ".DEXS[0].contracts.polygon[0]"
        string memory contractKey = string.concat(
            ".DEXS[",
            vm.toString(dexIndex),
            "].contracts.",
            network,
            "[",
            vm.toString(contractIndex),
            "]"
        );
        // Example key: ".DEXS[0].contracts.polygon[0].address"
        string memory addressKey = string.concat(contractKey, ".address");

        // 1. Parse contract address
        string memory addressStr = vm.parseJsonString(
            whitelistJson,
            addressKey
        );
        contractAddr = vm.parseAddress(addressStr);

        // 2. Find and extract the ".functions" object as a string
        // We use the raw `addressStr` (lowercase) for string matching
        string memory functionsAscii = _extractFunctionsAsciiByAddress(
            whitelistJson,
            addressStr
        );

        // 3. Parse the extracted string to get the selectors
        contractSelectors = _parseFunctionSelectors(functionsAscii);
    }

    /// @notice Utility to find the first occurrence of a `needle` in a `haystack`.
    /// @param haystack The bytes to search within.
    /// @param needle The bytes to search for.
    /// @param start The index to start searching from.
    /// @return The starting index of `needle` or -1 if not found.
    function _indexOf(
        bytes memory haystack,
        bytes memory needle,
        uint256 start
    ) internal pure returns (int256) {
        if (needle.length == 0 || haystack.length < needle.length) return -1;
        for (uint256 i = start; i + needle.length <= haystack.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return int256(i);
        }
        return -1;
    }

    /// @notice Utility to find the matching closing brace `}` for an opening brace `{`.
    /// @param data The bytes to search within.
    /// @param openIndex The index of the opening brace `{`.
    /// @return The index of the matching closing brace `}` or -1 if not found.
    function _findBalancedEnd(
        bytes memory data,
        uint256 openIndex
    ) internal pure returns (int256) {
        uint256 depth = 0;
        for (uint256 i = openIndex; i < data.length; i++) {
            bytes1 c = data[i];
            if (c == "{") depth++;
            if (c == "}") {
                if (depth == 0) return -1; // Unbalanced
                depth--;
                if (depth == 0) return int256(i); // Found matching brace
            }
        }
        return -1; // Not found
    }

    /// @notice Function finds and extracts a JSON object as a string.
    /// @dev This is a workaround for old `forge-std` limitations.
    /// It finds the `addressStr`, then finds the *next* `"functions"` key,
    /// then finds the `{...}` object after that key.
    /// @param whitelistJson The *entire* raw JSON string.
    /// @param addressStr The lowercase address string to search for.
    /// @return A simplified string representation of the `functions` object.
    /// Example: `{"0x12345678": "", "0xabcdef01": ""}`
    function _extractFunctionsAsciiByAddress(
        string memory whitelistJson,
        string memory addressStr
    ) internal pure returns (string memory) {
        bytes memory haystack = bytes(whitelistJson);
        bytes memory addr = bytes(addressStr);

        // 1. Find the address string in the JSON
        int256 addrPos = _indexOf(haystack, addr, 0);
        if (addrPos < 0) return "{}";

        // 2. Find the "functions" key (hex"2266756e6374696f6e7322" == `"functions"`)
        bytes memory key = hex"2266756e6374696f6e7322";
        uint256 from = uint256(addrPos) + addr.length;
        int256 keyPos = _indexOf(haystack, key, from);
        if (keyPos < 0) return "{}";

        // 3. Find the first `{` *after* the "functions" key
        uint256 braceStart = uint256(keyPos) + key.length;
        while (braceStart < haystack.length && haystack[braceStart] != "{") {
            braceStart++;
        }
        if (braceStart >= haystack.length) return "{}";

        // 4. Find the matching `}`
        int256 braceEnd = _findBalancedEnd(haystack, braceStart);
        if (braceEnd < 0) return "{}";

        // 5. Extract the raw `functions` object string (e.g., `{"0x123...": "swap(...)"}`)
        uint256 jsonLen = uint256(braceEnd) - braceStart + 1;
        bytes memory functionsJson = new bytes(jsonLen);
        for (uint256 i = 0; i < jsonLen; i++) {
            functionsJson[i] = haystack[braceStart + i];
        }

        // 6. Simplify the object string for the next parsing step
        //    (e.g., `{"0x123...": ""}`)
        return _extractSelectorKeysOnly(string(functionsJson));
    }

    /// @notice Simplifies a `functions` object string.
    /// @dev This function takes a raw `functions` object string and returns a new
    /// string containing only the keys (selectors) with empty string values.
    /// This is done because the next parser (`_parseFunctionSelectors`) is
    /// simpler and expects this format.
    /// @param functionsJson Raw object string.
    /// Example: `{"0x7617b389": "mixSwap(...)", "0x12345678": ""}`
    /// @return Simplified object string.
    /// Example: `{"0x7617b389": "", "0x12345678": ""}`
    function _extractSelectorKeysOnly(
        string memory functionsJson
    ) internal pure returns (string memory) {
        bytes memory jsonBytes = bytes(functionsJson);
        if (jsonBytes.length <= 2) return "{}";

        // --- First pass: count selector keys ---
        uint256 selectorCount = 0;
        for (uint256 i = 0; i < jsonBytes.length - 11; i++) {
            // Look for the pattern: "0x" + 8 hex chars + "
            // e.g., "0x12345678"
            if (
                jsonBytes[i] == 0x22 &&
                jsonBytes[i + 1] == 0x30 &&
                jsonBytes[i + 2] == 0x78 &&
                _isHexChar(jsonBytes[i + 3]) &&
                _isHexChar(jsonBytes[i + 4]) &&
                _isHexChar(jsonBytes[i + 5]) &&
                _isHexChar(jsonBytes[i + 6]) &&
                _isHexChar(jsonBytes[i + 7]) &&
                _isHexChar(jsonBytes[i + 8]) &&
                _isHexChar(jsonBytes[i + 9]) &&
                _isHexChar(jsonBytes[i + 10]) &&
                jsonBytes[i + 11] == 0x22
            ) {
                selectorCount++;
                i += 11; // Skip ahead
            }
        }

        if (selectorCount == 0) return "{}";

        // --- Second pass: build the simplified JSON string ---
        // Pre-calculate approximate length
        uint256 resultLen = 1 +
            selectorCount *
            16 +
            (selectorCount > 1 ? (selectorCount - 1) * 2 : 0) +
            1;
        bytes memory result = new bytes(resultLen);
        result[0] = "{";
        uint256 pos = 1;
        uint256 foundCount = 0;

        for (
            uint256 i = 0;
            i < jsonBytes.length - 11 && foundCount < selectorCount;
            i++
        ) {
            // Find the pattern again
            if (
                jsonBytes[i] == 0x22 &&
                jsonBytes[i + 1] == 0x30 &&
                jsonBytes[i + 2] == 0x78 &&
                _isHexChar(jsonBytes[i + 3]) &&
                _isHexChar(jsonBytes[i + 4]) &&
                _isHexChar(jsonBytes[i + 5]) &&
                _isHexChar(jsonBytes[i + 6]) &&
                _isHexChar(jsonBytes[i + 7]) &&
                _isHexChar(jsonBytes[i + 8]) &&
                _isHexChar(jsonBytes[i + 9]) &&
                _isHexChar(jsonBytes[i + 10]) &&
                jsonBytes[i + 11] == 0x22
            ) {
                if (foundCount > 0) {
                    // Add comma separator
                    if (pos + 1 >= resultLen) break;
                    result[pos++] = 0x2c; // ","
                    result[pos++] = 0x20; // " "
                }

                // Copy selector key: "0x12345678" (12 chars)
                if (pos + 11 >= resultLen) break;
                for (uint256 j = 0; j < 12; j++) {
                    result[pos++] = jsonBytes[i + j];
                }

                // Add empty value: : "" (4 chars)
                if (pos + 3 >= resultLen) break;
                result[pos++] = 0x3a; // ":"
                result[pos++] = 0x20; // " "
                result[pos++] = 0x22; // '"'
                result[pos++] = 0x22; // '"'

                foundCount++;
                i += 11; // Skip ahead
            }
        }

        // Close JSON object
        if (pos < resultLen) {
            result[pos] = 0x7d; // "}"
            pos++;
        } else if (pos == resultLen && resultLen > 0) {
            result[resultLen - 1] = 0x7d; // "}"
            pos = resultLen;
        }

        // Trim to actual length
        bytes memory trimmed = new bytes(pos);
        for (uint256 t = 0; t < pos; t++) {
            trimmed[t] = result[t];
        }

        return string(trimmed);
    }

    /// @notice Populates the `contracts` and `selectors` arrays with data
    /// from the ".PERIPHERY" section.
    function _populatePeripheryContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal returns (uint256) {
        // Example key: ".PERIPHERY.polygon"
        string memory peripheryKey = string.concat(".PERIPHERY.", network);

        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            uint256 contractCount = _getArrayLength(
                whitelistJson,
                peripheryKey
            );
            // Loop through each contract in the array (e.g., ".PERIPHERY.polygon[0]")
            for (uint256 k = 0; k < contractCount; k++) {
                (
                    address contractAddr,
                    bytes4[] memory contractSelectors
                ) = _parsePeripheryContractData(whitelistJson, k); // The *simple* parser
                contracts[contractIndex] = contractAddr;
                selectors[contractIndex] = contractSelectors;
                contractIndex++;
            }
        } catch {
            // Network section not found, continue
        }

        return contractIndex;
    }

    /// @notice Parses a single contract entry from the ".PERIPHERY" section.
    /// @dev This is much simpler than `_parseContractData` because the JSON
    /// structure for PERIPHERY is a simple array of selectors, which
    /// `vm.parseJsonString` can handle.
    function _parsePeripheryContractData(
        string memory whitelistJson,
        uint256 contractIndex
    )
        internal
        returns (address contractAddr, bytes4[] memory contractSelectors)
    {
        // Example key: ".PERIPHERY.polygon[0]"
        string memory contractKey = string.concat(
            ".PERIPHERY.",
            network,
            "[",
            vm.toString(contractIndex),
            "]"
        );
        // Example: ".PERIPHERY.polygon[0].address"
        string memory addressKey = string.concat(contractKey, ".address");
        // Example: ".PERIPHERY.polygon[0].selectors"
        string memory selectorsKey = string.concat(contractKey, ".selectors");

        // 1. Parse contract address
        string memory addressStr = vm.parseJsonString(
            whitelistJson,
            addressKey
        );
        contractAddr = vm.parseAddress(addressStr);

        // 2. Parse selectors array
        uint256 selectorCount = _getArrayLength(whitelistJson, selectorsKey);
        contractSelectors = new bytes4[](selectorCount);

        for (uint256 m = 0; m < selectorCount; m++) {
            // Example: ".PERIPHERY.polygon[0].selectors[0].selector"
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

    /// @notice Gets the length of a JSON array by trial and error.
    /// @dev It works by trying to access
    /// `key[0]`, `key[1]`, `key[2]`, etc., until it fails.
    /// @param json The raw JSON string.
    /// @param key The JSON key for the array. Example: ".DEXS"
    /// @return length The number of elements in the array.
    function _getArrayLength(
        string memory json,
        string memory key
    ) internal pure returns (uint256 length) {
        uint256 index = 0;

        while (true) {
            string memory indexedKey = string.concat(
                key,
                "[",
                vm.toString(index),
                "]"
            );
            try vm.parseJson(json, indexedKey) returns (bytes memory data) {
                // `vm.parseJson` can return empty `bytes` for `null` values,
                // but valid objects/arrays will have data.
                if (data.length > 0) {
                    index++;
                } else {
                    // Found a `null` or empty entry, assume end of array
                    break;
                }
            } catch {
                // Key (e.g., "DEXS[3]") not found, we've reached the end
                break;
            }
        }
        return index;
    }

    /// @notice Manually parses a simplified functions JSON string into an array of selectors.
    /// @param functionsJson A simplified JSON string.
    /// Example: `{"0x12345678": "", "0xabcdef01": ""}`
    /// @return selectors An array of `bytes4` selectors.
    /// If `functionsJson` is empty (`{}`), returns `[0xffffffff]`.
    function _parseFunctionSelectors(
        string memory functionsJson
    ) internal pure returns (bytes4[] memory selectors) {
        // Handle empty object: "{}"
        if (bytes(functionsJson).length <= 2) {
            // Use 0xffffffff as a ApproveTo-Only Selector (0xffffffff)
            // for backward compatibility.
            selectors = new bytes4[](1);
            selectors[0] = bytes4(0xffffffff);
            return selectors;
        }

        // 1. Count selectors (two-pass strategy)
        uint256 selectorCount = _countSelectorsInJson(functionsJson);

        if (selectorCount == 0) {
            // No selectors found, use the ApproveTo-Only Selector (0xffffffff)
            selectors = new bytes4[](1);
            selectors[0] = bytes4(0xffffffff);
            return selectors;
        }

        // 2. Allocate and populate array
        selectors = new bytes4[](selectorCount);
        _extractSelectorsFromJson(functionsJson, selectors);

        return selectors;
    }

    /// @notice Helper for `_parseFunctionSelectors`. Counts selectors in the simplified JSON.
    /// @param functionsJson Simplified JSON string.
    /// @return selectorCount The number of `0x...` patterns found.
    function _countSelectorsInJson(
        string memory functionsJson
    ) internal pure returns (uint256 selectorCount) {
        bytes memory jsonBytes = bytes(functionsJson);

        // We are looking for the 10-char pattern "0x12345678"
        if (jsonBytes.length < 10) return 0;
        for (uint256 i = 0; i < jsonBytes.length - 9; i++) {
            if (_isSelectorPattern(jsonBytes, i)) {
                selectorCount++;
            }
        }
    }

    /// @notice Helper for `_parseFunctionSelectors`. Extracts selectors into the array.
    /// @param functionsJson Simplified JSON string.
    /// @param selectors The pre-allocated array to fill.
    function _extractSelectorsFromJson(
        string memory functionsJson,
        bytes4[] memory selectors
    ) internal pure {
        bytes memory jsonBytes = bytes(functionsJson);
        uint256 selectorIndex = 0;

        // Loop and find all patterns
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

    /// @notice Checks for the 10-char selector pattern `0x[8 hex chars]`
    /// starting at a specific index.
    /// @param jsonBytes The bytes to check.
    /// @param i The starting index.
    /// @return true if the pattern matches, false otherwise.
    function _isSelectorPattern(
        bytes memory jsonBytes,
        uint256 i
    ) internal pure returns (bool) {
        // Note: We don't need to check for surrounding quotes `"`
        // because `_extractSelectorKeysOnly` already formats the string
        // in a way that `_isHexChar` checks are sufficient.
        return
            jsonBytes[i] == "0" &&
            jsonBytes[i + 1] == "x" &&
            _isHexChar(jsonBytes[i + 2]) &&
            _isHexChar(jsonBytes[i + 3]) &&
            _isHexChar(jsonBytes[i + 4]) &&
            _isHexChar(jsonBytes[i + 5]) &&
            _isHexChar(jsonBytes[i + 6]) &&
            _isHexChar(jsonBytes[i + 7]) &&
            _isHexChar(jsonBytes[i + 8]) &&
            _isHexChar(jsonBytes[i + 9]);
    }

    /// @notice Extracts the `bytes4` selector found at a specific index.
    /// @param jsonBytes The bytes to extract from.
    /// @param i The starting index of the "0x"
    /// @return The `bytes4` selector.
    function _extractSelectorAt(
        bytes memory jsonBytes,
        uint256 i
    ) internal pure returns (bytes4) {
        // Create a new 10-byte array (e.g., "0x12345678")
        bytes memory selectorBytes = new bytes(10);
        for (uint256 j = 0; j < 10; j++) {
            selectorBytes[j] = jsonBytes[i + j];
        }
        string memory selectorStr = string(selectorBytes);

        // Use cheat code to parse the string "0x..." into bytes
        return bytes4(vm.parseBytes(selectorStr));
    }

    /// @notice A utility function that appears to be a duplicate/alternative
    /// of `_parseFunctionSelectors` but operates on `bytes`.
    /// @dev This function is not explicitly called by `getCallData`'s flow
    /// but is part of the original contract.
    function _extractSelectorsFromJsonBytes(
        bytes memory data
    ) internal pure returns (bytes4[] memory) {
        if (data.length == 0) {
            bytes4[] memory approveToOnlySelector = new bytes4[](1);
            approveToOnlySelector[0] = bytes4(0xffffffff);
            return approveToOnlySelector;
        }
        // 1. Count occurrences of 0x + 8 hex
        uint256 count = 0;
        for (uint256 i = 0; i + 9 < data.length; i++) {
            if (data[i] == "0" && data[i + 1] == "x") {
                bool valid = true;
                for (uint256 h = i + 2; h < i + 10; h++) {
                    if (!_isHexChar(data[h])) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    count++;
                    i += 9; // Skip this selector
                }
            }
        }
        if (count == 0) {
            bytes4[] memory approveToOnlySelector2 = new bytes4[](1);
            approveToOnlySelector2[0] = bytes4(0xffffffff);
            return approveToOnlySelector2;
        }

        // 2. Populate
        bytes4[] memory selectors = new bytes4[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i + 9 < data.length && idx < count; i++) {
            if (data[i] == "0" && data[i + 1] == "x") {
                bool valid = true;
                for (uint256 h = i + 2; h < i + 10; h++) {
                    if (!_isHexChar(data[h])) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    bytes memory s = new bytes(10);
                    for (uint256 j = 0; j < 10; j++) s[j] = data[i + j];
                    selectors[idx] = bytes4(vm.parseBytes(string(s)));
                    idx++;
                    i += 9; // Skip this selector
                }
            }
        }
        return selectors;
    }

    /// @notice Utility to check if a byte is a valid hexadecimal character.
    /// @param char The byte to check.
    /// @return true if it is a hex char (0-9, a-f, A-F), false otherwise.
    function _isHexChar(bytes1 char) internal pure returns (bool) {
        return
            (char >= "0" && char <= "9") ||
            (char >= "a" && char <= "f") ||
            (char >= "A" && char <= "F");
    }
}
