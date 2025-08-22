// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20PermitMock } from "lib/Permit2/lib/openzeppelin-contracts/contracts/mocks/ERC20PermitMock.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { BaseCoreRouteTest } from "../BaseCoreRouteTest.t.sol";

contract CoreRouteFacetTest is BaseCoreRouteTest {
    using SafeTransferLib for address;

    bytes4 internal pullSel;

    // ==== Setup Functions ====
    function setUp() public override {
        super.setUp();
        // Register mock pull facet once and store selector
        MockPullERC20Facet mockPull = new MockPullERC20Facet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = MockPullERC20Facet.pull.selector;
        addFacet(ldaDiamond, address(mockPull), sel);
        pullSel = sel[0];
    }

    // ==== Helper Functions ====
    function _addMockNativeFacet() internal {
        MockNativeFacet mock = new MockNativeFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockNativeFacet.handleNative.selector;
        addFacet(ldaDiamond, address(mock), selectors);
    }

    function _addMockPullFacet() internal returns (bytes4 sel) {
        MockPullERC20Facet mock = new MockPullERC20Facet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockPullERC20Facet.pull.selector;
        addFacet(ldaDiamond, address(mock), selectors);
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

    // ==== Test Cases ====
    function test_ContractIsSetUpCorrectly() public {
        // Test that owner is set correctly
        assertEq(
            coreRouteFacet.owner(),
            USER_DIAMOND_OWNER,
            "owner not set correctly"
        );
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new CoreRouteFacet(address(0));
    }

    function test_ProcessNativeCommandSendsEthToRecipient() public {
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
            recipient: USER_RECEIVER,
            commandType: CommandType.ProcessNative
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

    // TokenInSpendingExceeded: trigger by charging the user twice via two ProcessUserERC20 steps.
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
        address recipient = abi.decode(payload, (address));
        LibAsset.transferAsset(address(0), payable(recipient), amountIn);
        return amountIn;
    }
}
