// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { RelayDepositoryFacet } from "lifi/Facets/RelayDepositoryFacet.sol";
import { IRelayDepository } from "lifi/Interfaces/IRelayDepository.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Mock depository contract for testing
contract MockRelayDepository is IRelayDepository {
    mapping(bytes32 => bool) public depositUsed;
    address public allocator;
    bool public shouldRevert;

    error MockRevert();

    event DepositNative(
        address indexed depositor,
        bytes32 indexed id,
        uint256 amount
    );
    event DepositErc20(
        address indexed depositor,
        address indexed token,
        uint256 amount,
        bytes32 indexed id
    );

    constructor(address _allocator) {
        allocator = _allocator;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function depositNative(
        address depositor,
        bytes32 id
    ) external payable override {
        if (shouldRevert) {
            revert MockRevert();
        }
        depositUsed[id] = true;
        emit DepositNative(depositor, id, msg.value);
    }

    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external override {
        if (shouldRevert) {
            revert MockRevert();
        }
        // Transfer tokens from the caller
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        depositUsed[id] = true;
        emit DepositErc20(depositor, token, amount, id);
    }

    function depositErc20(
        address depositor,
        address token,
        bytes32 id
    ) external override {
        if (shouldRevert) {
            revert MockRevert();
        }
        // Get allowance and transfer
        uint256 allowance = IERC20(token).allowance(msg.sender, address(this));
        IERC20(token).transferFrom(msg.sender, address(this), allowance);
        depositUsed[id] = true;
        emit DepositErc20(depositor, token, allowance, id);
    }

    function withdraw(
        address recipient,
        address token,
        uint256 amount,
        bytes calldata /* signature */
    ) external {
        // Simple implementation for testing
        if (token == address(0)) {
            payable(recipient).transfer(amount);
        } else {
            IERC20(token).transfer(recipient, amount);
        }
    }

    function getAllocator() external view override returns (address) {
        return allocator;
    }
}

// Reverter contract for testing error cases
contract Reverter {
    error AlwaysReverts();

    fallback() external payable {
        revert AlwaysReverts();
    }
}

// Test RelayDepositoryFacet Contract
contract TestRelayDepositoryFacet is RelayDepositoryFacet, TestWhitelistManagerBase {
    constructor(
        address _relayDepository
    ) RelayDepositoryFacet(_relayDepository) {}
}

contract RelayDepositoryFacetTest is TestBaseFacet {
    RelayDepositoryFacet.RelayDepositoryData internal validDepositoryData;
    TestRelayDepositoryFacet internal relayDepositoryFacet;
    MockRelayDepository internal mockDepository;
    address internal constant ALLOCATOR_ADDRESS =
        0x1234567890123456789012345678901234567890;

    function setUp() public {
        customBlockNumberForForking = 19767662;
        initTestBase();

        // Deploy mock depository
        mockDepository = new MockRelayDepository(ALLOCATOR_ADDRESS);

        // Deploy facet
        relayDepositoryFacet = new TestRelayDepositoryFacet(
            address(mockDepository)
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = relayDepositoryFacet
            .startBridgeTokensViaRelayDepository
            .selector;
        functionSelectors[1] = relayDepositoryFacet
            .swapAndStartBridgeTokensViaRelayDepository
            .selector;
        functionSelectors[2] = relayDepositoryFacet.addAllowedContractSelector.selector;

        addFacet(diamond, address(relayDepositoryFacet), functionSelectors);
        relayDepositoryFacet = TestRelayDepositoryFacet(address(diamond));

        // Setup DEX approvals
        relayDepositoryFacet.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapExactTokensForTokens.selector);
        relayDepositoryFacet.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapTokensForExactETH.selector);
        relayDepositoryFacet.addAllowedContractSelector(ADDRESS_UNISWAP, uniswap.swapETHForExactTokens.selector);

        setFacetAddressInTestBase(
            address(relayDepositoryFacet),
            "RelayDepositoryFacet"
        );

        // Setup bridge data
        bridgeData.bridge = "relay-depository";
        bridgeData.destinationChainId = 137;

        // Setup valid depository data
        validDepositoryData = RelayDepositoryFacet.RelayDepositoryData({
            orderId: bytes32("test-order-id"),
            depositorAddress: USER_SENDER
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            relayDepositoryFacet.startBridgeTokensViaRelayDepository{
                value: bridgeData.minAmount
            }(bridgeData, validDepositoryData);
        } else {
            relayDepositoryFacet.startBridgeTokensViaRelayDepository(
                bridgeData,
                validDepositoryData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            relayDepositoryFacet.swapAndStartBridgeTokensViaRelayDepository{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validDepositoryData);
        } else {
            relayDepositoryFacet.swapAndStartBridgeTokensViaRelayDepository(
                bridgeData,
                swapData,
                validDepositoryData
            );
        }
    }

    // Test successful deployment
    function test_CanDeployFacet() public {
        new RelayDepositoryFacet(address(mockDepository));
    }

    // Test revert when constructed with zero address
    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidCallData.selector);

        new RelayDepositoryFacet(address(0));
    }

    // Test ERC20 deposit
    function test_CanDepositERC20Tokens()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(
            ADDRESS_USDC,
            address(mockDepository),
            int256(defaultUSDCAmount)
        )
    {
        vm.startPrank(USER_SENDER);

        // Approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Test native token deposit
    function test_CanDepositNativeTokens()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(defaultNativeAmount + addToMessageValue)
        )
        assertBalanceChange(
            address(0),
            address(mockDepository),
            int256(defaultNativeAmount)
        )
    {
        vm.startPrank(USER_SENDER);

        // Customize bridge data for native tokens
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    // Test swap and deposit ERC20
    function test_CanSwapAndDepositERC20Tokens()
        public
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(
            ADDRESS_USDC,
            address(mockDepository),
            int256(bridgeData.minAmount)
        )
    {
        vm.startPrank(USER_SENDER);

        // Prepare bridge data
        bridgeData.hasSourceSwaps = true;

        // Reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Test swap and deposit native tokens
    function test_CanSwapAndDepositNativeTokens()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // Store initial balances
        uint256 initialUsdcBalance = usdc.balanceOf(USER_SENDER);

        // Prepare bridge data
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // Prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Approval
        usdc.approve(_facetTestContractAddress, amountIn);

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);

        // Check balances
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUsdcBalance - swapData[0].fromAmount
        );
        vm.stopPrank();
    }

    // Test revert when native deposit fails
    function testRevert_WhenNativeDepositFails() public {
        // Make the mock depository revert
        mockDepository.setShouldRevert(true);

        vm.startPrank(USER_SENDER);

        // Customize bridge data for native tokens
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        vm.expectRevert();
        initiateBridgeTxWithFacet(true);

        vm.stopPrank();
    }

    // Test revert when ERC20 deposit fails
    function testRevert_WhenERC20DepositFails() public {
        // Make the mock depository revert
        mockDepository.setShouldRevert(true);

        vm.startPrank(USER_SENDER);

        // Approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert();
        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // Test revert when depositor address is zero address
    function testRevert_WhenDepositorAddressIsZero() public {
        vm.startPrank(USER_SENDER);

        // Create invalid depository data with zero address
        RelayDepositoryFacet.RelayDepositoryData
            memory invalidDepositoryData = RelayDepositoryFacet
                .RelayDepositoryData({
                    orderId: bytes32("test-order-id"),
                    depositorAddress: address(0)
                });

        // Approval for ERC20 case
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect revert with InvalidCallData error for ERC20 deposit
        vm.expectRevert(InvalidCallData.selector);
        relayDepositoryFacet.startBridgeTokensViaRelayDepository(
            bridgeData,
            invalidDepositoryData
        );

        // Test native token case as well
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        // Expect revert with InvalidCallData error for native deposit
        vm.expectRevert(InvalidCallData.selector);
        relayDepositoryFacet.startBridgeTokensViaRelayDepository{
            value: defaultNativeAmount
        }(bridgeData, invalidDepositoryData);

        vm.stopPrank();
    }

    // Test revert when depositor address is zero address in swap and bridge
    function testRevert_WhenDepositorAddressIsZeroInSwapAndBridge() public {
        vm.startPrank(USER_SENDER);

        // Create invalid depository data with zero address
        RelayDepositoryFacet.RelayDepositoryData
            memory invalidDepositoryData = RelayDepositoryFacet
                .RelayDepositoryData({
                    orderId: bytes32("test-order-id"),
                    depositorAddress: address(0)
                });

        // Prepare bridge data with source swaps
        bridgeData.hasSourceSwaps = true;

        // Reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // Expect revert with InvalidCallData error
        vm.expectRevert(InvalidCallData.selector);
        relayDepositoryFacet.swapAndStartBridgeTokensViaRelayDepository(
            bridgeData,
            swapData,
            invalidDepositoryData
        );

        vm.stopPrank();
    }

    // Test fuzzed amounts
    function test_FuzzedAmounts(uint256 amount) public {
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);

        // Set unique order ID for each fuzz run
        validDepositoryData.orderId = keccak256(
            abi.encodePacked("fuzz", amount)
        );

        // Approval
        usdc.approve(_facetTestContractAddress, amount);

        // Update bridge data
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        // Execute and verify
        uint256 initialBalance = usdc.balanceOf(address(mockDepository));
        initiateBridgeTxWithFacet(false);
        assertEq(
            usdc.balanceOf(address(mockDepository)),
            initialBalance + amount
        );

        vm.stopPrank();
    }
}
