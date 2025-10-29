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
            "/config/functionSelectorsToRemove.json"
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

        // Read appropriate whitelist file based on environment and extract contract-selector pairs for current network
        string memory whitelistPath;
        if (bytes(fileSuffix).length == 0) {
            whitelistPath = string.concat(root, "/config/whitelist.json");
        } else {
            whitelistPath = string.concat(
                root,
                "/config/whitelist.staging.json"
            );
        }
        string memory whitelistJson = vm.readFile(whitelistPath);

        // Parse the whitelist file structure and extract contracts for current network
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

        // Aggregate duplicate addresses and merge their selectors
        (allContracts, allSelectors) = _aggregateByAddress(
            allContracts,
            allSelectors
        );
    }

    // Aggregate duplicate addresses and merge unique selectors per address
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
        outContracts = new address[](n);
        outSelectors = new bytes4[][](n);
        uint256 outCount = 0;
        for (uint256 i = 0; i < n; i++) {
            if (visited[i]) continue;
            visited[i] = true;
            bytes4[] memory merged = _copyArrayBytes4(selectors[i]);
            for (uint256 j = i + 1; j < n; j++) {
                if (!visited[j] && contracts[j] == contracts[i]) {
                    visited[j] = true;
                    merged = _mergeUniqueBytes4(merged, selectors[j]);
                }
            }
            outContracts[outCount] = contracts[i];
            outSelectors[outCount] = merged;
            outCount++;
        }
        address[] memory trimmedContracts = new address[](outCount);
        bytes4[][] memory trimmedSelectors = new bytes4[][](outCount);
        for (uint256 k = 0; k < outCount; k++) {
            trimmedContracts[k] = outContracts[k];
            trimmedSelectors[k] = outSelectors[k];
        }
        return (trimmedContracts, trimmedSelectors);
    }

    function _copyArrayBytes4(
        bytes4[] memory src
    ) internal pure returns (bytes4[] memory dst) {
        dst = new bytes4[](src.length);
        for (uint256 i = 0; i < src.length; i++) dst[i] = src[i];
    }

    function _mergeUniqueBytes4(
        bytes4[] memory baseArr,
        bytes4[] memory addArr
    ) internal pure returns (bytes4[] memory) {
        uint256 addCount = 0;
        for (uint256 i = 0; i < addArr.length; i++) {
            if (!_containsBytes4(baseArr, addArr[i])) {
                addCount++;
            }
        }
        if (addCount == 0) return baseArr;
        bytes4[] memory merged = new bytes4[](baseArr.length + addCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < baseArr.length; i++)
            merged[idx++] = baseArr[i];
        for (uint256 i = 0; i < addArr.length; i++) {
            if (!_containsBytes4(baseArr, addArr[i])) {
                merged[idx++] = addArr[i];
            }
        }
        return merged;
    }

    function _containsBytes4(
        bytes4[] memory arr,
        bytes4 val
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == val) return true;
        }
        return false;
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
    ) internal view returns (uint256 totalContracts) {
        // Count contracts by iterating through DEXS array
        uint256 dexIndex = 0;
        uint256 maxDexs = 1000; // Safety limit to prevent infinite loops and excessive gas usage

        while (dexIndex < maxDexs) {
            string memory dexKey = string.concat(
                ".DEXS[",
                vm.toString(dexIndex),
                "]"
            );

            // Check if DEX exists by looking for "name" field
            bytes memory nameBytes = vm.parseJson(
                whitelistJson,
                string.concat(dexKey, ".name")
            );

            // If name is empty or very short, likely no DEX exists
            if (nameBytes.length == 0 || nameBytes.length < 2) {
                // Check a few more indices to be sure
                for (
                    uint256 i = dexIndex + 1;
                    i < dexIndex + 3 && i < maxDexs;
                    i++
                ) {
                    bytes memory nextNameBytes = vm.parseJson(
                        whitelistJson,
                        string.concat(".DEXS[", vm.toString(i), "].name")
                    );
                    if (
                        nextNameBytes.length == 0 || nextNameBytes.length < 2
                    ) {
                        // No more DEX entries found
                        break;
                    }
                }
                return totalContracts; // Stop here
            }

            // DEX exists, check if it has contracts for current network
            string memory networkKey = string.concat(
                ".DEXS[",
                vm.toString(dexIndex),
                "].contracts.",
                network
            );
            bytes memory networkData = vm.parseJson(whitelistJson, networkKey);

            if (networkData.length > 0) {
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
            }
            dexIndex++;
        }
    }

    function _countPeripheryContracts(
        string memory whitelistJson
    ) internal view returns (uint256 totalContracts) {
        string memory peripheryKey = string.concat(".PERIPHERY.", network);

        // Count contracts in the network's periphery section
        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            totalContracts = _getArrayLength(whitelistJson, peripheryKey);
        } catch {
            // Network section not found, return 0
        }

        return totalContracts;
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

            // Check if DEX exists by looking for "name" field
            bytes memory nameBytes = vm.parseJson(
                whitelistJson,
                string.concat(dexKey, ".name")
            );

            // If name is empty or very short, likely no DEX exists
            if (nameBytes.length == 0 || nameBytes.length < 2) {
                // Check a few more indices to be sure
                bool foundNext = false;
                for (
                    uint256 i = dexIndex + 1;
                    i < dexIndex + 3 && i < maxDexs;
                    i++
                ) {
                    bytes memory nextNameBytes = vm.parseJson(
                        whitelistJson,
                        string.concat(".DEXS[", vm.toString(i), "].name")
                    );
                    if (nextNameBytes.length > 2) {
                        foundNext = true;
                        break;
                    }
                }
                if (!foundNext) {
                    // No more DEX entries found
                    break;
                }
            } else {
                // DEX exists, process it
                contractIndex = _processDexContracts(
                    whitelistJson,
                    contracts,
                    selectors,
                    contractIndex,
                    dexIndex
                );
            }
            dexIndex++;
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

        // Parse contract address
        string memory addressStr = vm.parseJsonString(
            whitelistJson,
            addressKey
        );
        contractAddr = vm.parseAddress(addressStr);

        // Skip vm.parseJson entirely - it encodes the JSON object in a way that loses the raw selector strings
        // Use direct ASCII extraction from the full JSON
        // Note: use the original addressStr from JSON (lowercase) for searching, not the checksummed address
        string memory functionsAscii = _extractFunctionsAsciiByAddress(
            whitelistJson,
            addressStr
        );
        contractSelectors = _parseFunctionSelectors(functionsAscii);
    }

    // Helpers to robustly extract the functions JSON object adjacent to an address
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

    function _findBalancedEnd(
        bytes memory data,
        uint256 openIndex
    ) internal pure returns (int256) {
        uint256 depth = 0;
        for (uint256 i = openIndex; i < data.length; i++) {
            bytes1 c = data[i];
            if (c == "{") depth++;
            if (c == "}") {
                if (depth == 0) return -1;
                depth--;
                if (depth == 0) return int256(i);
            }
        }
        return -1;
    }

    function _extractFunctionsAsciiByAddress(
        string memory whitelistJson,
        string memory addressStr
    ) internal pure returns (string memory) {
        bytes memory haystack = bytes(whitelistJson);
        bytes memory addr = bytes(addressStr);

        int256 addrPos = _indexOf(haystack, addr, 0);
        if (addrPos < 0) return "{}";
        // Use hex encoding to avoid quote conflicts: "functions" = 2266756e6374696f6e73
        bytes memory key = hex"2266756e6374696f6e7322";
        uint256 from = uint256(addrPos) + addr.length;
        int256 keyPos = _indexOf(haystack, key, from);
        if (keyPos < 0) return "{}";
        // find first "{" after key
        uint256 braceStart = uint256(keyPos) + key.length;
        while (braceStart < haystack.length && haystack[braceStart] != "{") {
            braceStart++;
        }
        if (braceStart >= haystack.length) return "{}";
        int256 braceEnd = _findBalancedEnd(haystack, braceStart);
        if (braceEnd < 0) return "{}";
        uint256 len = uint256(braceEnd) - braceStart + 1;
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = haystack[braceStart + i];
        return string(out);
    }

    function _populatePeripheryContracts(
        string memory whitelistJson,
        address[] memory contracts,
        bytes4[][] memory selectors,
        uint256 contractIndex
    ) internal returns (uint256) {
        string memory peripheryKey = string.concat(".PERIPHERY.", network);

        // Populate contracts from the network's periphery section
        try vm.parseJson(whitelistJson, peripheryKey) returns (bytes memory) {
            uint256 contractCount = _getArrayLength(
                whitelistJson,
                peripheryKey
            );
            for (uint256 k = 0; k < contractCount; k++) {
                (
                    address contractAddr,
                    bytes4[] memory contractSelectors
                ) = _parsePeripheryContractData(whitelistJson, k);
                contracts[contractIndex] = contractAddr;
                selectors[contractIndex] = contractSelectors;
                contractIndex++;
            }
        } catch {
            // Network section not found, continue
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
    ) internal pure returns (uint256 length) {
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
    ) internal pure returns (bytes4[] memory selectors) {
        // Check if functions object is empty
        if (bytes(functionsJson).length <= 2) {
            // "{}" or similar
            // Empty functions object - use 0xffffffff marker selector for backward compatibility
            selectors = new bytes4[](1);
            selectors[0] = bytes4(0xffffffff);
            return selectors;
        }

        // Count selectors first
        uint256 selectorCount = _countSelectorsInJson(functionsJson);

        // If no selectors found, return marker selector
        if (selectorCount == 0) {
            selectors = new bytes4[](1);
            selectors[0] = bytes4(0xffffffff);
            return selectors;
        }

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
        // Pattern is: 0x12345678 = 10 bytes total, so we need to check up to i+9
        if (jsonBytes.length < 10) return 0;
        for (uint256 i = 0; i < jsonBytes.length - 9; i++) {
            if (_isSelectorPattern(jsonBytes, i)) {
                selectorCount++;
            }
        }
    }

    function _extractSelectorsFromJson(
        string memory functionsJson,
        bytes4[] memory selectors
    ) internal pure {
        bytes memory jsonBytes = bytes(functionsJson);
        uint256 selectorIndex = 0;

        // Pattern is: 0x12345678 = 10 bytes total, so we need to check up to i+9
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
        // Match pattern: "0x" followed by exactly 8 hex characters and then "
        // Don't require quote at start (i) - just look for the pattern itself
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

    function _extractSelectorAt(
        bytes memory jsonBytes,
        uint256 i
    ) internal pure returns (bytes4) {
        // Extract the selector string: 0x12345678 (10 chars total)
        // i points to "0", so we take bytes from i to i+9
        bytes memory selectorBytes = new bytes(10);
        for (uint256 j = 0; j < 10; j++) {
            selectorBytes[j] = jsonBytes[i + j];
        }
        string memory selectorStr = string(selectorBytes);

        return bytes4(vm.parseBytes(selectorStr));
    }

    function _extractSelectorsFromJsonBytes(
        bytes memory data
    ) internal pure returns (bytes4[] memory) {
        if (data.length == 0) {
            bytes4[] memory markerSel = new bytes4[](1);
            markerSel[0] = bytes4(0xffffffff);
            return markerSel;
        }
        // Count occurrences of 0x + 8 hex
        uint256 count = 0;
        for (uint256 i = 0; i + 9 < data.length; i++) {
            if (data[i] == "0" && data[i + 1] == "x") {
                bool valid = true;
                for (uint256 h = i + 2; h < i + 10; h++) {
                    bytes1 c = data[h];
                    bool isHex = (c >= "0" && c <= "9") ||
                        (c >= "a" && c <= "f") ||
                        (c >= "A" && c <= "F");
                    if (!isHex) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    count++;
                    i += 9;
                }
            }
        }
        if (count == 0) {
            bytes4[] memory markerSel2 = new bytes4[](1);
            markerSel2[0] = bytes4(0xffffffff);
            return markerSel2;
        }
        bytes4[] memory selectors = new bytes4[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i + 9 < data.length && idx < count; i++) {
            if (data[i] == "0" && data[i + 1] == "x") {
                bool valid = true;
                for (uint256 h = i + 2; h < i + 10; h++) {
                    bytes1 c = data[h];
                    bool isHex = (c >= "0" && c <= "9") ||
                        (c >= "a" && c <= "f") ||
                        (c >= "A" && c <= "F");
                    if (!isHex) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    bytes memory s = new bytes(10);
                    for (uint256 j = 0; j < 10; j++) s[j] = data[i + j];
                    selectors[idx] = bytes4(vm.parseBytes(string(s)));
                    idx++;
                    i += 9;
                }
            }
        }
        return selectors;
    }

    function _isHexChar(bytes1 char) internal pure returns (bool) {
        return
            (char >= "0" && char <= "9") ||
            (char >= "a" && char <= "f") ||
            (char >= "A" && char <= "F");
    }
}
