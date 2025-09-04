// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ScriptBase } from "../utils/ScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

// Import the external deployment script
import { DeployScript as DeployLiFiDEXAggregatorDiamondScript } from "./DeployLiFiDEXAggregatorDiamond.s.sol";

// Import all LDA facet deployment scripts
import { DeployScript as DeployAlgebraFacetScript } from "./DeployAlgebraFacet.s.sol";
import { DeployScript as DeployCoreRouteFacetScript } from "./DeployCoreRouteFacet.s.sol";
import { DeployScript as DeployCurveFacetScript } from "./DeployCurveFacet.s.sol";
import { DeployScript as DeployIzumiV3FacetScript } from "./DeployIzumiV3Facet.s.sol";
import { DeployScript as DeployNativeWrapperFacetScript } from "./DeployNativeWrapperFacet.s.sol";
import { DeployScript as DeploySyncSwapV2FacetScript } from "./DeploySyncSwapV2Facet.s.sol";
import { DeployScript as DeployUniV2StyleFacetScript } from "./DeployUniV2StyleFacet.s.sol";
import { DeployScript as DeployUniV3StyleFacetScript } from "./DeployUniV3StyleFacet.s.sol";
import { DeployScript as DeployVelodromeV2FacetScript } from "./DeployVelodromeV2Facet.s.sol";

// Import facet contracts for type casting
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";

