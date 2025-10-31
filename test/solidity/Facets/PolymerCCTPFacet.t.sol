// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import {Test} from "forge-std/Test.sol";
import {PolymerCCTPFacet} from "lifi/Facets/PolymerCCTPFacet.sol";
import {IPolymerCCTPFacet} from "lifi/Interfaces/IPolymerCCTP.sol";
import {PolymerCCTPData} from "lifi/Interfaces/IPolymerCCTP.sol";
import {ILiFi} from "lifi/Interfaces/ILiFi.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {InvalidReceiver, InvalidAmount, InvalidSendingToken} from "src/Errors/GenericErrors.sol";

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

contract PolymerCCTPFacetTest is Test {
    PolymerCCTPFacet public facet;
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
        facet = new PolymerCCTPFacet(address(tokenMessenger), address(usdc), feeReceiver);

        // Mint USDC to user
        usdc.mint(user, 1_000_000e6); // 1M USDC
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
            destinationChainId: 81457, // Blast
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

    function test_Revert_FeeGreaterThanAmount() public {
        uint256 bridgeAmount = 100e6;
        uint256 polymerFee = 100e6; // Fee equals amount

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(uint256(1)),
            bridge: "polymercctp",
            integrator: "test",
            referrer: address(0),
            sendingAssetId: address(usdc),
            receiver: receiver,
            minAmount: bridgeAmount,
            destinationChainId: 81457,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        PolymerCCTPData memory polymerData = PolymerCCTPData({
            polymerTokenFee: polymerFee, maxCCTPFee: 0, nonEvmAddress: bytes32(0), minFinalityThreshold: 0
        });

        vm.startPrank(user);
        usdc.approve(address(facet), bridgeAmount);

        vm.expectRevert(IPolymerCCTPFacet.FeeCannotBeLessThanAmount.selector);
        facet.startBridgeTokensViaPolymerCCTP(bridgeData, polymerData);

        vm.stopPrank();
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
            destinationChainId: 81457,
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
            destinationChainId: 81457,
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
            destinationChainId: 81457,
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
}
