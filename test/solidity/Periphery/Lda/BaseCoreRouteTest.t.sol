// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { LDADiamondTest } from "./utils/LDADiamondTest.sol";

/// @title BaseCoreRouteTest
/// @notice Shared utilities to build route bytes and execute swaps against `CoreRouteFacet`.
/// @dev Offers:
///      - Flexible route building for single/multi-hop
///      - Event expectations helpers
///      - Overloads of `_executeAndVerifySwap` including revert path
///      Concrete tests compose these helpers to succinctly define swap scenarios.
abstract contract BaseCoreRouteTest is LDADiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    // ==== Types ====

    /// @notice Command types recognized by CoreRouteFacet route parser.
    /// @dev Controls how `processRoute` resolves the source of funds.
    enum CommandType {
        None, // 0 - not used
        ProcessMyERC20, // 1 - processMyERC20 (Aggregator's funds)
        ProcessUserERC20, // 2 - processUserERC20 (User's funds)
        ProcessNative, // 3 - processNative
        ProcessOnePool, // 4 - processOnePool (Pool's funds)
        ApplyPermit // 5 - applyPermit
    }

    /// @notice Generic event expectation shape for verifying external protocol emissions alongside Route.
    /// @param checkTopic1 Whether to check topic1 (indexed param #1).
    /// @param checkTopic2 Whether to check topic2 (indexed param #2).
    /// @param checkTopic3 Whether to check topic3 (indexed param #3).
    /// @param checkData Whether to check event data (non-indexed params).
    /// @param eventSelector keccak256 hash of the event signature.
    /// @param eventParams Params encoded as abi.encode(param) each; indexed must be exactly 32 bytes.
    /// @param indexedParamIndices Indices of params that are indexed (map to topics 1..3).
    struct ExpectedEvent {
        bool checkTopic1;
        bool checkTopic2;
        bool checkTopic3;
        bool checkData;
        bytes32 eventSelector; // The event selector (keccak256 hash of the event signature)
        bytes[] eventParams; // The event parameters, each encoded separately
        uint8[] indexedParamIndices; // indices of params that are indexed (→ topics 1..3)
    }

    /// @notice Tuning for verifying the core `Route` event.
    /// @param expectedExactOut Set >0 to match exact amountOut, otherwise only structure is validated.
    /// @param checkData Whether to validate event data payload.
    struct RouteEventVerification {
        uint256 expectedExactOut; // Only for event verification
        bool checkData;
    }

    /// @notice Parameters passed to `_buildBaseRoute` and `_executeAndVerifySwap`.
    /// @param tokenIn Input token address (or NATIVE constant).
    /// @param tokenOut Output token address (or NATIVE constant).
    /// @param amountIn Input amount.
    /// @param minOut Minimum acceptable output amount (slippage).
    /// @param sender Logical sender of the funds for this hop.
    /// @param recipient Receiver of the swap proceeds.
    /// @param commandType Command determining source of funds.
    struct SwapTestParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address sender;
        address recipient;
        CommandType commandType;
    }

    // ==== Constants ====

    /// @notice Denotes 100% share in route encoding.
    uint16 internal constant FULL_SHARE = 65535;

    // ==== Variables ====

    /// @notice Proxy handle to CoreRouteFacet on the test diamond.
    CoreRouteFacet internal coreRouteFacet;

    // ==== Events ====

    /// @notice Emitted by CoreRouteFacet upon route processing completion.
    /// @param from Sender address (user or synthetic if aggregator-funded).
    /// @param to Recipient address.
    /// @param tokenIn Input token.
    /// @param tokenOut Output token.
    /// @param amountIn Input amount.
    /// @param amountOutMin Min acceptable output amount.
    /// @param amountOut Actual output amount.
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // ==== Errors ====

    /// @notice Thrown if an event expectation includes >3 indexed params.
    error TooManyIndexedParams();
    /// @notice Thrown when building topics from non-32-byte encoded params.
    error InvalidTopicLength();
    /// @notice Thrown when data verification encounters dynamic params (unsupported).
    error DynamicParamsNotSupported();

    // ==== Setup Functions ====

    /// @notice Deploys and attaches `CoreRouteFacet` to the diamond under test.
    /// @dev Invoked from `setUp` of child tests via inheritance chain.
    function setUp() public virtual override {
        LDADiamondTest.setUp();
        _addCoreRouteFacet();
    }

    /// @notice Internal helper to deploy CoreRouteFacet and add its `processRoute` selector.
    /// @dev Sets `coreRouteFacet` to the diamond proxy after cut.
    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet(USER_DIAMOND_OWNER);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(address(ldaDiamond), address(coreRouteFacet), selectors);
        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));
    }

    // ==== Helper Functions ====

    /// @notice Builds a base route-blob for a single hop given `SwapTestParams` and `swapData`.
    /// @param params Swap parameters including command type.
    /// @param swapData DEX-specific data (usually starts with facet.swapX.selector).
    /// @return Encoded hop bytes to be concatenated for multi-hop or passed directly for single-hop.
    /// @dev Format depends on command:
    ///      - ProcessNative: [cmd(1)][numPools(1)=1][share(2)=FULL][len(2)][data]
    ///      - ProcessOnePool: [cmd(1)][tokenIn(20)][len(2)][data]
    ///      - Others (User/MyERC20): [cmd(1)][tokenIn(20)][numPools(1)=1][share(2)=FULL][len(2)][data]
    /// @custom:example Single-hop user ERC20
    ///      bytes memory data = abi.encodePacked(facet.swapUniV2.selector, pool, uint8(1), recipient);
    ///      bytes memory route = _buildBaseRoute(params, data);
    function _buildBaseRoute(
        SwapTestParams memory params,
        bytes memory swapData
    ) internal pure returns (bytes memory) {
        if (params.commandType == CommandType.ProcessNative) {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    uint8(1),
                    FULL_SHARE,
                    uint16(swapData.length),
                    swapData
                );
        } else if (params.commandType == CommandType.ProcessOnePool) {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    params.tokenIn,
                    uint16(swapData.length),
                    swapData
                );
        } else {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    params.tokenIn,
                    uint8(1),
                    FULL_SHARE,
                    uint16(swapData.length),
                    swapData
                );
        }
    }

    /// @notice Executes a built route and verifies balances and events.
    /// @param params Swap params; if ProcessMyERC20, measures in/out at the diamond.
    /// @param route Pre-built route bytes (single or multi-hop).
    /// @param additionalEvents Additional external events to expect.
    /// @param isFeeOnTransferToken Whether tokenIn is fee-on-transfer (tolerates off-by-1 spent).
    /// @param routeEventVerification Route event check configuration (exact out optional).
    /// @dev Approves tokenIn if not aggregator-funded. Emits and verifies Route event.
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        ExpectedEvent[] memory additionalEvents,
        bool isFeeOnTransferToken,
        RouteEventVerification memory routeEventVerification
    ) internal {
        if (
            params.commandType != CommandType.ProcessMyERC20 &&
            !LibAsset.isNativeAsset(params.tokenIn)
        ) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        uint256 inBefore;
        uint256 outBefore = LibAsset.isNativeAsset(params.tokenOut)
            ? params.recipient.balance
            : IERC20(params.tokenOut).balanceOf(params.recipient);

        // For aggregator funds, check the diamond's balance
        if (params.commandType == CommandType.ProcessMyERC20) {
            inBefore = LibAsset.isNativeAsset(params.tokenIn)
                ? address(ldaDiamond).balance
                : IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inBefore = LibAsset.isNativeAsset(params.tokenIn)
                ? params.sender.balance
                : IERC20(params.tokenIn).balanceOf(params.sender);
        }

        address fromAddress = params.sender == address(ldaDiamond)
            ? USER_SENDER
            : params.sender;

        _expectEvents(additionalEvents);

        vm.expectEmit(true, true, true, routeEventVerification.checkData);
        emit Route(
            fromAddress,
            params.recipient,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            params.minOut,
            routeEventVerification.expectedExactOut
        );

        // For native token, send value with the call
        if (LibAsset.isNativeAsset(params.tokenIn)) {
            coreRouteFacet.processRoute{ value: params.amountIn }(
                params.tokenIn,
                params.amountIn,
                params.tokenOut,
                params.minOut,
                params.recipient,
                route
            );
        } else {
            coreRouteFacet.processRoute(
                params.tokenIn,
                params.amountIn,
                params.tokenOut,
                params.minOut,
                params.recipient,
                route
            );
        }

        uint256 inAfter;
        uint256 outAfter = LibAsset.isNativeAsset(params.tokenOut)
            ? params.recipient.balance
            : IERC20(params.tokenOut).balanceOf(params.recipient);

        // Check balance change on the correct address
        if (params.commandType == CommandType.ProcessMyERC20) {
            inAfter = LibAsset.isNativeAsset(params.tokenIn)
                ? address(ldaDiamond).balance
                : IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inAfter = LibAsset.isNativeAsset(params.tokenIn)
                ? params.sender.balance
                : IERC20(params.tokenIn).balanceOf(params.sender);
        }

        // Use assertEq or assertApproxEqAbs based on isFeeOnTransferToken
        if (isFeeOnTransferToken) {
            assertApproxEqAbs(
                inBefore - inAfter,
                params.amountIn,
                1, // Allow 1 wei difference for fee-on-transfer tokens
                "Token spent mismatch"
            );
        } else {
            assertEq(
                inBefore - inAfter,
                params.amountIn,
                "Token spent mismatch"
            );
        }

        assertGt(outAfter - outBefore, 0, "Should receive tokens");
    }

    /// @notice Convenience overload for `_executeAndVerifySwap` without exact-out check.
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        ExpectedEvent[] memory additionalEvents,
        bool isFeeOnTransferToken
    ) internal {
        _executeAndVerifySwap(
            params,
            route,
            additionalEvents,
            isFeeOnTransferToken,
            RouteEventVerification({ expectedExactOut: 0, checkData: false })
        );
    }

    /// @notice Convenience overload for `_executeAndVerifySwap` with only params and route.
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route
    ) internal {
        _executeAndVerifySwap(
            params,
            route,
            new ExpectedEvent[](0),
            false,
            RouteEventVerification({ expectedExactOut: 0, checkData: false })
        );
    }

    /// @notice Convenience overload for `_executeAndVerifySwap` with fee-on-transfer toggle.
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        bool isFeeOnTransferToken
    ) internal {
        _executeAndVerifySwap(
            params,
            route,
            new ExpectedEvent[](0),
            isFeeOnTransferToken,
            RouteEventVerification({ expectedExactOut: 0, checkData: false })
        );
    }

    /// @notice Executes route expecting a specific revert error selector.
    /// @param params Swap params; for aggregator funds, the helper deliberately uses amountIn-1 to trigger errors.
    /// @param route Pre-built route bytes.
    /// @param expectedRevert Error selector expected from `processRoute`.
    /// @dev Example:
    ///      vm.expectRevert(Errors.SwapCallbackNotExecuted.selector);
    ///      _executeAndVerifySwap(params, route, Errors.SwapCallbackNotExecuted.selector);
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        bytes4 expectedRevert
    ) internal {
        if (params.commandType != CommandType.ProcessMyERC20) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        vm.expectRevert(expectedRevert);
        coreRouteFacet.processRoute(
            params.tokenIn,
            params.commandType == CommandType.ProcessMyERC20
                ? params.amountIn
                : params.amountIn - 1,
            params.tokenOut,
            0, // minOut = 0 for tests
            params.recipient,
            route
        );
    }

    /// @notice Helper that builds route and executes swap in one call, with extended verification options.
    /// @param params SwapTestParams for building and executing.
    /// @param swapData DEX-specific swap data to pack.
    /// @param expectedEvents Additional events to expect.
    /// @param expectRevert Treats token as fee-on-transfer to adjust spent checking if true.
    /// @param verification Route event verification configuration.
    /// @dev Primarily used by complex tests to keep scenario assembly terse.
    function _buildRouteAndExecuteSwap(
        SwapTestParams memory params,
        bytes memory swapData,
        ExpectedEvent[] memory expectedEvents,
        bool expectRevert,
        RouteEventVerification memory verification
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(
            params,
            route,
            expectedEvents,
            expectRevert,
            verification
        );
    }

    /// @notice Overload: builds route and runs default execution checks.
    function _buildRouteAndExecuteSwap(
        SwapTestParams memory params,
        bytes memory swapData
    ) internal {
        _buildRouteAndExecuteSwap(
            params,
            swapData,
            new ExpectedEvent[](0),
            false,
            RouteEventVerification({ expectedExactOut: 0, checkData: false })
        );
    }

    /// @notice Overload: builds route and expects a revert.
    function _buildRouteAndExecuteSwap(
        SwapTestParams memory params,
        bytes memory swapData,
        bytes4 expectedRevert
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route, expectedRevert);
    }

    /// @notice Overload: builds route and runs with fee-on-transfer toggle and extra events.
    function _buildRouteAndExecuteSwap(
        SwapTestParams memory params,
        bytes memory swapData,
        ExpectedEvent[] memory additionalEvents,
        bool isFeeOnTransferToken
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(
            params,
            route,
            additionalEvents,
            isFeeOnTransferToken
        );
    }

    /// @notice Helper to load a topic value from a 32-byte abi.encode(param).
    /// @param enc A 32-byte abi-encoded static param.
    /// @return topic The bytes32 topic.
    function _asTopic(bytes memory enc) internal pure returns (bytes32 topic) {
        if (enc.length != 32) revert InvalidTopicLength();
        assembly {
            topic := mload(add(enc, 32))
        }
    }

    /**
     * @notice Sets up event expectations for a list of events
     * @param events Array of events to expect
     * @dev Each `ExpectedEvent` can independently toggle checking indexed topics and data.
     */
    function _expectEvents(ExpectedEvent[] memory events) internal {
        for (uint256 i = 0; i < events.length; i++) {
            _expectEvent(events[i]);
        }
    }

    /**
     * @notice Sets up expectation for a single event
     * @param evt The event to expect with its check parameters and data
     * @dev Builds the right number of topics based on `indexedParamIndices`, and an ABI-packed data
     *      payload of non-indexed params (static only).
     * @custom:error TooManyIndexedParams if more than 3 indexed params are specified.
     * @custom:error DynamicParamsNotSupported if any non-indexed param is not 32 bytes.
     */
    function _expectEvent(ExpectedEvent memory evt) internal {
        vm.expectEmit(
            evt.checkTopic1,
            evt.checkTopic2,
            evt.checkTopic3,
            evt.checkData
        );

        // Build topics (topic0 = selector; topics1..3 from indexedParamIndices)
        bytes32 topic0 = evt.eventSelector;
        uint8[] memory idx = evt.indexedParamIndices;

        bytes32 t1;
        bytes32 t2;
        bytes32 t3;

        uint256 topicsCount = idx.length;
        if (topicsCount > 3) {
            revert TooManyIndexedParams();
        }
        if (topicsCount >= 1) {
            t1 = _asTopic(evt.eventParams[idx[0]]);
        }
        if (topicsCount >= 2) {
            t2 = _asTopic(evt.eventParams[idx[1]]);
        }
        if (topicsCount == 3) {
            t3 = _asTopic(evt.eventParams[idx[2]]);
        }

        // Build data (non-indexed params in event order)
        bytes memory data;
        if (evt.checkData) {
            // Only support static params for now (each abi.encode(param) must be 32 bytes)
            uint256 total = evt.eventParams.length;
            bool[8] memory isIndexed; // up to 8 params; expand if needed
            for (uint256 k = 0; k < topicsCount; k++) {
                uint8 pos = idx[k];
                if (pos < isIndexed.length) isIndexed[pos] = true;
            }

            for (uint256 p = 0; p < total; p++) {
                if (!isIndexed[p]) {
                    bytes memory enc = evt.eventParams[p];
                    if (enc.length != 32) {
                        revert DynamicParamsNotSupported();
                    }
                    data = bytes.concat(data, enc);
                }
            }
        } else {
            data = "";
        }

        // Emit raw log with correct number of topics
        assembly {
            let ptr := add(data, 0x20)
            let len := mload(data)
            switch topicsCount
            case 0 {
                log1(ptr, len, topic0)
            }
            case 1 {
                log2(ptr, len, topic0, t1)
            }
            case 2 {
                log3(ptr, len, topic0, t1, t2)
            }
            case 3 {
                log4(ptr, len, topic0, t1, t2, t3)
            }
        }
    }
}
