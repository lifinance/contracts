// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as UpdateMegaETHBridgeFacetScript
} from "../../../script/deploy/facets/UpdateMegaETHBridgeFacet.s.sol";
import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract UpdateMegaETHBridgeFacetHarness is UpdateMegaETHBridgeFacetScript {
    function exposedGetCallData() public returns (bytes memory) {
        return getCallData();
    }

    function exposedReadTokens(string memory _json)
        public
        view
        returns (Config[] memory)
    {
        return _readTokens(_json);
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

contract UpdateMegaETHBridgeFacetTest is UpdateScriptTestBase {
    address internal constant DEFAULT_BRIDGE =
        0x0CA3A2FBC3D770b578223FBB6b062fa875a2eE75;

    UpdateMegaETHBridgeFacetHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        // the script refuses a default bridge address that holds no code
        vm.etch(DEFAULT_BRIDGE, new bytes(MIN_CONTRACT_CODE_SIZE));

        script = new UpdateMegaETHBridgeFacetHarness();
    }

    /// @dev config/megaethBridge.json lists no mainnet tokens, so there is no row to assert
    function test_DecodesEmptyTokenList() public {
        (MegaETHBridgeFacet.Config[] memory configs, address defaultBridge) = abi.decode(
            _initArgs(
                script.exposedGetCallData(),
                MegaETHBridgeFacet.initMegaETH.selector
            ),
            (MegaETHBridgeFacet.Config[], address)
        );

        assertEq(configs.length, 0);
        assertEq(defaultBridge, DEFAULT_BRIDGE);
    }

    /// @dev Row keys as config/megaethBridge.json's devNotes and
    ///      script/tasks/proposeMegaETHBridgeRegistrations.ts define them, since the
    ///      config itself has no rows yet
    function test_DecodesTokenRowInDocumentedShape() public view {
        string memory json =
            "{\"mainnet\":{\"tokens\":[{\"bridgeAddress\":\"0x0000000000000000000000000000000000000B0B\",\"address\":\"0x0000000000000000000000000000000000000A11\"}]}}";

        UpdateMegaETHBridgeFacetHarness.Config[] memory configs =
            script.exposedReadTokens(json);

        assertEq(configs.length, 1);
        assertEq(configs[0].assetId, address(0xA11));
        assertEq(configs[0].bridge, address(0xB0B));
    }
}
