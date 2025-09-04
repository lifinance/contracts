// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { stdJson } from "forge-std/StdJson.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { BaseUpdateScript } from "./BaseUpdateScript.sol";

contract UpdateScriptBase is BaseUpdateScript {
    using stdJson for string;

    struct Approval {
        address aTokenAddress;
        address bContractAddress;
    }

    function _buildDeploymentPath()
        internal
        view
        override
        returns (string memory)
    {
        return
            string.concat(
                root,
                "/deployments/",
                network,
                ".",
                fileSuffix,
                "json"
            );
    }

    function _getDiamondAddress() internal override returns (address) {
        return
            useDefaultDiamond
                ? json.readAddress(".LiFiDiamond")
                : json.readAddress(".LiFiDiamondImmutable");
    }

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
}
