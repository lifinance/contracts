// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {
    DeployScript as AddTokenApprovalsScript
} from "../../../script/tasks/solidity/AddTokenApprovalsToAcrossFacetPackedV4.s.sol";
import { UpdateScriptTestBase } from "../utils/UpdateScriptTestBase.sol";

/// @dev Forge shares process env across suites running in parallel, and UpdateScriptBase.t.sol sets
///      cut-verification env vars, so the cut options and deployments file are pinned here instead.
contract AddTokenApprovalsHarness is AddTokenApprovalsScript {
    function exposedReadTokensToApprove() public returns (address[] memory) {
        return _readTokensToApprove();
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

contract AddTokenApprovalsToAcrossFacetPackedV4Test is UpdateScriptTestBase {
    AddTokenApprovalsHarness internal script;

    function setUp() public {
        _setMainnetScriptEnv();

        script = new AddTokenApprovalsHarness();
    }

    /// @dev The expected address is a literal from config/across.json, so a fault in the
    ///      script's read cannot show up on both sides of the assert
    function test_ReadsUsdcAsSecondMainnetTokenToApprove() public {
        address[] memory tokens = script.exposedReadTokensToApprove();

        assertEq(tokens[1], 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    }
}
