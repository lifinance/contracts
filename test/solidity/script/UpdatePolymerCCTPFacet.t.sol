// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdatePolymerCCTPFacetScript
} from "../../../script/deploy/facets/UpdatePolymerCCTPFacet.s.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdatePolymerCCTPFacetHarness is UpdatePolymerCCTPFacetScript {
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

contract UpdatePolymerCCTPFacetTest is UpdateScriptTestBase {
    UpdatePolymerCCTPFacetHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new UpdatePolymerCCTPFacetHarness();
    }

    /// @dev Expected values are literals from config/polymercctp.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function test_DecodesAvalancheRowByFieldName() public {
        PolymerCCTPFacet.ChainIdConfig[] memory configs = abi.decode(
            _initArgs(
                script.exposedGetCallData(),
                PolymerCCTPFacet.initPolymerCCTP.selector
            ),
            (PolymerCCTPFacet.ChainIdConfig[])
        );

        assertEq(configs[1].chainId, 43114);
        assertEq(configs[1].domainId, 1);
    }
}
