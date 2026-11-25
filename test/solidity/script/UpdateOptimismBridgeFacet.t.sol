// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdateOptimismBridgeFacetScript
} from "../../../script/deploy/facets/UpdateOptimismBridgeFacet.s.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateOptimismBridgeFacetHarness is UpdateOptimismBridgeFacetScript {
    function exposedGetCallData() public returns (bytes memory) {
        return getCallData();
    }

    function _readCutOptions()
        internal
        pure
        override
        returns (CutOptions memory options)
    {
        options.noBroadcast = true;
        options.selectorArtifactsDir = "./out";
    }

    function _readDeploymentsJson() internal override returns (string memory) {
        return vm.serializeAddress(
            "deployments",
            "LiFiDiamond",
            0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
        );
    }
}

contract UpdateOptimismBridgeFacetTest is UpdateScriptTestBase {
    address internal constant STANDARD_BRIDGE =
        0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1;

    UpdateOptimismBridgeFacetHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        // the script refuses a standard bridge address that holds no code
        vm.etch(STANDARD_BRIDGE, new bytes(MIN_CONTRACT_CODE_SIZE));

        script = new UpdateOptimismBridgeFacetHarness();
    }

    /// @dev Expected values are literals from config/optimism.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function test_DecodesUsdtRowByFieldName() public {
        (
            OptimismBridgeFacet.Config[] memory configs,
            address standardBridge
        ) = abi.decode(
            _initArgs(
                script.exposedGetCallData(),
                OptimismBridgeFacet.initOptimism.selector
            ),
            (OptimismBridgeFacet.Config[], address)
        );

        assertEq(
            configs[2].assetId, 0xdAC17F958D2ee523a2206206994597C13D831ec7
        );
        assertEq(configs[2].bridge, 0xaBA2c5F108F7E820C049D5Af70B16ac266c8f128);
        assertEq(standardBridge, STANDARD_BRIDGE);
    }
}
