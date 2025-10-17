// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {Test} from "forge-std/Test.sol";
import {PolymerCCTPFacet} from "lifi/Facets/PolymerCCTPFacet.sol";
import {PolymerCCTPData} from "lifi/Facets/PolymerCCTPFacet.sol";
import {ILiFi} from "lifi/Interfaces/ILiFi.sol";
import {LibSwap} from "lifi/Libraries/LibSwap.sol";
import {LibAllowList} from "lifi/Libraries/LibAllowList.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {InvalidReceiver, InvalidAmount, InvalidCallData, InvalidSendingToken} from "src/Errors/GenericErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Test version with allowlist management
contract TestPolymerCCTPFacet is PolymerCCTPFacet {
    constructor(address _tokenMessenger, address _usdc, address _polymerFeeReceiver)
        PolymerCCTPFacet(_tokenMessenger, _usdc, _polymerFeeReceiver)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }

    // Expose internal function for testing
    function chainIdToDomainId(uint256 chainId) external pure returns (uint32) {
        return _chainIdToDomainId(chainId);
    }

    // Override to bypass owner check in tests
    function initPolymerCCTP() external virtual override {
        IERC20(USDC).approve(address(TOKEN_MESSENGER), type(uint256).max);
    }
}

// Mock TokenMessenger
contract MockTokenMessenger {
    event DepositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken);

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32,
        uint256,
        uint32
    ) external {
        // Transfer tokens from caller
        ERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        emit DepositForBurn(amount, destinationDomain, mintRecipient, burnToken);
    }
}

// Mock USDC
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC", 6) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Mock token for swap testing
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol, uint8 decimals) ERC20(name, symbol, decimals) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Mock DEX for swapping
contract MockDEX {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        ERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        ERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}

contract PolymerCCTPFacetTest is Test {
    TestPolymerCCTPFacet public facet;
    MockTokenMessenger public tokenMessenger;
    MockUSDC public usdc;

    address public feeReceiver = address(0x123);
    address public user = address(0x456);
    address public receiver = address(0x789);

    function setUp() public {
        // Deploy mocks
        usdc = new MockUSDC();
        tokenMessenger = new MockTokenMessenger();

        // Deploy facet
        facet = new TestPolymerCCTPFacet(address(tokenMessenger), address(usdc), feeReceiver);

        // Mint USDC to user
        usdc.mint(user, 1_000_000e6); // 1M USDC
        facet.initPolymerCCTP();
    }

    function test_CanBridgeUSDCViaPolymerCCTP() public {
        uint256 bridgeAmount = 100_000e6; // 100k USDC
        uint256 polymerFee = 100e6; // 100 USDC fee
        uint256 amountAfterFee = bridgeAmount - polymerFee;

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: receiver,
            minAmount: bridgeAmount,
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: polymerFee, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);

        // Approve facet to spend USDC
        usdc.approve(address(facet), bridgeAmount);

        // Execute bridge
        facet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        vm.stopPrank();

        // Verify fee receiver got the fee
        assertEq(usdc.balanceOf(feeReceiver), polymerFee);

        // Verify token messenger got the bridge amount minus fee
        assertEq(usdc.balanceOf(address(tokenMessenger)), amountAfterFee);

        // Verify user's balance decreased
        assertEq(usdc.balanceOf(user), 1_000_000e6 - bridgeAmount);
    }

    function test_Revert_ZeroAmount() public {
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: receiver,
            minAmount: 0,
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: 100e6, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);

        vm.expectRevert(InvalidAmount.selector);
        facet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        vm.stopPrank();
    }

    function test_Revert_ZeroReceiver() public {
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: address(0),
            minAmount: 100_000e6,
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: 100e6, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);
        usdc.approve(address(facet), bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        facet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        vm.stopPrank();
    }

    function test_Revert_InvalidSendingAsset() public {
        MockUSDC wrongToken = new MockUSDC();
        wrongToken.mint(user, 1_000_000e6);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(wrongToken),
            receiver: receiver,
            minAmount: 100_000e6,
            destinationChainId: 8453, // Base
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: 100e6, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);
        wrongToken.approve(address(facet), bridgeData.minAmount);

        vm.expectRevert(InvalidSendingToken.selector);
        facet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeViaPolymerCCTP() public {
        // Deploy mock token and DEX
        MockToken dai = new MockToken("DAI", "DAI", 18);
        MockDEX dex = new MockDEX();

        // Add DEX to allowlist
        facet.addDex(address(dex));
        facet.setFunctionApprovalBySignature(MockDEX.swap.selector);

        // Setup: User has DAI, wants to swap to USDC and bridge
        uint256 daiAmount = 100_000e18; // 100k DAI
        uint256 usdcAmount = 100_000e6; // 100k USDC (after swap)
        uint256 polymerFee = 100e6; // 100 USDC fee
        uint256 amountAfterFee = usdcAmount - polymerFee;

        // Mint DAI to user and USDC to DEX
        dai.mint(user, daiAmount);
        usdc.mint(address(dex), usdcAmount);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: receiver,
            minAmount: usdcAmount,
            destinationChainId: 8453, // Base
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // Create swap data
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(dex),
            approveTo: address(dex),
            sendingAssetId: address(dai),
            receivingAssetId: address(usdc),
            fromAmount: daiAmount,
            callData: abi.encodeWithSelector(MockDEX.swap.selector, address(dai), address(usdc), daiAmount, usdcAmount),
            requiresDeposit: true
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: polymerFee, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);

        // Approve facet to spend DAI
        dai.approve(address(facet), daiAmount);

        // Execute swap and bridge
        facet.swapAndStartBridgeTokensViaPolymerCCTP(bridgeData, swapData, polymerData);

        vm.stopPrank();

        // Verify fee receiver got the fee
        assertEq(usdc.balanceOf(feeReceiver), polymerFee);

        // Verify token messenger got the bridge amount minus fee
        assertEq(usdc.balanceOf(address(tokenMessenger)), amountAfterFee);

        // Verify user's DAI balance decreased
        assertEq(dai.balanceOf(user), 0);

        // Verify DEX has the DAI
        assertEq(dai.balanceOf(address(dex)), daiAmount);
    }
}
