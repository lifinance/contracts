// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    UpdateScriptBase
} from "../../../script/deploy/facets/utils/UpdateScriptBase.sol";
import {
    UpdateScriptBase as UpdateScriptBaseZkSync
} from "../../../script/deploy/zksync/utils/UpdateScriptBase.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract ApproveRefundWalletHarness is UpdateScriptBase {
    function exposedReadApprovedSelectors(string memory _json)
        public
        pure
        returns (FunctionSelector[] memory)
    {
        return _readApprovedSelectorsForRefundWallet(_json);
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

contract ApproveRefundWalletZkSyncHarness is UpdateScriptBaseZkSync {
    function exposedReadApprovedSelectors(string memory _json)
        public
        pure
        returns (FunctionSelector[] memory)
    {
        return _readApprovedSelectorsForRefundWallet(_json);
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

contract ApproveRefundWalletTest is UpdateScriptTestBase {
    ApproveRefundWalletHarness internal script;
    ApproveRefundWalletZkSyncHarness internal zkSyncScript;
    string internal globalConfig;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new ApproveRefundWalletHarness();
        zkSyncScript = new ApproveRefundWalletZkSyncHarness();
        globalConfig = vm.readFile(
            string.concat(vm.projectRoot(), "/config/global.json")
        );
    }

    /// @dev Expected values are literals from config/global.json, which lists `selector`
    ///      before `name`, so a read that fills fields by key order fails here
    function test_ReadsWithdrawSelectorByFieldName() public view {
        UpdateScriptBase.FunctionSelector[] memory selectors =
            script.exposedReadApprovedSelectors(globalConfig);

        assertEq(selectors[0].name, "WithdrawFacet.withdraw");
        assertEq(selectors[0].selector, hex"d9caed12");
    }

    function test_ZkSyncBaseReadsWithdrawSelectorByFieldName() public view {
        UpdateScriptBaseZkSync.FunctionSelector[] memory selectors =
            zkSyncScript.exposedReadApprovedSelectors(globalConfig);

        assertEq(selectors[0].name, "WithdrawFacet.withdraw");
        assertEq(selectors[0].selector, hex"d9caed12");
    }
}
