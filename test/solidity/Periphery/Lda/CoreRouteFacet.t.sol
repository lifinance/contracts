// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";
import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";
import { ERC20PermitMock } from "lib/Permit2/lib/openzeppelin-contracts/contracts/mocks/ERC20PermitMock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

contract CoreRouteFacetTest is LdaDiamondTest {
    using SafeTransferLib for address;

    CoreRouteFacet internal coreRouteFacet;

    uint16 internal constant FULL_SHARE = 65535;
    bytes4 internal pullSel;

    function setUp() public override {
        LdaDiamondTest.setUp();

        // CoreRouteFacet
        coreRouteFacet = new CoreRouteFacet();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(address(ldaDiamond), address(coreRouteFacet), selectors);
        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));

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
        bytes memory route = abi.encodePacked(
            uint8(3),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length),
            swapData
        );

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

        // ProcessUserERC20: [2][tokenIn][num=1][share=FULL_SHARE][len=4][selector=0xdeadbeef]
        bytes memory route = abi.encodePacked(
            uint8(2),
            address(token),
            uint8(1),
            FULL_SHARE,
            uint16(4),
            bytes4(0xdeadbeef)
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

        // Build one step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory step = abi.encodePacked(
            uint8(2),
            address(token),
            uint8(1),
            FULL_SHARE,
            uint16(4),
            pullSel
        );

        // Route with two identical steps → actual deduction = 2 * amountIn, but amountIn param = amountIn
        bytes memory route = bytes.concat(step, step);

        // Expect MinimalInputBalanceViolation
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

        bytes memory step = abi.encodePacked(
            uint8(2),
            address(token),
            uint8(1),
            FULL_SHARE,
            uint16(4),
            pullSel
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

        // Build one ProcessUserERC20 step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory step = abi.encodePacked(
            uint8(2),
            address(tokenIn),
            uint8(1),
            FULL_SHARE,
            uint16(4),
            sel
        );

        bytes memory route = step; // single step; no tokenOut will be sent to recipient

        // Approve and call
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

        // Build one ProcessUserERC20 step: [2][tokenIn][num=1][share=FULL_SHARE][len=4][sel]
        bytes memory step = abi.encodePacked(
            uint8(2),
            address(tokenIn),
            uint8(1),
            FULL_SHARE,
            uint16(4),
            sel
        );

        bytes memory route = step; // no native will be sent to recipient

        // Approve and call
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
