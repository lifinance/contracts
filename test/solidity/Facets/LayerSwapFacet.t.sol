// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";
import { ILayerSwapDepository } from "lifi/Interfaces/ILayerSwapDepository.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { InvalidCallData, InvalidConfig, InvalidSignature } from "lifi/Errors/GenericErrors.sol";
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
        address _layerSwapDepository,
        address _backendSigner
    ) LayerSwapFacet(_layerSwapDepository, _backendSigner) {}
}

contract LayerSwapFacetTest is TestBaseFacet {
    LayerSwapFacet.LayerSwapData internal validLayerSwapData;
    TestLayerSwapFacet internal layerSwapFacet;
    MockLayerSwapDepository internal mockDepository;
    address internal constant DEPOSITORY_RECEIVER =
        0x1234567890123456789012345678901234567890;

    // Backend signer for EIP-712
    uint256 internal backendSignerPrivateKey =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress = vm.addr(backendSignerPrivateKey);

    // EIP-712 typehash (must match the facet constant)
    // keccak256("LayerSwapPayload(bytes32 transactionId,uint256 minAmount,address receiver,bytes32 requestId,address depositoryReceiver,bytes32 nonEVMReceiver,uint256 destinationChainId,address sendingAssetId,uint256 deadline)")
    bytes32 internal constant LAYERSWAP_PAYLOAD_TYPEHASH =
        0x36f801a910846003d851067e2763fa7696d5d9e7de9f98805c0ebdcaca4e87c2;

    struct LayerSwapPayload {
        bytes32 transactionId;
        uint256 minAmount;
        address receiver;
        bytes32 requestId;
        address depositoryReceiver;
        bytes32 nonEVMReceiver;
        uint256 destinationChainId;
        address sendingAssetId;
        uint256 deadline;
    }

    error InvalidNonEVMReceiver();
    error SignatureExpired();
    error RequestAlreadyProcessed();

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

        // Deploy facet with backend signer
        layerSwapFacet = new TestLayerSwapFacet(
            address(mockDepository),
            backendSignerAddress
        );

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
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForETH.selector
        );

        setFacetAddressInTestBase(address(layerSwapFacet), "LayerSwapFacet");

        bridgeData.bridge = "layerswap";
        bridgeData.destinationChainId = 137;

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );
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
        new LayerSwapFacet(address(mockDepository), backendSignerAddress);
    }

    function testRevert_WhenUsingZeroDepository() public {
        vm.expectRevert(InvalidConfig.selector);
        new LayerSwapFacet(address(0), backendSignerAddress);
    }

    function testRevert_WhenBackendSignerIsZero() public {
        vm.expectRevert(InvalidConfig.selector);
        new LayerSwapFacet(address(mockDepository), address(0));
    }

    function testRevert_WhenDepositoryReceiverIsZero() public {
        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-zeroReceiver"),
            address(0),
            bytes32(0),
            bridgeData,
            block.chainid
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Base Test Overrides (re-sign after bridgeData changes) ---

    function testBase_CanBridgeNativeTokens()
        public
        virtual
        override
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-baseNative"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(
        uint256 amount
    ) public virtual override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        logFilePath = "./test/logs/";
        vm.writeLine(logFilePath, vm.toString(amount));

        usdc.approve(_facetTestContractAddress, amount);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256(abi.encodePacked("testRequestId-fuzz-", amount)),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public virtual override {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        uint256 daiAmount = 300 * 10 ** dai.decimals();

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        dai.approve(_facetTestContractAddress, daiAmount);

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-baseSwapNative"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-native"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-nonEVM-empty"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-nonEVM"),
            DEPOSITORY_RECEIVER,
            nonEVMReceiver,
            bridgeData,
            block.chainid
        );

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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-nativeNonEVM"),
            DEPOSITORY_RECEIVER,
            nonEVMReceiver,
            bridgeData,
            block.chainid
        );

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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-swapNonEVM"),
            DEPOSITORY_RECEIVER,
            nonEVMReceiver,
            bridgeData,
            block.chainid
        );

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

        validLayerSwapData = _generateValidLayerSwapData(
            keccak256("testRequestId-nativeRevert"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            bridgeData,
            block.chainid
        );

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

    // --- EIP-712 Signature Tests ---

    function testRevert_InvalidSignature() public {
        vm.startPrank(USER_SENDER);

        // Sign with wrong private key
        uint256 wrongPrivateKey = 0x9876543210987654321098765432109876543210987654321098765432109876;

        LayerSwapPayload memory payload = _createLayerSwapPayload(
            bridgeData,
            validLayerSwapData.requestId,
            validLayerSwapData.depositoryReceiver,
            validLayerSwapData.nonEVMReceiver,
            validLayerSwapData.deadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(block.chainid);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory wrongSignature = _signDigest(wrongPrivateKey, digest);

        LayerSwapFacet.LayerSwapData memory invalidData = LayerSwapFacet
            .LayerSwapData({
                requestId: validLayerSwapData.requestId,
                depositoryReceiver: validLayerSwapData.depositoryReceiver,
                nonEVMReceiver: validLayerSwapData.nonEVMReceiver,
                signature: wrongSignature,
                deadline: validLayerSwapData.deadline
            });

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(bridgeData, invalidData);

        vm.stopPrank();
    }

    function testRevert_SignatureExpired() public {
        vm.startPrank(USER_SENDER);

        uint256 expiredDeadline = block.timestamp - 1 hours;

        LayerSwapPayload memory payload = _createLayerSwapPayload(
            bridgeData,
            keccak256("testRequestId-expired"),
            DEPOSITORY_RECEIVER,
            bytes32(0),
            expiredDeadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(block.chainid);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        LayerSwapFacet.LayerSwapData memory expiredData = LayerSwapFacet
            .LayerSwapData({
                requestId: keccak256("testRequestId-expired"),
                depositoryReceiver: DEPOSITORY_RECEIVER,
                nonEVMReceiver: bytes32(0),
                signature: signature,
                deadline: expiredDeadline
            });

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(SignatureExpired.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(bridgeData, expiredData);

        vm.stopPrank();
    }

    function testRevert_RequestAlreadyProcessed() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount * 2);

        // First call should succeed
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );

        // Second call with same requestId should fail
        vm.expectRevert(RequestAlreadyProcessed.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );

        vm.stopPrank();
    }

    function test_DifferentRequestIds_ShouldSucceed() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount * 2);

        // First call
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );

        // Second call with different requestId
        LayerSwapFacet.LayerSwapData
            memory secondData = _generateValidLayerSwapData(
                keccak256("differentRequestId"),
                DEPOSITORY_RECEIVER,
                bytes32(0),
                bridgeData,
                block.chainid
            );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.startBridgeTokensViaLayerSwap(bridgeData, secondData);

        vm.stopPrank();
    }

    function testRevert_ReplayAttackPrevention_CrossFunction() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // First use startBridgeTokensViaLayerSwap
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );

        // Try to reuse requestId via swapAndStartBridgeTokensViaLayerSwap
        bridgeData.hasSourceSwaps = true;

        LayerSwapFacet.LayerSwapData
            memory replayData = _generateValidLayerSwapData(
                validLayerSwapData.requestId,
                DEPOSITORY_RECEIVER,
                bytes32(0),
                bridgeData,
                block.chainid
            );

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(RequestAlreadyProcessed.selector);
        layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
            bridgeData,
            swapData,
            replayData
        );

        vm.stopPrank();
    }

    function testRevert_SignatureMismatch_WrongReceiver() public {
        vm.startPrank(USER_SENDER);

        // Sign for user_receiver but call with a different receiver
        ILiFi.BridgeData memory modifiedBridgeData = bridgeData;
        modifiedBridgeData.receiver = address(0xdead);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            modifiedBridgeData,
            validLayerSwapData
        );

        vm.stopPrank();
    }

    function testRevert_SignatureMismatch_WrongRequestId() public {
        vm.startPrank(USER_SENDER);

        // Use a different requestId than what was signed
        LayerSwapFacet.LayerSwapData memory tamperedData = LayerSwapFacet
            .LayerSwapData({
                requestId: keccak256("tamperedRequestId"),
                depositoryReceiver: validLayerSwapData.depositoryReceiver,
                nonEVMReceiver: validLayerSwapData.nonEVMReceiver,
                signature: validLayerSwapData.signature,
                deadline: validLayerSwapData.deadline
            });

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(bridgeData, tamperedData);

        vm.stopPrank();
    }

    function testRevert_SignatureMismatch_WrongNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;

        bytes32 signedNonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );

        // Sign with the correct nonEVMReceiver
        LayerSwapFacet.LayerSwapData
            memory signedData = _generateValidLayerSwapData(
                keccak256("testRequestId-nonEVMTamper"),
                DEPOSITORY_RECEIVER,
                signedNonEVMReceiver,
                bridgeData,
                block.chainid
            );

        // Tamper the nonEVMReceiver after signing
        bytes32 tamperedNonEVMReceiver = bytes32(uint256(0xdeadbeef));
        LayerSwapFacet.LayerSwapData memory tamperedData = LayerSwapFacet
            .LayerSwapData({
                requestId: signedData.requestId,
                depositoryReceiver: signedData.depositoryReceiver,
                nonEVMReceiver: tamperedNonEVMReceiver,
                signature: signedData.signature,
                deadline: signedData.deadline
            });

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(bridgeData, tamperedData);

        vm.stopPrank();
    }

    // ============ EIP-712 Helper Functions ============

    function _buildDomainSeparator(
        uint256 _chainId
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI LayerSwap Facet")),
                    keccak256(bytes("1")),
                    _chainId,
                    address(layerSwapFacet)
                )
            );
    }

    function _createLayerSwapPayload(
        ILiFi.BridgeData memory _bridgeData,
        bytes32 _requestId,
        address _depositoryReceiver,
        bytes32 _nonEVMReceiver,
        uint256 _deadline
    ) internal pure returns (LayerSwapPayload memory) {
        return
            LayerSwapPayload({
                transactionId: _bridgeData.transactionId,
                minAmount: _bridgeData.minAmount,
                receiver: _bridgeData.receiver,
                requestId: _requestId,
                depositoryReceiver: _depositoryReceiver,
                nonEVMReceiver: _nonEVMReceiver,
                destinationChainId: _bridgeData.destinationChainId,
                sendingAssetId: _bridgeData.sendingAssetId,
                deadline: _deadline
            });
    }

    function _buildStructHash(
        LayerSwapPayload memory _payload
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    LAYERSWAP_PAYLOAD_TYPEHASH,
                    _payload.transactionId,
                    _payload.minAmount,
                    _payload.receiver,
                    _payload.requestId,
                    _payload.depositoryReceiver,
                    _payload.nonEVMReceiver,
                    _payload.destinationChainId,
                    _payload.sendingAssetId,
                    _payload.deadline
                )
            );
    }

    function _buildDigest(
        bytes32 _domainSeparator,
        bytes32 _structHash
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparator, _structHash)
            );
    }

    function _signDigest(
        uint256 _privateKey,
        bytes32 _digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_privateKey, _digest);
        return abi.encodePacked(r, s, v);
    }

    function _generateValidLayerSwapData(
        bytes32 _requestId,
        address _depositoryReceiver,
        bytes32 _nonEVMReceiver,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId
    ) internal view returns (LayerSwapFacet.LayerSwapData memory) {
        uint256 deadline = block.timestamp + 0.1 hours;

        LayerSwapPayload memory payload = _createLayerSwapPayload(
            _currentBridgeData,
            _requestId,
            _depositoryReceiver,
            _nonEVMReceiver,
            deadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        return
            LayerSwapFacet.LayerSwapData({
                requestId: _requestId,
                depositoryReceiver: _depositoryReceiver,
                nonEVMReceiver: _nonEVMReceiver,
                signature: signature,
                deadline: deadline
            });
    }
}
