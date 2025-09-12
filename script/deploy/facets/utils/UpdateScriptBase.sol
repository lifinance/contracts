// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

abstract contract UpdateScriptBase is ScriptBase {
    using stdJson for string;

    error InvalidHexDigit(uint8 d);

    struct FunctionSignature {
        string name;
        bytes sig;
    }

    struct Approval {
        address aTokenAddress;
        address bContractAddress;
    }

    address internal diamond;
    LibDiamond.FacetCut[] internal cut;
    bytes4[] internal selectorsToReplace;
    bytes4[] internal selectorsToRemove;
    bytes4[] internal selectorsToAdd;
    DiamondCutFacet internal cutter;
    DiamondLoupeFacet internal loupe;
    string internal path;
    string internal json;
    bool internal noBroadcast = false;
    bool internal useDefaultDiamond;

    constructor() {
        useDefaultDiamond = _shouldUseDefaultDiamond();
        noBroadcast = vm.envOr("NO_BROADCAST", false);

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        diamond = _getDiamondAddress();
        cutter = DiamondCutFacet(diamond);
        loupe = DiamondLoupeFacet(diamond);
    }

    /// @notice Gets the diamond address based on configuration
    /// @dev Override this method to customize diamond address selection
    function _getDiamondAddress() internal virtual returns (address) {
        // Default implementation for regular UpdateScript behavior
        return
            useDefaultDiamond
                ? json.readAddress(".LiFiDiamond")
                : json.readAddress(".LiFiDiamondImmutable");
    }

    /// @notice Determines if default diamond should be used
    /// @dev Override this method to customize diamond selection logic
    function _shouldUseDefaultDiamond() internal virtual returns (bool) {
        return vm.envOr("USE_DEF_DIAMOND", true);
    }

    /// @notice Approves refund wallet for specific function signatures
    function approveRefundWallet() internal {
        // get refund wallet address from global config file
        string memory globalPath = string.concat(root, "/config/global.json");
        string memory globalJson = vm.readFile(globalPath);
        address refundWallet = globalJson.readAddress(".refundWallet");

        // get function signatures that should be approved for refundWallet
        bytes memory rawConfig = globalJson.parseRaw(
            ".approvedSigsForRefundWallet"
        );

        // parse raw data from config into FunctionSignature array
        FunctionSignature[] memory funcSigsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSignature[])
        );

        // go through array with function signatures
        for (uint256 i = 0; i < funcSigsToBeApproved.length; i++) {
            // Register refundWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSigsToBeApproved[i].sig),
                refundWallet,
                true
            );
        }
    }

    /// @notice Approves deployer wallet for specific function signatures
    function approveDeployerWallet() internal {
        // get deployer wallet address from global config file
        string memory globalPath = string.concat(root, "/config/global.json");
        string memory globalJson = vm.readFile(globalPath);
        address deployerWallet = globalJson.readAddress(".deployerWallet");

        // get function signatures that should be approved for deployerWallet
        bytes memory rawConfig = globalJson.parseRaw(
            ".approvedSigsForDeployerWallet"
        );

        // parse raw data from config into FunctionSignature array
        FunctionSignature[] memory funcSigsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSignature[])
        );

        // go through array with function signatures
        for (uint256 i = 0; i < funcSigsToBeApproved.length; i++) {
            // Register deployerWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSigsToBeApproved[i].sig),
                deployerWallet,
                true
            );
        }
    }

    /// @notice Updates multiple core facets from global.json configuration
    /// @param configKey The key in global.json to read facets from (e.g., ".coreFacets" or ".ldaCoreFacets")
    /// @return facets Array of facet addresses after update
    /// @return cutData Encoded diamond cut calldata (if noBroadcast is true)
    function updateCoreFacets(
        string memory configKey
    )
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        // Read core facets dynamically from global.json config
        string memory globalConfigPath = string.concat(
            vm.projectRoot(),
            "/config/global.json"
        );
        string memory globalConfig = vm.readFile(globalConfigPath);
        string[] memory coreFacets = globalConfig.readStringArray(configKey);

        emit log_uint(coreFacets.length);

        bytes4[] memory exclude;

        // Check if the loupe was already added to the diamond
        bool loupeExists = _checkLoupeExists();

        // Handle DiamondLoupeFacet separately as it needs special treatment
        if (!loupeExists) {
            _handleLoupeInstallation();
        }

        // Process all core facets dynamically
        for (uint256 i = 0; i < coreFacets.length; i++) {
            string memory facetName = coreFacets[i];

            // Skip DiamondCutFacet and DiamondLoupeFacet as they were already handled
            if (_shouldSkipCoreFacet(facetName)) {
                continue;
            }

            emit log(facetName);

            address facetAddress = _getConfigContractAddress(
                path,
                string.concat(".", facetName)
            );

            bytes4[] memory selectors = getSelectors(facetName, exclude);

            // at this point we know for sure that diamond loupe exists on diamond
            buildDiamondCut(selectors, facetAddress);
        }

        // Handle noBroadcast mode and broadcasting
        return _finalizeCut();
    }

    /// @notice Checks if DiamondLoupeFacet exists on the diamond
    /// @return loupeExists True if loupe exists, false otherwise
    function _checkLoupeExists() internal virtual returns (bool loupeExists) {
        try loupe.facetAddresses() returns (address[] memory) {
            // If call was successful, loupe exists on diamond already
            emit log("DiamondLoupeFacet exists on diamond already");
            loupeExists = true;
        } catch {
            // No need to do anything, just making sure that the flow continues in both cases with try/catch
        }
    }

    /// @notice Handles DiamondLoupeFacet installation if it doesn't exist
    function _handleLoupeInstallation() internal virtual {
        emit log("DiamondLoupeFacet does not exist on diamond yet");
        address diamondLoupeAddress = _getConfigContractAddress(
            path,
            ".DiamondLoupeFacet"
        );
        bytes4[] memory loupeSelectors = getSelectors(
            "DiamondLoupeFacet",
            new bytes4[](0)
        );

        buildInitialCut(loupeSelectors, diamondLoupeAddress);
        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        vm.stopBroadcast();

        // Reset diamond cut variable to remove diamondLoupe information
        delete cut;
    }

    /// @notice Determines if a facet should be skipped during core facets update
    /// @param facetName The name of the facet to check
    /// @return True if facet should be skipped, false otherwise
    function _shouldSkipCoreFacet(
        string memory facetName
    ) internal pure virtual returns (bool) {
        return (keccak256(bytes(facetName)) ==
            keccak256(bytes("DiamondLoupeFacet")) ||
            keccak256(bytes(facetName)) ==
            keccak256(bytes("DiamondCutFacet")));
    }

    /// @notice Finalizes the diamond cut operation
    /// @return facets Array of facet addresses after update
    /// @return cutData Encoded diamond cut calldata (if noBroadcast is true)
    function _finalizeCut()
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        // If noBroadcast is activated, we only prepare calldata for sending it to multisig SAFE
        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    address(0),
                    ""
                );
            }
            emit log("=== DIAMOND CUT CALLDATA FOR MANUAL EXECUTION ===");
            emit log_bytes(cutData);
            emit log("=== END CALLDATA ===");
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        vm.stopBroadcast();

        facets = loupe.facetAddresses();
    }

    function update(
        string memory name
    )
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        address facet = _getConfigContractAddress(
            path,
            string.concat(".", name)
        );

        bytes4[] memory excludes = getExcludes();
        bytes memory callData = getCallData();

        buildDiamondCut(getSelectors(name, excludes), facet);

        // prepare full diamondCut calldata and log for debugging purposes
        if (cut.length > 0) {
            cutData = abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                cut,
                callData.length > 0 ? facet : address(0),
                callData
            );

            emit log("DiamondCutCalldata: ");
            emit log_bytes(cutData);
        }

        if (noBroadcast) {
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);

        if (cut.length > 0) {
            cutter.diamondCut(
                cut,
                callData.length > 0 ? facet : address(0),
                callData
            );
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }

    function getExcludes() internal virtual returns (bytes4[] memory) {}

    function getCallData() internal virtual returns (bytes memory) {}

    function getSelectors(
        string memory _facetName,
        bytes4[] memory _exclude
    ) internal returns (bytes4[] memory selectors) {
        string[] memory cmd = new string[](3);
        cmd[0] = "script/deploy/facets/utils/contract-selectors.sh";
        cmd[1] = _facetName;
        string memory exclude;
        for (uint256 i; i < _exclude.length; i++) {
            exclude = string.concat(exclude, fromCode(_exclude[i]), " ");
        }
        cmd[2] = exclude;
        bytes memory res = vm.ffi(cmd);
        selectors = abi.decode(res, (bytes4[]));
    }

    function buildDiamondCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        address oldFacet;

        selectorsToAdd = new bytes4[](0);
        selectorsToReplace = new bytes4[](0);
        selectorsToRemove = new bytes4[](0);

        // Get selectors to add or replace
        for (uint256 i; i < newSelectors.length; i++) {
            if (loupe.facetAddress(newSelectors[i]) == address(0)) {
                selectorsToAdd.push(newSelectors[i]);
                // Don't replace if the new facet address is the same as the old facet address
            } else if (loupe.facetAddress(newSelectors[i]) != newFacet) {
                selectorsToReplace.push(newSelectors[i]);
                oldFacet = loupe.facetAddress(newSelectors[i]);
            }
        }

        // Get selectors to remove
        bytes4[] memory oldSelectors = loupe.facetFunctionSelectors(oldFacet);
        for (uint256 i; i < oldSelectors.length; i++) {
            bool found = false;
            for (uint256 j; j < newSelectors.length; j++) {
                if (oldSelectors[i] == newSelectors[j]) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                selectorsToRemove.push(oldSelectors[i]);
            }
        }

        // Build diamond cut
        if (selectorsToReplace.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Replace,
                    functionSelectors: selectorsToReplace
                })
            );
        }

        if (selectorsToRemove.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: address(0),
                    action: LibDiamond.FacetCutAction.Remove,
                    functionSelectors: selectorsToRemove
                })
            );
        }

        if (selectorsToAdd.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Add,
                    functionSelectors: selectorsToAdd
                })
            );
        }
    }

    function buildInitialCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: newFacet,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: newSelectors
            })
        );
    }

    function toHexDigit(uint8 d) internal pure returns (bytes1) {
        if (0 <= d && d <= 9) {
            return bytes1(uint8(bytes1("0")) + d);
        } else if (10 <= uint8(d) && uint8(d) <= 15) {
            return bytes1(uint8(bytes1("a")) + d - 10);
        }
        revert InvalidHexDigit(d);
    }

    function fromCode(bytes4 code) public pure returns (string memory) {
        bytes memory result = new bytes(10);
        result[0] = bytes1("0");
        result[1] = bytes1("x");
        for (uint256 i = 0; i < 4; ++i) {
            result[2 * i + 2] = toHexDigit(uint8(code[i]) / 16);
            result[2 * i + 3] = toHexDigit(uint8(code[i]) % 16);
        }
        return string(result);
    }
}
