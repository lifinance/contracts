// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20PermitMock } from "lib/Permit2/lib/openzeppelin-contracts/contracts/mocks/ERC20PermitMock.sol";
import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";

contract MockNativeFacet {
    using SafeTransferLib for address;

    function handleNative(
        bytes memory payload,
        address /*from*/,
        address /*tokenIn*/,
        uint256 amountIn
    ) external payable returns (uint256) {
        address recipient = abi.decode(payload, (address));
        recipient.safeTransferETH(amountIn);
        return amountIn;
    }
}

contract MockPullERC20Facet {
    using SafeERC20 for IERC20;

    // Pulls `amountIn` from msg.sender if `from == msg.sender`
    function pull(
        bytes memory /*payload*/,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
        }
        return amountIn;
    }
}

abstract contract CoreRouteTestBase is LdaDiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    // Command codes for route processing
    enum CommandType {
        None, // 0 - not used
        ProcessMyERC20, // 1 - processMyERC20 (Aggregator's funds)
        ProcessUserERC20, // 2 - processUserERC20 (User's funds)
        ProcessNative, // 3 - processNative
        ProcessOnePool, // 4 - processOnePool (Pool's funds)
        ApplyPermit // 6 - applyPermit
    }

    uint16 internal constant FULL_SHARE = 65535;

    CoreRouteFacet internal coreRouteFacet;

    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

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

    error InvalidTopicLength();
    error TooManyIndexedParams();
    error DynamicParamsNotSupported();

    function setUp() public virtual override {
        LdaDiamondTest.setUp();
        _addCoreRouteFacet();
    }

    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(address(ldaDiamond), address(coreRouteFacet), selectors);
        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));
    }

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
        if (params.commandType != CommandType.ProcessMyERC20) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        uint256 inBefore;
        uint256 outBefore = IERC20(params.tokenOut).balanceOf(
            params.recipient
        );

        // For aggregator funds, check the diamond's balance
        if (params.commandType == CommandType.ProcessMyERC20) {
            inBefore = IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inBefore = IERC20(params.tokenIn).balanceOf(params.sender);
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
            params.minOut, // Use minOut from SwapTestParams
            routeEventVerification.expectedExactOut
        );

        coreRouteFacet.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            params.minOut, // Use minOut from SwapTestParams
            params.recipient,
            route
        );

        uint256 inAfter;
        uint256 outAfter = IERC20(params.tokenOut).balanceOf(params.recipient);

        // Check balance change on the correct address
        if (params.commandType == CommandType.ProcessMyERC20) {
            inAfter = IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inAfter = IERC20(params.tokenIn).balanceOf(params.sender);
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

contract CoreRouteFacetTest is CoreRouteTestBase {
    using SafeTransferLib for address;

    bytes4 internal pullSel;

    function setUp() public override {
        CoreRouteTestBase.setUp();

        // Register mock pull facet once and store selector
        MockPullERC20Facet mockPull = new MockPullERC20Facet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = MockPullERC20Facet.pull.selector;
        addFacet(address(ldaDiamond), address(mockPull), sel);
        pullSel = sel[0];
    }

    // --- Helpers ---

    function _addMockNativeFacet() internal {
        MockNativeFacet mock = new MockNativeFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockNativeFacet.handleNative.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);
    }

    function _addMockPullFacet() internal returns (bytes4 sel) {
        MockPullERC20Facet mock = new MockPullERC20Facet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockPullERC20Facet.pull.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);
        return selectors[0];
    }

    function _signPermit(
        ERC20PermitMock token,
        uint256 ownerPk,
        address owner,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 typehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                owner,
                spender,
                value,
                token.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)
        );
        (v, r, s) = vm.sign(ownerPk, digest);
    }

    // --- Tests ---

    function test_ProcessNativeCommandSendsEthToRecipient() public {
        _addMockNativeFacet();

        address recipient = USER_RECEIVER;
        uint256 amount = 1 ether;

        // Fund the actual caller (USER_SENDER)
        vm.deal(USER_SENDER, amount);

        // swapData: selector + abi.encode(recipient)
        bytes memory swapData = abi.encodePacked(
            MockNativeFacet.handleNative.selector,
            abi.encode(recipient)
        );

        // route: [3][num=1][share=FULL_SHARE][len][swapData]
        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(0),
            tokenOut: address(0),
            amountIn: amount,
            minOut: 0,
            sender: USER_SENDER,
            recipient: recipient,
            commandType: CommandType.ProcessNative // This maps to value 3
        });

        bytes memory route = _buildBaseRoute(params, swapData);

        uint256 beforeBal = recipient.balance;

        vm.prank(USER_SENDER);
        coreRouteFacet.processRoute{ value: amount }(
            address(0), // tokenIn: native
            0,
            address(0), // tokenOut: native
            0,
            recipient,
            route
        );

        assertEq(
            recipient.balance - beforeBal,
            amount,
            "recipient should receive full amount"
        );
    }

    function test_ApplyPermitCommandSetsAllowanceOnDiamond() public {
        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        uint256 init = 1_000_000e18;
        ERC20PermitMock token = new ERC20PermitMock(
            "Mock",
            "MCK",
            owner,
            init
        );

        uint256 value = 500_000e18;
        uint256 deadline = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(
            token,
            ownerPk,
            owner,
            address(ldaDiamond),
            value,
            deadline
        );

        // route: [5][value][deadline][v][r][s]
        bytes memory route = abi.encodePacked(
            uint8(5),
            value,
            deadline,
            v,
            r,
            s
        );

        vm.prank(owner);
        coreRouteFacet.processRoute(
            address(token), // tokenIn used by _applyPermit
            0,
            address(token), // tokenOut unused; must be a contract for balanceOf read
            0,
            owner,
            route
        );

        assertEq(
            IERC20(address(token)).allowance(owner, address(ldaDiamond)),
            value,
            "permit allowance not set"
        );
    }

    // Revert tests - use testRevert_ prefix
    function testRevert_WhenCommandCodeIsUnknown() public {
        bytes memory route = abi.encodePacked(uint8(9));

        vm.prank(USER_SENDER);
        vm.expectRevert(CoreRouteFacet.UnknownCommandCode.selector);
        coreRouteFacet.processRoute(
            address(0),
            0,
            address(0),
            0,
            USER_RECEIVER,
            route
        );
    }

    function testRevert_WhenSelectorIsUnknown() public {
        ERC20PermitMock token = new ERC20PermitMock(
            "Mock2",
            "MCK2",
            USER_SENDER,
            1e18
        );

        bytes memory swapData = abi.encodePacked(bytes4(0xdeadbeef));

        // ProcessUserERC20: [2][tokenIn][num=1][share=FULL_SHARE][len=4][selector=0xdeadbeef]
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(token),
                tokenOut: address(token),
                amountIn: 0,
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        vm.prank(USER_SENDER);
        vm.expectRevert(CoreRouteFacet.UnknownSelector.selector);
        coreRouteFacet.processRoute(
            address(token),
            0,
            address(token),
            0,
            USER_RECEIVER,
            route
        );
    }

    // MinimalInputBalanceViolation: trigger by charging the user twice via two ProcessUserERC20 steps.
    function testRevert_WhenInputBalanceIsInsufficientForTwoSteps() public {
        // Prepare token and approvals
        uint256 amountIn = 1e18;
        ERC20PermitMock token = new ERC20PermitMock(
            "Pull",
            "PULL",
            USER_SENDER,
            2 * amountIn
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(token)).approve(address(ldaDiamond), type(uint256).max);

        bytes memory swapData = abi.encodePacked(pullSel);

        // Build one step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory step = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(token),
                tokenOut: address(0),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        bytes memory route = bytes.concat(step, step);

        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.MinimalInputBalanceViolation.selector,
                amountIn, // available = final(0) + amountIn
                2 * amountIn // required = initial (we minted 2*amountIn)
            )
        );
        coreRouteFacet.processRoute(
            address(token), // tokenIn for balance checks
            amountIn, // only 1e18 declared
            address(0), // no tokenOut change
            0,
            USER_RECEIVER,
            route
        );
        vm.stopPrank();
    }

    // Same as above but with tokenOut set to an ERC20, to ensure path-independent behavior.
    function testRevert_WhenInputBalanceIsInsufficientForTwoStepsWithERC20Out()
        public
    {
        uint256 amountIn = 1e18;
        ERC20PermitMock token = new ERC20PermitMock(
            "Pull2",
            "PULL2",
            USER_SENDER,
            2 * amountIn
        );
        ERC20PermitMock tokenOut = new ERC20PermitMock(
            "Out",
            "OUT",
            address(this),
            0
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(token)).approve(address(ldaDiamond), type(uint256).max);

        bytes memory swapData = abi.encodePacked(pullSel);

        bytes memory step = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(token),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        bytes memory route = bytes.concat(step, step);

        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.MinimalInputBalanceViolation.selector,
                amountIn, // available = final(0) + amountIn
                2 * amountIn // required = initial (we minted 2*amountIn)
            )
        );
        coreRouteFacet.processRoute(
            address(token),
            amountIn,
            address(tokenOut),
            0,
            USER_RECEIVER,
            route
        );
        vm.stopPrank();
    }

    function testRevert_WhenOutputBalanceIsZeroForERC20() public {
        // Register the mock pull facet; it pulls tokenIn but never transfers tokenOut to `to`
        bytes4 sel = pullSel;

        uint256 amountIn = 1e18;
        ERC20PermitMock tokenIn = new ERC20PermitMock(
            "IN",
            "IN",
            USER_SENDER,
            amountIn
        );
        ERC20PermitMock tokenOut = new ERC20PermitMock(
            "OUT",
            "OUT",
            USER_RECEIVER,
            0
        ); // recipient starts at 0

        bytes memory swapData = abi.encodePacked(sel);

        // Build one ProcessUserERC20 step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 1,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        ); // single step; no tokenOut will be sent to recipient

        vm.startPrank(USER_SENDER);
        IERC20(address(tokenIn)).approve(address(ldaDiamond), amountIn);

        // Expect MinimalOutputBalanceViolation with deltaOut = 0
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.MinimalOutputBalanceViolation.selector,
                uint256(0)
            )
        );

        coreRouteFacet.processRoute(
            address(tokenIn),
            amountIn,
            address(tokenOut), // tokenOut is ERC20
            1, // amountOutMin > 0 to trigger the revert when no output arrives
            USER_RECEIVER,
            route
        );
        vm.stopPrank();
    }

    function testRevert_WhenOutputBalanceIsZeroForNative() public {
        // Register the mock pull facet; it pulls tokenIn but never transfers native to `to`
        bytes4 sel = pullSel;

        uint256 amountIn = 1e18;
        ERC20PermitMock tokenIn = new ERC20PermitMock(
            "IN2",
            "IN2",
            USER_SENDER,
            amountIn
        );

        bytes memory swapData = abi.encodePacked(sel);

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(0),
                amountIn: amountIn,
                minOut: 1,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(tokenIn)).approve(address(ldaDiamond), amountIn);

        // Expect MinimalOutputBalanceViolation with deltaOut = 0 (no ETH sent)
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.MinimalOutputBalanceViolation.selector,
                uint256(0)
            )
        );

        coreRouteFacet.processRoute(
            address(tokenIn),
            amountIn,
            address(0), // tokenOut is native
            1, // amountOutMin > 0
            USER_RECEIVER,
            route
        );
        vm.stopPrank();
    }
}
