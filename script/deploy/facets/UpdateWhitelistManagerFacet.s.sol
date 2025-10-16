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

        // Read addresses to add for the current network
        string memory addressesPath = string.concat(
            root,
            "/config/whitelistedAddresses.json"
        );
        string memory addressesJson = vm.readFile(addressesPath);
        bytes memory rawAddresses = addressesJson.parseRaw(
            string.concat(".", network)
        );
        address[] memory contractsToAdd = abi.decode(
            rawAddresses,
            (address[])
        );

        // Read selectors to add
        string memory selectorsToAddPath = string.concat(
            root,
            "/config/whitelistedSelectors.json"
        );
        string memory selectorsToAddJson = vm.readFile(selectorsToAddPath);
        string[] memory rawSelectorsToAdd = vm.parseJsonStringArray(
            selectorsToAddJson,
            ".selectors"
        );
        bytes4[] memory selectorsToAdd = new bytes4[](
            rawSelectorsToAdd.length
        );
        for (uint256 i = 0; i < rawSelectorsToAdd.length; i++) {
            selectorsToAdd[i] = bytes4(vm.parseBytes(rawSelectorsToAdd[i]));
        }

        // Merge .functionSelectorsToRemove with new whitelisted selectors and deduplicate
        bytes4[] memory mergedSelectorsToRemove = _mergeUnique(
            selectorsToRemove,
            selectorsToAdd
        );

        bytes memory callData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            mergedSelectorsToRemove,
            contractsToAdd,
            selectorsToAdd
        );

        return callData;
    }

    function _mergeUnique(
        bytes4[] memory a,
        bytes4[] memory b
    ) internal pure returns (bytes4[] memory out) {
        // upper-bound tmp, then compact
        bytes4[] memory tmp = new bytes4[](a.length + b.length);
        uint256 n;

        // add unique from a
        for (uint256 i; i < a.length; ++i) {
            if (!_contains(tmp, n, a[i])) tmp[n++] = a[i];
        }
        // add unique from b
        for (uint256 j; j < b.length; ++j) {
            if (!_contains(tmp, n, b[j])) tmp[n++] = b[j];
        }

        out = new bytes4[](n);
        for (uint256 k; k < n; ++k) out[k] = tmp[k];
    }

    function _contains(
        bytes4[] memory arr,
        uint256 len,
        bytes4 v
    ) internal pure returns (bool) {
        for (uint256 i; i < len; ++i) if (arr[i] == v) return true;
        return false;
    }
}