/// @title DeployFullLiFiDexAggregator
/// @author LI.FI (https://li.fi)
/// @notice Deploy script for the complete LiFi DEX Aggregator Diamond with all facets
/// @dev This script orchestrates the entire LDA deployment process
contract DeployScript is ScriptBase {
    using stdJson for string;

    constructor() {}

    function run()
        public
        returns (
            LiFiDEXAggregatorDiamond deployed,
            bytes memory constructorArgs
        )
    {
        emit log("=== Starting Full LiFi DEX Aggregator Deployment ===");

        // Step 1: Check that core facets exist in regular deployment file
        emit log("Step 1: Verifying core facets are deployed...");
        _verifyCoreFacetsExist();

        // Step 2: Deploy LiFiDEXAggregatorDiamond using external script
        emit log("Step 2: Deploying LiFiDEXAggregatorDiamond...");
        deployed = _deployLDADiamond();
        constructorArgs = "";

        // Step 3: Add core facets to the LDA Diamond
        emit log("Step 3: Adding core facets to LDA Diamond...");
        _addCoreFacets(address(deployed));

        // Step 4: Deploy and add all LDA-specific facets
        emit log("Step 4: Deploying and adding LDA-specific facets...");
        address[] memory facetAddresses = _deployAndAddLDAFacets();

        // Step 5: Save all facet addresses to deployment file
        emit log("Step 5: Saving facet addresses to deployment file...");
        _saveFacetAddresses(address(deployed), facetAddresses);

        emit log("=== Full LiFi DEX Aggregator Deployment Complete ===");
        emit log_named_address(
            "LiFiDEXAggregatorDiamond deployed at:",
            address(deployed)
        );
    }

    function _verifyCoreFacetsExist() internal {
        string memory regularFileSuffix = _getRegularFileSuffix();
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            regularFileSuffix,
            "json"
        );

        // Read the regular deployment file
        string memory json = vm.readFile(path);

        // Check that all required core facets exist (from regular diamond)
        string[] memory requiredFacets = new string[](3);
        requiredFacets[0] = "DiamondCutFacet";
        requiredFacets[1] = "DiamondLoupeFacet";
        requiredFacets[2] = "OwnershipFacet";

        for (uint256 i = 0; i < requiredFacets.length; i++) {
            address facetAddress = json.readAddress(
                string.concat(".", requiredFacets[i])
            );
            require(
                facetAddress != address(0),
                string.concat(
                    "Required core facet not found: ",
                    requiredFacets[i]
                )
            );
            emit log_named_string("Verified core facet:", requiredFacets[i]);
            emit log_named_address("at", facetAddress);
        }

        emit log("All core facets verified successfully!");
    }

    function _deployLDADiamond() internal returns (LiFiDEXAggregatorDiamond) {
        emit log("Calling DeployLiFiDEXAggregatorDiamond script...");

        // Create and run the external deployment script
        DeployLiFiDEXAggregatorDiamondScript deployScript = new DeployLiFiDEXAggregatorDiamondScript();
        (LiFiDEXAggregatorDiamond diamond, ) = deployScript.run();

        emit log_named_address(
            "LiFiDEXAggregatorDiamond deployed successfully at:",
            address(diamond)
        );
        return diamond;
    }

    function _addCoreFacets(address ldaDiamond) internal {
        // Get core facet addresses from regular deployment file
        string memory regularFileSuffix = _getRegularFileSuffix();
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            regularFileSuffix,
            "json"
        );

        emit log_named_string(
            "Reading regular deployment file from path:",
            path
        );

        // Read the regular deployment file
        string memory json = vm.readFile(path);

        DiamondCutFacet cutter = DiamondCutFacet(ldaDiamond);

        // DiamondCutFacet is already added by the LiFiDiamond constructor
        emit log("DiamondCutFacet already exists from constructor - skipping");

        // Check if DiamondLoupeFacet exists by trying to call facetAddresses()
        bool loupeExists = _checkIfLoupeExists(ldaDiamond);
        bool ownershipExists = _checkIfOwnershipExists(ldaDiamond);

        emit log("DiamondLoupeFacet exists:");
        emit log(string.concat(vm.toString(loupeExists)));
        emit log("OwnershipFacet exists:");
        emit log(string.concat(vm.toString(ownershipExists)));

        // Build cuts only for facets that dont exist
        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](0);

        if (!loupeExists) {
            emit log("Adding DiamondLoupeFacet...");
            address diamondLoupeFacet = json.readAddress(".DiamondLoupeFacet");
            bytes4[] memory diamondLoupeSelectors = _getCoreFacetSelectors(
                "DiamondLoupeFacet"
            );

            cuts = _pushFacetCut(
                cuts,
                LibDiamond.FacetCut({
                    facetAddress: diamondLoupeFacet,
                    action: LibDiamond.FacetCutAction.Add,
                    functionSelectors: diamondLoupeSelectors
                })
            );
        } else {
            emit log("DiamondLoupeFacet already exists - skipping");
        }

        if (!ownershipExists) {
            emit log("Adding OwnershipFacet...");
            address ownershipFacet = json.readAddress(".OwnershipFacet");
            bytes4[] memory ownershipSelectors = _getCoreFacetSelectors(
                "OwnershipFacet"
            );

            cuts = _pushFacetCut(
                cuts,
                LibDiamond.FacetCut({
                    facetAddress: ownershipFacet,
                    action: LibDiamond.FacetCutAction.Add,
                    functionSelectors: ownershipSelectors
                })
            );
        } else {
            emit log("OwnershipFacet already exists - skipping");
        }

        // Execute diamond cut only if there are cuts to make
        if (cuts.length > 0) {
            emit log("Executing diamond cut for");
            emit log_named_uint("Cuts length:", cuts.length);
            try vm.stopBroadcast() {} catch {}
            vm.startBroadcast(deployerPrivateKey);
            cutter.diamondCut(cuts, address(0), "");
            vm.stopBroadcast();
            emit log("Core facets added successfully!");
        } else {
            emit log("All core facets already exist - no changes needed");
        }
    }

    function _checkIfLoupeExists(
        address ldaDiamond
    ) internal view returns (bool) {
        // Try to call facetAddresses() - if it works, DiamondLoupeFacet exists
        try DiamondLoupeFacet(ldaDiamond).facetAddresses() returns (
            address[] memory
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function _checkIfOwnershipExists(
        address ldaDiamond
    ) internal view returns (bool) {
        // Try to call owner() - if it works, OwnershipFacet exists
        // We need to use low-level call since we dont have OwnershipFacet interface imported
        (bool success, ) = ldaDiamond.staticcall(
            abi.encodeWithSignature("owner()")
        );
        return success;
    }

    function _pushFacetCut(
        LibDiamond.FacetCut[] memory existingCuts,
        LibDiamond.FacetCut memory newCut
    ) internal pure returns (LibDiamond.FacetCut[] memory) {
        LibDiamond.FacetCut[] memory newCuts = new LibDiamond.FacetCut[](
            existingCuts.length + 1
        );
        for (uint256 i = 0; i < existingCuts.length; i++) {
            newCuts[i] = existingCuts[i];
        }
        newCuts[existingCuts.length] = newCut;
        return newCuts;
    }

    function _deployAndAddLDAFacets() internal returns (address[] memory) {
        address[] memory facetAddresses = new address[](0);

        // Deploy and add AlgebraFacet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("AlgebraFacet")
        );

        // Deploy and add CoreRouteFacet (special case - returns tuple)
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddCoreRouteFacet()
        );

        // Deploy and add CurveFacet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("CurveFacet")
        );

        // Deploy and add IzumiV3Facet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("IzumiV3Facet")
        );

        // Deploy and add NativeWrapperFacet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("NativeWrapperFacet")
        );

        // Deploy and add SyncSwapV2Facet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("SyncSwapV2Facet")
        );

        // Deploy and add UniV2StyleFacet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("UniV2StyleFacet")
        );

        // Deploy and add UniV3StyleFacet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("UniV3StyleFacet")
        );

        // Deploy and add VelodromeV2Facet
        facetAddresses = _appendFacetAddress(
            facetAddresses,
            _deployAndAddSingleFacet("VelodromeV2Facet")
        );

        emit log("All LDA facets deployed and added successfully!");
        return facetAddresses;
    }

    function _appendFacetAddress(
        address[] memory existingAddresses,
        address newAddress
    ) internal pure returns (address[] memory) {
        address[] memory newAddresses = new address[](
            existingAddresses.length + 1
        );
        for (uint256 i = 0; i < existingAddresses.length; i++) {
            newAddresses[i] = existingAddresses[i];
        }
        newAddresses[existingAddresses.length] = newAddress;
        return newAddresses;
    }

    function _deployAndAddSingleFacet(
        string memory facetName
    ) internal returns (address) {
        emit log(string.concat("Deploying and adding ", facetName, "..."));

        // Ensure no broadcast is active before calling deployment script
        try vm.stopBroadcast() {} catch {}

        address facetAddress;

        if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("AlgebraFacet"))
        ) {
            DeployAlgebraFacetScript deployScript = new DeployAlgebraFacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("CurveFacet"))
        ) {
            DeployCurveFacetScript deployScript = new DeployCurveFacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("IzumiV3Facet"))
        ) {
            DeployIzumiV3FacetScript deployScript = new DeployIzumiV3FacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("NativeWrapperFacet"))
        ) {
            DeployNativeWrapperFacetScript deployScript = new DeployNativeWrapperFacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("SyncSwapV2Facet"))
        ) {
            DeploySyncSwapV2FacetScript deployScript = new DeploySyncSwapV2FacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("UniV2StyleFacet"))
        ) {
            DeployUniV2StyleFacetScript deployScript = new DeployUniV2StyleFacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("UniV3StyleFacet"))
        ) {
            DeployUniV3StyleFacetScript deployScript = new DeployUniV3StyleFacetScript();
            facetAddress = address(deployScript.run());
        } else if (
            keccak256(abi.encodePacked(facetName)) ==
            keccak256(abi.encodePacked("VelodromeV2Facet"))
        ) {
            DeployVelodromeV2FacetScript deployScript = new DeployVelodromeV2FacetScript();
            facetAddress = address(deployScript.run());
        } else {
            revert(string.concat("Unknown facet: ", facetName));
        }

        return facetAddress;
    }

    function _deployAndAddCoreRouteFacet() internal returns (address) {
        emit log("Deploying and adding CoreRouteFacet...");

        // Ensure no broadcast is active before calling deployment script
        try vm.stopBroadcast() {} catch {}

        DeployCoreRouteFacetScript deployScript = new DeployCoreRouteFacetScript();
        (CoreRouteFacet deployedFacet, ) = deployScript.run();
        address facetAddress = address(deployedFacet);

        return facetAddress;
    }

    function _getRegularFileSuffix() internal view returns (string memory) {
        string memory regularFileSuffix = fileSuffix;

        // Remove "lda." prefix to get regular deployment file
        if (bytes(fileSuffix).length >= 4) {
            bytes memory fileSuffixBytes = bytes(fileSuffix);
            bool hasLdaPrefix = (fileSuffixBytes[0] == "l" &&
                fileSuffixBytes[1] == "d" &&
                fileSuffixBytes[2] == "a" &&
                fileSuffixBytes[3] == ".");

            if (hasLdaPrefix) {
                bytes memory newSuffix = new bytes(fileSuffixBytes.length - 4);
                for (uint256 i = 4; i < fileSuffixBytes.length; i++) {
                    newSuffix[i - 4] = fileSuffixBytes[i];
                }
                regularFileSuffix = string(newSuffix);
            }
        }

        return regularFileSuffix;
    }

    function _getCoreFacetSelectors(
        string memory facetName
    ) internal returns (bytes4[] memory) {
        string[] memory cmd = new string[](3);
        cmd[0] = "script/deploy/facets/utils/contract-selectors.sh";
        cmd[1] = facetName;
        cmd[2] = "";
        bytes memory res = vm.ffi(cmd);
        return abi.decode(res, (bytes4[]));
    }

    function _saveFacetAddresses(
        address ldaDiamond,
        address[] memory facetAddresses
    ) internal {
        // First, read the existing file to preserve any entries we want to keep
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        // Create a clean JSON with only the real contracts (no FullLiFiDexAggregator)
        string memory jsonContent = "{\n";

        // Add the main diamond address with the CORRECT name
        jsonContent = string.concat(
            jsonContent,
            '  "LiFiDEXAggregatorDiamond": "',
            vm.toString(ldaDiamond),
            '"'
        );

        // Add all the real facet addresses
        string[8] memory facetNames = [
            "AlgebraFacet",
            "CoreRouteFacet",
            "CurveFacet",
            "IzumiV3Facet",
            "NativeWrapperFacet",
            "SyncSwapV2Facet",
            "UniV2StyleFacet",
            "UniV3StyleFacet"
        ];

        for (
            uint256 i = 0;
            i < facetNames.length && i < facetAddresses.length;
            i++
        ) {
            if (facetAddresses[i] != address(0)) {
                jsonContent = string.concat(
                    jsonContent,
                    ',\n  "',
                    facetNames[i],
                    '": "',
                    vm.toString(facetAddresses[i]),
                    '"'
                );
            }
        }

        jsonContent = string.concat(jsonContent, "\n}");

        emit log_named_string("Writing complete JSON to:", path);
        emit log(
            "Note: This will overwrite any FullLiFiDexAggregator entries"
        );

        // Write the complete JSON file (this will overwrite the bash-created file)
        vm.writeFile(path, jsonContent);
        emit log("All facet addresses saved successfully!");
    }
}
