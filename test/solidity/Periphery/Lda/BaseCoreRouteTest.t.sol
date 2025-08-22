// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";

abstract contract BaseCoreRouteTest is LdaDiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    // ==== Types ====
    enum CommandType {
        None, // 0 - not used
        ProcessMyERC20, // 1 - processMyERC20 (Aggregator's funds)
        ProcessUserERC20, // 2 - processUserERC20 (User's funds)
        ProcessNative, // 3 - processNative
        ProcessOnePool, // 4 - processOnePool (Pool's funds)
        ApplyPermit // 5 - applyPermit
    }

    struct ExpectedEvent {
        bool checkTopic1;
        bool checkTopic2;
        bool checkTopic3;
        bool checkData;
        bytes32 eventSelector; // The event selector (keccak256 hash of the event signature)
        bytes[] eventParams; // The event parameters, each encoded separately
        uint8[] indexedParamIndices; // indices of params that are indexed (→ topics 1..3)
    }

    struct RouteEventVerification {
        uint256 expectedExactOut; // Only for event verification
        bool checkData;
    }

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
    uint16 internal constant FULL_SHARE = 65535;

    // ==== Variables ====
    CoreRouteFacet internal coreRouteFacet;

    // ==== Events ====
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
    error InvalidTopicLength();
    error TooManyIndexedParams();
    error DynamicParamsNotSupported();

    // ==== Setup Functions ====
    function setUp() public virtual override {
        LdaDiamondTest.setUp();
        _addCoreRouteFacet();
    }

    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet(USER_DIAMOND_OWNER);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(ldaDiamond, address(coreRouteFacet), selectors);
        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));
    }

    // ==== Helper Functions ====
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

    // Keep the revert case separate
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

    /// @dev Helper that builds route and executes swap in one call
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

    /// @dev Overload with default parameters for simple cases
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

    /// @dev Overload for revert cases
    function _buildRouteAndExecuteSwap(
        SwapTestParams memory params,
        bytes memory swapData,
        bytes4 expectedRevert
    ) internal {
        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route, expectedRevert);
    }

    /// @dev Overload matching _executeAndVerifySwap's 4-parameter signature
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

    // helper: load a 32-byte topic from a 32-byte abi.encode(param)
    function _asTopic(bytes memory enc) internal pure returns (bytes32 topic) {
        if (enc.length != 32) revert InvalidTopicLength();
        assembly {
            topic := mload(add(enc, 32))
        }
    }

    /**
     * @notice Sets up event expectations for a list of events
     * @param events Array of events to expect
     */
    function _expectEvents(ExpectedEvent[] memory events) internal {
        for (uint256 i = 0; i < events.length; i++) {
            _expectEvent(events[i]);
        }
    }

    /**
     * @notice Sets up expectation for a single event
     * @param evt The event to expect with its check parameters and data
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
