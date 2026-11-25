// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdateFraxFacetScript
} from "../../../script/deploy/facets/UpdateFraxFacet.s.sol";
import {
    DeployScript as UpdateFraxFacetZkSyncScript
} from "../../../script/deploy/zksync/UpdateFraxFacet.zksync.s.sol";
import { FraxFacet } from "lifi/Facets/FraxFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateFraxFacetHarness is UpdateFraxFacetScript {
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

contract UpdateFraxFacetZkSyncHarness is UpdateFraxFacetZkSyncScript {
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

contract UpdateFraxFacetTest is UpdateScriptTestBase {
    UpdateFraxFacetHarness internal script;
    UpdateFraxFacetZkSyncHarness internal zkSyncScript;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new UpdateFraxFacetHarness();
        zkSyncScript = new UpdateFraxFacetZkSyncHarness();
    }

    function test_DecodesMainnetRowByFieldName() public {
        _assertMainnetRow(script.exposedGetCallData());
    }

    function test_ZkSyncScriptDecodesMainnetRowByFieldName() public {
        _assertMainnetRow(zkSyncScript.exposedGetCallData());
    }

    /// @dev Expected values are literals from config/frax.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function _assertMainnetRow(bytes memory _callData) internal pure {
        FraxFacet.ChainIdConfig[] memory configs = abi.decode(
            _initArgs(_callData, FraxFacet.initFrax.selector),
            (FraxFacet.ChainIdConfig[])
        );

        assertEq(configs[0].chainId, 1);
        assertEq(configs[0].lzEid, 30101);
    }
}
