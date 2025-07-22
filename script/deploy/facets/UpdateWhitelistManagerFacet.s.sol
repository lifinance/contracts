// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct SelectorsConfig {
        bytes4[] selectors;
    }

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
        // Read selectors to remove from flattened scan results
        string memory selectorsToRemovePath = string.concat(
            root,
            "/script/migration/flattened-scan-selector-approvals.json"
        );
        string memory selectorsToRemoveJson = vm.readFile(
            selectorsToRemovePath
        );
        bytes memory rawSelectorsToRemove = selectorsToRemoveJson.parseRaw(
            ".selectors"
        );
        bytes4[] memory selectorsToRemove = abi.decode(
            rawSelectorsToRemove,
            (bytes4[])
        );

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
        bytes memory rawSelectorsToAdd = selectorsToAddJson.parseRaw(
            ".selectors"
        );
        bytes4[] memory selectorsToAdd = abi.decode(
            rawSelectorsToAdd,
            (bytes4[])
        );

        bytes memory callData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove,
            contractsToAdd,
            selectorsToAdd
        );

        return callData;
    }
}
