// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20PermitMock } from "lib/Permit2/lib/openzeppelin-contracts/contracts/mocks/ERC20PermitMock.sol";
import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { BaseCoreRouteTest } from "../BaseCoreRouteTest.t.sol";
import { Vm } from "forge-std/Vm.sol";

/// @title CoreRouteFacetTest
/// @notice Tests the CoreRouteFacet's command parser, permit handling, and minimal invariants.
/// @dev Adds small mock “facets” that emulate pull/native handlers for exercising route execution.
contract CoreRouteFacetTest is BaseCoreRouteTest {
    using SafeTransferLib for address;

    /// @notice Cached selector for the mock pull facet to simplify route building in tests.
    bytes4 internal pullSel;

    // ==== Events ====
    event Pulled(uint256 amt);

    // ==== Setup Functions ====

    /// @notice Registers a mock pull facet once and stores its selector for reuse.
    /// @dev Also calls parent `setUp` to add CoreRouteFacet to the diamond.
    function setUp() public override {
        super.setUp();
        // Register mock pull facet once and store selector
        MockPullERC20Facet mockPull = new MockPullERC20Facet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = MockPullERC20Facet.pull.selector;
        addFacet(address(ldaDiamond), address(mockPull), sel);
        pullSel = sel[0];
    }

    // ==== Helper Functions ====

    /// @notice Adds a mock native handler facet to the diamond for ProcessNative tests.
    function _addMockNativeFacet() internal {
        MockNativeFacet mock = new MockNativeFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockNativeFacet.handleNative.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);
    }

    /// @notice Adds a mock pull facet to the diamond and returns its selector.
    /// @return sel Selector of the mock pull function.
    function _addMockPullFacet() internal returns (bytes4 sel) {
        MockPullERC20Facet mock = new MockPullERC20Facet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockPullERC20Facet.pull.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);
        return selectors[0];
    }

    /// @notice Signs an EIP-2612 permit for a mock token and returns the ECDSA tuple.
    /// @param token Permit-enabled mock token.
    /// @param ownerPk Private key of the owner (forge-anvil test key).
    /// @param owner Owner address.
    /// @param spender Spender to approve (diamond in our tests).
    /// @param value Allowance value.
    /// @param deadline Permit deadline.
    /// @return v ECDSA v
    /// @return r ECDSA r
    /// @return s ECDSA s
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

    // ==== Test Cases ====

    /// @notice Sanity-checks deployment wiring and ownership.
    function test_ContractIsSetUpCorrectly() public {
        // Test that owner is set correctly
        assertEq(
            coreRouteFacet.owner(),
            USER_LDA_DIAMOND_OWNER,
            "owner not set correctly"
        );
    }

    /// @notice Constructor must revert on zero owner; verifies InvalidConfig.
    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new CoreRouteFacet(address(0));
    }

    /// @notice Verifies DistributeNative command passes ETH to receiver and emits Route with exact out.
    /// @dev Builds a route with a mock native handler and funds USER_SENDER with 1 ETH.
    function test_DistributeNativeCommandSendsEthToReceiver() public {
        _addMockNativeFacet();

        uint256 amount = 1 ether;

        // Fund the actual caller (USER_SENDER)
        vm.deal(USER_SENDER, amount);

        // swapData: selector + abi.encode(USER_RECEIVER)
        bytes memory swapData = abi.encodePacked(
            MockNativeFacet.handleNative.selector,
            abi.encode(USER_RECEIVER)
        );

        // route: [3][num=1][share=FULL_SHARE][len][swapData]
        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(0),
            tokenOut: address(0),
            amountIn: amount,
            minOut: 0,
            sender: USER_SENDER, // Use USER_SENDER directly
            destinationAddress: USER_RECEIVER,
            commandType: CommandType.DistributeNative
        });

        bytes memory route = _buildBaseRoute(params, swapData);

        vm.prank(USER_SENDER); // Set msg.sender to USER_SENDER
        _executeAndVerifySwap(
            params,
            route,
            new ExpectedEvent[](0),
            false,
            RouteEventVerification({
                expectedExactOut: amount,
                checkData: true
            })
        );
    }

    /// @notice Applies an EIP-2612 permit via ApplyPermit command and verifies allowance on diamond.
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

    /// @notice Unknown command codes should revert; verifies UnknownCommandCode error.
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

    /// @notice Unknown selectors in a step should revert; verifies UnknownSelector.
    function testRevert_WhenSelectorIsUnknown() public {
        ERC20PermitMock token = new ERC20PermitMock(
            "Mock2",
            "MCK2",
            USER_SENDER,
            1e18
        );

        bytes memory swapData = abi.encodePacked(bytes4(0xdeadbeef));

        // DistributeUserERC20: [2][tokenIn][num=1][share=FULL_SHARE][len=4][selector=0xdeadbeef]
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(token),
                tokenOut: address(token),
                amountIn: 0,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
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

    /// @notice TokenInSpendingExceeded: trigger by charging the user twice via two DistributeUserERC20 steps.
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
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        );

        bytes memory route = bytes.concat(step, step);

        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.SwapTokenInSpendingExceeded.selector,
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

    /// @notice Same as above but with tokenOut set to an ERC20, to ensure path-independent behavior.
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
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        );

        bytes memory route = bytes.concat(step, step);

        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.SwapTokenInSpendingExceeded.selector,
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
        ); // destination address starts at 0

        bytes memory swapData = abi.encodePacked(sel);

        // Build one DistributeUserERC20 step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 1,
                sender: USER_SENDER,
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        ); // single step; no tokenOut will be sent to receiver

        vm.startPrank(USER_SENDER);
        IERC20(address(tokenIn)).approve(address(ldaDiamond), amountIn);

        // Expect MinimalOutputBalanceViolation with deltaOut = 0
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.SwapTokenOutAmountTooLow.selector,
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
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(tokenIn)).approve(address(ldaDiamond), amountIn);

        // Expect MinimalOutputBalanceViolation with deltaOut = 0 (no ETH sent)
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreRouteFacet.SwapTokenOutAmountTooLow.selector,
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

    function test_DistributeUserERC20_TwoLegs_50_50_UsesOriginalTotalAndRemainder()
        public
    {
        // Deploy + register mock facet that records each leg's amount via an event
        MockRecordPullFacet mock = new MockRecordPullFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockRecordPullFacet.pullAndRecord.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);

        // Mint token to USER_SENDER
        uint256 totalAmount = 1e18;
        ERC20PermitMock token = new ERC20PermitMock(
            "IN",
            "IN",
            USER_SENDER,
            totalAmount
        );

        // Build route: DistributeUserERC20 with 2 legs, 50%/50%
        uint16 shareScale = type(uint16).max;
        uint16 halfShare = shareScale / 2;
        bytes memory legCalldata = abi.encodePacked(selectors[0]); // 4 bytes
        bytes memory route = abi.encodePacked(
            uint8(2), // DistributeUserERC20
            address(token), // tokenIn
            uint8(2), // n = 2 legs
            halfShare,
            uint16(4),
            legCalldata, // leg1: 50%
            halfShare,
            uint16(4),
            legCalldata // leg2: 50%
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(token)).approve(address(ldaDiamond), totalAmount);

        // Record logs and run
        vm.recordLogs();
        coreRouteFacet.processRoute(
            address(token), // tokenIn
            totalAmount, // declared amount
            address(0), // tokenOut (unused)
            0,
            USER_RECEIVER,
            route
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.stopPrank();

        // Collect Pulled(uint256) amounts
        bytes32 pulledEventTopic = keccak256("Pulled(uint256)");
        uint256[] memory pulledAmounts = new uint256[](2);
        uint256 eventCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == pulledEventTopic
            ) {
                pulledAmounts[eventCount++] = uint256(bytes32(logs[i].data));
            }
        }
        assertEq(eventCount, 2, "expected two leg pulls");

        // Expected amounts: first computed from original total, last is exact remainder
        uint256 expectedFirstLeg = (totalAmount * halfShare) / shareScale;
        uint256 expectedSecondLeg = totalAmount - expectedFirstLeg;

        assertEq(pulledAmounts[0], expectedFirstLeg, "leg1 amount mismatch");
        assertEq(
            pulledAmounts[1],
            expectedSecondLeg,
            "leg2 remainder mismatch"
        );
        assertEq(
            pulledAmounts[0] + pulledAmounts[1],
            totalAmount,
            "sum != total"
        );
    }

    function test_DistributeUserERC20_ThreeLegs_25_25_50_UsesOriginalTotalAndRemainder()
        public
    {
        // Deploy + register mock facet
        MockRecordPullFacet mock = new MockRecordPullFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockRecordPullFacet.pullAndRecord.selector;
        addFacet(address(ldaDiamond), address(mock), selectors);

        uint256 totalAmount = 1e18;
        ERC20PermitMock token = new ERC20PermitMock(
            "IN2",
            "IN2",
            USER_SENDER,
            totalAmount
        );

        uint16 shareScale = type(uint16).max;
        uint16 quarterShare = shareScale / 4;
        // Third leg share is arbitrary; last leg receives remainder by design
        uint16 dummyShare = shareScale / 2;

        bytes memory legCalldata = abi.encodePacked(selectors[0]); // 4 bytes
        bytes memory route = abi.encodePacked(
            uint8(2), // DistributeUserERC20
            address(token), // tokenIn
            uint8(3), // n = 3 legs
            quarterShare,
            uint16(4),
            legCalldata, // 25%
            quarterShare,
            uint16(4),
            legCalldata, // 25%
            dummyShare,
            uint16(4),
            legCalldata // (ignored) gets remainder
        );

        vm.startPrank(USER_SENDER);
        IERC20(address(token)).approve(address(ldaDiamond), totalAmount);
        vm.recordLogs();
        coreRouteFacet.processRoute(
            address(token),
            totalAmount,
            address(0),
            0,
            USER_RECEIVER,
            route
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.stopPrank();

        bytes32 pulledEventTopic = keccak256("Pulled(uint256)");
        uint256[] memory pulledAmounts = new uint256[](3);
        uint256 eventCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == pulledEventTopic
            ) {
                pulledAmounts[eventCount++] = uint256(bytes32(logs[i].data));
            }
        }
        assertEq(eventCount, 3, "expected three leg pulls");

        uint256 expectedFirstLeg = (totalAmount * quarterShare) / shareScale;
        uint256 expectedSecondLeg = (totalAmount * quarterShare) / shareScale;
        uint256 expectedThirdLeg = totalAmount -
            (expectedFirstLeg + expectedSecondLeg);

        assertEq(pulledAmounts[0], expectedFirstLeg, "leg1 amount mismatch");
        assertEq(pulledAmounts[1], expectedSecondLeg, "leg2 amount mismatch");
        assertEq(
            pulledAmounts[2],
            expectedThirdLeg,
            "leg3 remainder mismatch"
        );
        assertEq(
            pulledAmounts[0] + pulledAmounts[1] + pulledAmounts[2],
            totalAmount,
            "sum != total"
        );
    }
}

/// @dev Mock facet that records each leg's amount via an event
contract MockRecordPullFacet {
    event Pulled(uint256 amt);
    function pullAndRecord(
        bytes memory /*payload*/,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }
        emit Pulled(amountIn);
        return amountIn;
    }
}

/// @dev Mock facet implementing LDA's standard interface for testing ERC20 token pulls
contract MockPullERC20Facet {
    function pull(
        bytes memory /*payload*/,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }
        return amountIn;
    }
}

/// @dev Mock facet implementing LDA's standard interface for testing native token handling
contract MockNativeFacet {
    function handleNative(
        bytes memory payload,
        address /*from*/,
        address /*tokenIn*/,
        uint256 amountIn
    ) external payable returns (uint256) {
        address receiverAddress = abi.decode(payload, (address));
        LibAsset.transferAsset(address(0), payable(receiverAddress), amountIn);
        return amountIn;
    }
}
