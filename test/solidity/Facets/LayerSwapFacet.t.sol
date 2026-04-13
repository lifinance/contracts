// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";
import { ILayerSwapDepository } from "lifi/Interfaces/ILayerSwapDepository.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { InvalidCallData, InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Mock LayerSwap Depository contract for testing
contract MockLayerSwapDepository is ILayerSwapDepository {
    mapping(address => bool) public whitelisted;
    bool public shouldRevert;

    error MockRevert();
    error NotWhitelisted();

    event Deposited(
        bytes32 indexed id,
        address indexed token,
        address indexed receiver,
        uint256 amount
    );

    function setWhitelisted(address receiver, bool allowed) external {
        whitelisted[receiver] = allowed;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function depositNative(
        bytes32 id,
        address receiver
    ) external payable override {
        if (shouldRevert) {
            revert MockRevert();
        }
        if (!whitelisted[receiver]) {
            revert NotWhitelisted();
        }

        emit Deposited(id, address(0), receiver, msg.value);

        (bool success, ) = receiver.call{ value: msg.value }("");
        require(success, "native forward failed");
    }

    function depositERC20(
        bytes32 id,
        address token,
        address receiver,
        uint256 amount
    ) external override {
        if (shouldRevert) {
            revert MockRevert();
        }
        if (!whitelisted[receiver]) {
            revert NotWhitelisted();
        }

        IERC20(token).transferFrom(msg.sender, receiver, amount);

        emit Deposited(id, token, receiver, amount);
    }
}

// Test LayerSwapFacet Contract
contract TestLayerSwapFacet is LayerSwapFacet, TestWhitelistManagerBase {
    constructor(
        address _layerSwapDepository
    ) LayerSwapFacet(_layerSwapDepository) {}
}

contract LayerSwapFacetTest is TestBaseFacet {
    LayerSwapFacet.LayerSwapData internal validLayerSwapData;
    TestLayerSwapFacet internal layerSwapFacet;
    MockLayerSwapDepository internal mockDepository;
    address internal constant DEPOSITORY_RECEIVER =
        0x1234567890123456789012345678901234567890;

    error InvalidNonEVMReceiver();

    event Deposited(
        bytes32 indexed id,
        address indexed token,
        address indexed receiver,
        uint256 amount
    );

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        // Deploy mock depository and whitelist the receiver
        mockDepository = new MockLayerSwapDepository();
        mockDepository.setWhitelisted(DEPOSITORY_RECEIVER, true);

        // Deploy facet
        layerSwapFacet = new TestLayerSwapFacet(address(mockDepository));

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = layerSwapFacet
            .startBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[1] = layerSwapFacet
            .swapAndStartBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[2] = layerSwapFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(layerSwapFacet), functionSelectors);
        layerSwapFacet = TestLayerSwapFacet(address(diamond));

        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(layerSwapFacet), "LayerSwapFacet");

        bridgeData.bridge = "layerswap";
        bridgeData.destinationChainId = 137;

        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: keccak256("testRequestId"),
            depositoryReceiver: DEPOSITORY_RECEIVER,
            nonEVMReceiver: bytes32(0)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            layerSwapFacet.startBridgeTokensViaLayerSwap{
                value: bridgeData.minAmount
            }(bridgeData, validLayerSwapData);
        } else {
            layerSwapFacet.startBridgeTokensViaLayerSwap(
                bridgeData,
                validLayerSwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validLayerSwapData);
        } else {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
                bridgeData,
                swapData,
                validLayerSwapData
            );
        }
    }

    // --- Constructor Tests ---

    function test_CanDeployFacet() public {
        new LayerSwapFacet(address(mockDepository));
    }

    function testRevert_WhenUsingZeroDepository() public {
        vm.expectRevert(InvalidConfig.selector);
        new LayerSwapFacet(address(0));
    }

    function testRevert_WhenDepositoryReceiverIsZero() public {
        validLayerSwapData.depositoryReceiver = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Deposit Tests ---

    function test_DepositoryReceivesERC20()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(
            ADDRESS_USDC,
            DEPOSITORY_RECEIVER,
            int256(defaultUSDCAmount)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(mockDepository));
        emit Deposited(
            validLayerSwapData.requestId,
            ADDRESS_USDC,
            DEPOSITORY_RECEIVER,
            bridgeData.minAmount
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_DepositoryReceivesNative()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(defaultNativeAmount + addToMessageValue)
        )
        assertBalanceChange(
            address(0),
            DEPOSITORY_RECEIVER,
            int256(defaultNativeAmount)
        )
    {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        vm.expectEmit(true, true, true, true, address(mockDepository));
        emit Deposited(
            validLayerSwapData.requestId,
            address(0),
            DEPOSITORY_RECEIVER,
            bridgeData.minAmount
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    // --- Non-EVM Receiver Tests ---

    function testRevert_WhenUsingEmptyNonEVMReceiver() public {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData.nonEVMReceiver = bytes32(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    function test_CanBridgeTokensToNonEVM()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(
            ADDRESS_USDC,
            DEPOSITORY_RECEIVER,
            int256(defaultUSDCAmount)
        )
    {
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData.nonEVMReceiver = nonEVMReceiver;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensToNonEVM()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(defaultNativeAmount + addToMessageValue)
        )
        assertBalanceChange(
            address(0),
            DEPOSITORY_RECEIVER,
            int256(defaultNativeAmount)
        )
    {
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;
        validLayerSwapData.nonEVMReceiver = nonEVMReceiver;

        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensToNonEVM()
        public
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.hasSourceSwaps = true;
        validLayerSwapData.nonEVMReceiver = nonEVMReceiver;

        vm.startPrank(USER_SENDER);
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

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
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
            bridgeData,
            swapData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    // --- Revert Propagation Tests ---

    function testRevert_WhenERC20DepositFails() public {
        mockDepository.setShouldRevert(true);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(MockLayerSwapDepository.MockRevert.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNativeDepositFails() public {
        mockDepository.setShouldRevert(true);

        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        vm.expectRevert(MockLayerSwapDepository.MockRevert.selector);
        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testRevert_WhenReceiverNotWhitelisted() public {
        // Remove whitelist entry to simulate unwhitelisted receiver
        mockDepository.setWhitelisted(DEPOSITORY_RECEIVER, false);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(MockLayerSwapDepository.NotWhitelisted.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
