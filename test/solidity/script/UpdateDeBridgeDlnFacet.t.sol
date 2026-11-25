// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdateDeBridgeDlnFacetScript
} from "../../../script/deploy/facets/UpdateDeBridgeDlnFacet.s.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateDeBridgeDlnFacetHarness is UpdateDeBridgeDlnFacetScript {
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

contract UpdateDeBridgeDlnFacetTest is UpdateScriptTestBase {
    UpdateDeBridgeDlnFacetHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new UpdateDeBridgeDlnFacetHarness();
    }

    /// @dev Expected values are literals from config/debridgedln.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function test_DecodesGnosisRowByFieldName() public {
        DeBridgeDlnFacet.ChainIdConfig[] memory configs = abi.decode(
            _initArgs(
                script.exposedGetCallData(),
                DeBridgeDlnFacet.initDeBridgeDln.selector
            ),
            (DeBridgeDlnFacet.ChainIdConfig[])
        );

        assertEq(configs[4].chainId, 100);
        assertEq(configs[4].deBridgeChainId, 100000002);
    }
}
