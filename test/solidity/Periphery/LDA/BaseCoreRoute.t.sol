// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { LiFiDEXAggregatorDiamondTest } from "../../utils/LiFiDEXAggregatorDiamondTest.sol";

/// @title BaseCoreRouteTest
/// @notice Shared utilities to build route bytes and execute swaps against `CoreRouteFacet`.
/// @dev Offers:
///      - Flexible route building for single/multi-hop
///      - Event expectations helpers
///      - Overloads of `_executeAndVerifySwap` including revert path
///      Concrete tests compose these helpers to succinctly define swap scenarios.
abstract contract BaseCoreRouteTest is
    LiFiDEXAggregatorDiamondTest,
    TestHelpers
{
    using SafeERC20 for IERC20;

    // ==== Types ====

    /// @notice Command types recognized by CoreRouteFacet route parser.
    /// @dev Controls how `processRoute` resolves the source of funds.
    enum CommandType {
        None, // 0 - not used
        DistributeSelfERC20, // 1 - distributeSelfERC20 (Aggregator's funds)
        DistributeUserERC20, // 2 - distributeUserERC20 (User's funds)
        DistributeNative, // 3 - distributeNative
        DispatchSinglePoolSwap, // 4 - dispatchSinglePoolSwap (Pool's funds)
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
        uint8[] indexedParamIndices; // indices of params that are indexed (topics 1..3)
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
    /// @param destinationAddress Destination address of the swap proceeds.
    /// @param commandType Command determining source of funds.
    struct SwapTestParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address sender;
        address destinationAddress;
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
    /// @param receiverAddress Receiver address.
    /// @param tokenIn Input token.
    /// @param tokenOut Output token.
    /// @param amountIn Input amount.
    /// @param amountOutMin Min acceptable output amount.
    /// @param amountOut Actual output amount.
    event Route(
        address indexed from,
        address receiverAddress,
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
    error InvalidIndexedParamPosition(uint8 position, uint256 totalParams);

    // ==== Setup Functions ====

    /// @notice Deploys and attaches `CoreRouteFacet` to the diamond under test.
    /// @dev Invoked from `setUp` of child tests via inheritance chain.
    function setUp() public virtual override {
        LiFiDEXAggregatorDiamondTest.setUp();
        _addCoreRouteFacet();
    }

    /// @notice Internal helper to deploy CoreRouteFacet and add its `processRoute` selector.
    /// @dev Sets `coreRouteFacet` to the diamond proxy after cut.
    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet();
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
    ///      - DistributeNative: [cmd(1)][numPools(1)=1][share(2)=FULL][len(2)][data]
    ///      - DispatchSinglePoolSwap: [cmd(1)][tokenIn(20)][len(2)][data]
    ///      - Others (User/MyERC20): [cmd(1)][tokenIn(20)][numPools(1)=1][share(2)=FULL][len(2)][data]
    /// @custom:example Single-hop user ERC20
    ///      bytes memory data = abi.encodePacked(facet.swapUniV2.selector, pool, uint8(1), destinationAddress);
    ///      bytes memory route = _buildBaseRoute(params, data);
    function _buildBaseRoute(
        SwapTestParams memory params,
        bytes memory swapData
    ) internal pure returns (bytes memory) {
        if (params.commandType == CommandType.DistributeNative) {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    uint8(1),
                    FULL_SHARE,
                    uint16(swapData.length),
                    swapData
                );
        } else if (params.commandType == CommandType.DispatchSinglePoolSwap) {
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

    /// @notice Executes a built route and verifies balances and events with full verification options
    /// @param params Swap parameters including token addresses, amounts, and command type
    /// @param route Pre-built route bytes (single or multi-hop)
    /// @param additionalEvents Additional external events to expect during execution
    /// @param isFeeOnTransferToken Whether tokenIn is fee-on-transfer token (tolerates off-by-1 spent)
    /// @param routeEventVerification Route event check configuration for exact output and data validation
    /// @dev Handles the following:
    ///      - Approves tokenIn if not aggregator-funded
    ///      - Tracks balances before/after for both input and output tokens
    ///      - Emits and verifies Route event with specified verification options
    ///      - Supports native token transfers via msg.value
    ///      - Validates token spent matches expected amount (with fee-on-transfer tolerance)
    ///      - Ensures positive output amount received
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        ExpectedEvent[] memory additionalEvents,
        bool isFeeOnTransferToken,
        RouteEventVerification memory routeEventVerification
    ) internal {
        if (
            params.commandType != CommandType.DistributeSelfERC20 &&
            !LibAsset.isNativeAsset(params.tokenIn)
        ) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        uint256 inBefore;
        uint256 outBefore = LibAsset.isNativeAsset(params.tokenOut)
            ? params.destinationAddress.balance
            : IERC20(params.tokenOut).balanceOf(params.destinationAddress);

        // For aggregator funds, check the diamond's balance
        if (params.commandType == CommandType.DistributeSelfERC20) {
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

        vm.expectEmit(
            true,
            true,
            true,
            routeEventVerification.checkData,
            address(ldaDiamond)
        );
        emit Route(
            fromAddress,
            params.destinationAddress,
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
                params.destinationAddress,
                route
            );
        } else {
            coreRouteFacet.processRoute(
                params.tokenIn,
                params.amountIn,
                params.tokenOut,
                params.minOut,
                params.destinationAddress,
                route
            );
        }

        uint256 inAfter;
        uint256 outAfter = LibAsset.isNativeAsset(params.tokenOut)
            ? params.destinationAddress.balance
            : IERC20(params.tokenOut).balanceOf(params.destinationAddress);

        // Check balance change on the correct address
        if (params.commandType == CommandType.DistributeSelfERC20) {
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

    /// @notice Executes a built route with basic verification and no exact output check
    /// @param params Swap parameters including token addresses, amounts, and command type
    /// @param route Pre-built route bytes (single or multi-hop)
    /// @param additionalEvents Additional external events to expect during execution
    /// @param isFeeOnTransferToken Whether tokenIn is fee-on-transfer token (tolerates off-by-1 spent)
    /// @dev Convenience overload that:
    ///      - Sets expectedExactOut to 0 (no exact output verification)
    ///      - Disables Route event data validation
    ///      - Maintains all other verification steps from the full version
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

    /// @notice Executes a built route with minimal verification
    /// @param params Swap parameters including token addresses, amounts, and command type
    /// @param route Pre-built route bytes (single or multi-hop)
    /// @dev Simplest overload that:
    ///      - Assumes non-fee-on-transfer token
    ///      - Expects no additional events
    ///      - Disables exact output verification
    ///      - Disables Route event data validation
    ///      - Useful for basic swap tests without complex verification needs
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

    /// @notice Executes a built route with fee-on-transfer support
    /// @param params Swap parameters including token addresses, amounts, and command type
    /// @param route Pre-built route bytes (single or multi-hop)
    /// @param isFeeOnTransferToken Whether tokenIn is fee-on-transfer token (tolerates off-by-1 spent)
    /// @dev Convenience overload that:
    ///      - Supports fee-on-transfer tokens via tolerance parameter
    ///      - Expects no additional events
    ///      - Disables exact output verification
    ///      - Disables Route event data validation
    ///      - Useful for testing fee-on-transfer tokens without complex event verification
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

    /// @notice Executes a route expecting a specific revert error
    /// @param params Swap parameters including token addresses, amounts, and command type
    /// @param route Pre-built route bytes (single or multi-hop)
    /// @param expectedRevert Error selector that should be thrown by processRoute
    /// @dev Special overload for testing failure cases:
    ///      - For aggregator funds (DistributeSelfERC20), sends amountIn-1 to trigger errors
    ///      - For user funds, approves full amountIn but sends amountIn-1
    ///      - Sets minOut to 0 to focus on specific error cases
    ///      - Verifies exact error selector match
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        bytes4 expectedRevert
    ) internal {
        if (
            params.commandType != CommandType.DistributeSelfERC20 &&
            !LibAsset.isNativeAsset(params.tokenIn)
        ) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        vm.expectRevert(expectedRevert);
        {
            if (LibAsset.isNativeAsset(params.tokenIn)) {
                coreRouteFacet.processRoute{ value: params.amountIn }(
                    params.tokenIn,
                    params.amountIn,
                    params.tokenOut,
                    0, // minOut = 0 for tests
                    params.destinationAddress,
                    route
                );
            } else {
                coreRouteFacet.processRoute(
                    params.tokenIn,
                    params.amountIn,
                    params.tokenOut,
                    0, // minOut = 0 for tests
                    params.destinationAddress,
                    route
                );
            }
        }
    }

    /// @notice Builds route and executes swap with full verification options in a single call
    /// @param params SwapTestParams for building and executing the swap
    /// @param swapData DEX-specific swap data to pack into the route
    /// @param expectedEvents Additional events to expect during execution
    /// @param isFeeOnTransferToken Whether to allow 1 wei difference in spent amount for fee-on-transfer tokens
    /// @param verification Route event verification configuration
    /// @dev Comprehensive helper that:
    ///      - Builds route using _buildBaseRoute
    ///      - Executes swap with full verification options
    ///      - Supports all verification features: events, fee-on-transfer tokens, exact output
    ///      - Primarily used by complex test scenarios to keep code concise
    function _buildRouteAndExecuteAndVerifySwap(
        SwapTestParams memory params,
        bytes memory swapData,
        ExpectedEvent[] memory expectedEvents,
        bool isFeeOnTransferToken,
        RouteEventVerification memory verification
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(
            params,
            route,
            expectedEvents,
            isFeeOnTransferToken,
            verification
        );
    }

    /// @notice Builds route and executes swap with default verification settings
    /// @param params SwapTestParams for building and executing the swap
    /// @param swapData DEX-specific swap data to pack into the route
    /// @dev Simple helper that:
    ///      - Builds route using _buildBaseRoute
    ///      - Executes with default settings:
    ///        - No additional events
    ///        - No fee-on-transfer handling
    ///        - No exact output verification
    ///        - No Route event data validation
    ///      - Useful for basic swap test scenarios
    function _buildRouteAndExecuteAndVerifySwap(
        SwapTestParams memory params,
        bytes memory swapData
    ) internal {
        _buildRouteAndExecuteAndVerifySwap(
            params,
            swapData,
            new ExpectedEvent[](0),
            false,
            RouteEventVerification({ expectedExactOut: 0, checkData: false })
        );
    }

    /// @notice Builds route and executes swap expecting a specific revert error
    /// @param params SwapTestParams for building and executing the swap
    /// @param swapData DEX-specific swap data to pack into the route
    /// @param expectedRevert Error selector that should be thrown by processRoute
    /// @dev Revert testing helper that:
    ///      - Builds route using _buildBaseRoute
    ///      - Delegates to _executeAndVerifySwap's revert testing logic
    ///      - For aggregator funds, uses amountIn-1 to trigger errors
    ///      - Sets minOut to 0 to focus on specific error cases
    function _buildRouteAndExecuteAndVerifySwap(
        SwapTestParams memory params,
        bytes memory swapData,
        bytes4 expectedRevert
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route, expectedRevert);
    }

    /// @notice Builds route and executes swap with fee-on-transfer support and event verification
    /// @param params SwapTestParams for building and executing the swap
    /// @param swapData DEX-specific swap data to pack into the route
    /// @param additionalEvents Additional events to expect during execution
    /// @param isFeeOnTransferToken Whether tokenIn is fee-on-transfer token (tolerates off-by-1 spent)
    /// @dev Extended helper that:
    ///      - Builds route using _buildBaseRoute
    ///      - Supports fee-on-transfer tokens via tolerance parameter
    ///      - Allows verification of additional protocol events
    ///      - Disables exact output verification
    ///      - Disables Route event data validation
    ///      - Useful for testing complex scenarios with fee-on-transfer tokens
    function _buildRouteAndExecuteAndVerifySwap(
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

    /// @notice Sets up event expectations for a list of events
    /// @param events Array of events to expect
    /// @dev Each `ExpectedEvent` can independently toggle checking indexed topics and data.
    function _expectEvents(ExpectedEvent[] memory events) internal {
        for (uint256 i = 0; i < events.length; i++) {
            _expectEvent(events[i]);
        }
    }

    /// @notice Sets up expectation for a single event
    /// @param evt The event to expect with its check parameters and data
    /// @dev Builds the right number of topics based on `indexedParamIndices`, and an ABI-packed data
    ///      payload of non-indexed params (static only).
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
            bool[] memory isIndexed = new bool[](total);
            for (uint256 k = 0; k < topicsCount; k++) {
                uint8 pos = idx[k];
                if (pos >= evt.eventParams.length) {
                    revert InvalidIndexedParamPosition(
                        pos,
                        evt.eventParams.length
                    );
                }
                isIndexed[pos] = true;
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
