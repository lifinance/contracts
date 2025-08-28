// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDEXFacet.t.sol";

/// @title LaminarV3FacetTest
/// @notice Hyperevm UniV3-style tests for Laminar pools via LDA.
/// @dev Minimal setup; inherits all execution helpers from the base.
contract LaminarV3FacetTest is BaseUniV3StyleDexFacetTest {
    /// @notice Selects Hyperevm fork and block used by tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "hyperevm",
            blockNumber: 4433562
        });
    }

    /// @notice Returns Laminar V3 callback selector used during swaps.
    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.laminarV3SwapCallback.selector;
    }

    /// @notice Sets tokenIn/out and pool for Laminar V3 on Hyperevm.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x5555555555555555555555555555555555555555); // WHYPE
        tokenOut = IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562); // LHYPE
        poolInOut = 0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45; // WHYPE_LHYPE_POOL
    }
}
