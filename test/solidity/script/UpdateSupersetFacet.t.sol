// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdateSupersetFacetScript
} from "../../../script/deploy/facets/UpdateSupersetFacet.s.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateSupersetFacetHarness is UpdateSupersetFacetScript {
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

contract UpdateSupersetFacetTest is UpdateScriptTestBase {
    UpdateSupersetFacetHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new UpdateSupersetFacetHarness();
    }

    /// @dev Expected values are literals from config/superset.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function test_DecodesUnichainRowByFieldName() public {
        SupersetFacet.ChainIdConfig[] memory configs = abi.decode(
            _initArgs(
                script.exposedGetCallData(),
                SupersetFacet.initSuperset.selector
            ),
            (SupersetFacet.ChainIdConfig[])
        );

        assertEq(configs[0].chainId, 130);
        assertEq(configs[0].lzEid, 30320);
    }
}
