// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, LiFiDiamond } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";
import { IOFTWrapper } from "lifi/Interfaces/IOFTWrapper.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";

interface IUniswapV2Factory {
    function createPair(
        address tokenA,
        address tokenB
    ) external returns (address pair);
}

interface IUniswapV2Router01 {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity);
}

// Stub OFTWrapperFacet Contract
contract TestOFTWrapperFacet is OFTWrapperFacet {
    /// @notice Initialize the contract.
    /// @param _oftWrapper The contract address of the OFT Wrapper on the source chain.
    constructor(IOFTWrapper _oftWrapper) OFTWrapperFacet(_oftWrapper) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OFTWrapperFacetTest is TestBaseFacet {
    // EVENTS
    event LayerZeroChainIdSet(
        uint256 indexed chainId,
        uint16 layerZeroChainId
    );
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint16 indexed layerZeroChainId,
        bytes32 receiver
    );

    // These values are for Mainnet
    address internal constant MAINNET_OFTWRAPPER =
        0x2eF002aa0AB6761B6aEa8d639DcdAa20d79b768c;
    address internal constant BTCBOFT_ADDRESS =
        0x2297aEbD383787A160DD0d9F71508148769342E3;
    address internal UNISWAP_FACTORY =
        0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    uint256 internal constant DST_CHAIN_ID = 137;
    // -----

    TestOFTWrapperFacet internal oftWrapperFacet;
    OFTWrapperFacet.OFTWrapperData internal oftWrapperData;
    ERC20 internal btcboft;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 17063500;

        initTestBase();

        btcboft = ERC20(BTCBOFT_ADDRESS);

        oftWrapperFacet = new TestOFTWrapperFacet(
            IOFTWrapper(MAINNET_OFTWRAPPER)
        );

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = oftWrapperFacet.initOFTWrapper.selector;
        functionSelectors[1] = oftWrapperFacet
            .startBridgeTokensViaOFTWrapper
            .selector;
        functionSelectors[2] = oftWrapperFacet
            .swapAndStartBridgeTokensViaOFTWrapper
            .selector;
        functionSelectors[3] = oftWrapperFacet.setOFTLayerZeroChainId.selector;
        functionSelectors[4] = oftWrapperFacet
            .estimateOFTFeesAndAmountOut
            .selector;
        functionSelectors[5] = oftWrapperFacet.addDex.selector;
        functionSelectors[6] = oftWrapperFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(oftWrapperFacet), functionSelectors);

        OFTWrapperFacet.ChainIdConfig[]
            memory chainIdConfig = new OFTWrapperFacet.ChainIdConfig[](3);
        chainIdConfig[0] = OFTWrapperFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = OFTWrapperFacet.ChainIdConfig(137, 109);
        // Test purpose
        // 108 is LayerZero Chain id for Aptos
        chainIdConfig[2] = OFTWrapperFacet.ChainIdConfig(11111, 108);

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond));
        oftWrapperFacet.initOFTWrapper(chainIdConfig);

        oftWrapperFacet.addDex(address(uniswap));
        oftWrapperFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        oftWrapperFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        oftWrapperFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );

        setFacetAddressInTestBase(address(oftWrapperFacet), "OFTWrapperFacet");

        deal(BTCBOFT_ADDRESS, USER_SENDER, 100_000e8);

        // Use this variable for BTCBOFT amount
        defaultUSDCAmount = 0.01e8;

        bridgeData.bridge = "oft";
        bridgeData.sendingAssetId = BTCBOFT_ADDRESS;
        bridgeData.minAmount = defaultUSDCAmount;

        oftWrapperData = OFTWrapperFacet.OFTWrapperData({
            tokenType: OFTWrapperFacet.TokenType.OFTFeeV2,
            proxyOFT: address(0),
            receiver: bytes32(uint256(uint160(USER_SENDER)) << 96),
            minAmount: (defaultUSDCAmount * 90) / 100,
            lzFee: 0,
            zroPaymentAddress: address(0),
            adapterParams: abi.encodePacked(uint16(1), uint256(2000000)),
            feeObj: IOFTWrapper.FeeObj({
                callerBps: 0,
                caller: address(0),
                partnerId: bytes2("")
            })
        });

        (uint256 fees, , , , ) = oftWrapperFacet.estimateOFTFeesAndAmountOut(
            bridgeData.sendingAssetId,
            bridgeData.destinationChainId,
            oftWrapperData.minAmount,
            bytes32(uint256(uint160(bridgeData.receiver))),
            oftWrapperData.tokenType,
            false,
            oftWrapperData.adapterParams,
            0
        );

        oftWrapperData.lzFee = addToMessageValue = fees;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            oftWrapperFacet.startBridgeTokensViaOFTWrapper{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, oftWrapperData);
        } else {
            oftWrapperFacet.startBridgeTokensViaOFTWrapper{
                value: addToMessageValue
            }(bridgeData, oftWrapperData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            oftWrapperFacet.swapAndStartBridgeTokensViaOFTWrapper{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, oftWrapperData);
        } else {
            oftWrapperFacet.swapAndStartBridgeTokensViaOFTWrapper{
                value: addToMessageValue
            }(bridgeData, swapData, oftWrapperData);
        }
    }

    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            BTCBOFT_ADDRESS,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(BTCBOFT_ADDRESS, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        btcboft.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_CanBridgeTokensToNonEVM()
        public
        assertBalanceChange(
            BTCBOFT_ADDRESS,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(BTCBOFT_ADDRESS, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 11111;
        bridgeData.receiver = NON_EVM_ADDRESS;

        (uint256 fees, , , , ) = oftWrapperFacet.estimateOFTFeesAndAmountOut(
            bridgeData.sendingAssetId,
            bridgeData.destinationChainId,
            oftWrapperData.minAmount,
            bytes32(uint256(uint160(bridgeData.receiver))),
            oftWrapperData.tokenType,
            false,
            oftWrapperData.adapterParams,
            0
        );

        oftWrapperData.lzFee = addToMessageValue = fees;

        // approval
        btcboft.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            108,
            oftWrapperData.receiver
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        IUniswapV2Factory(UNISWAP_FACTORY).createPair(
            ADDRESS_DAI,
            BTCBOFT_ADDRESS
        );

        dai.approve(ADDRESS_UNISWAP, type(uint256).max);
        btcboft.approve(ADDRESS_UNISWAP, type(uint256).max);
        IUniswapV2Router01(ADDRESS_UNISWAP).addLiquidity(
            ADDRESS_DAI,
            BTCBOFT_ADDRESS,
            30000e18,
            1e8,
            30000e18,
            1e8,
            USER_SENDER,
            block.timestamp + 60
        );

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        delete swapData;
        // Swap DAI -> BTCBOFT
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = BTCBOFT_ADDRESS;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: BTCBOFT_ADDRESS,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            BTCBOFT_ADDRESS,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function test_revert_SetLayerZeroChainIdAsNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        oftWrapperFacet.setOFTLayerZeroChainId(123, 456);
    }

    function test_SetLayerZeroChainIdAsOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LayerZeroChainIdSet(123, 456);
        oftWrapperFacet.setOFTLayerZeroChainId(123, 456);
    }

    function test_revert_InitializeAgain() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        OFTWrapperFacet.ChainIdConfig[]
            memory chainIdConfig = new OFTWrapperFacet.ChainIdConfig[](2);
        chainIdConfig[0] = OFTWrapperFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = OFTWrapperFacet.ChainIdConfig(137, 109);

        vm.expectRevert(AlreadyInitialized.selector);
        oftWrapperFacet.initOFTWrapper(chainIdConfig);
    }

    function test_revert_InitializeAsNonOwner() public {
        LiFiDiamond diamond2 = createDiamond();
        oftWrapperFacet = new TestOFTWrapperFacet(
            IOFTWrapper(MAINNET_OFTWRAPPER)
        );

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = oftWrapperFacet.initOFTWrapper.selector;
        functionSelectors[1] = oftWrapperFacet
            .startBridgeTokensViaOFTWrapper
            .selector;
        functionSelectors[2] = oftWrapperFacet
            .swapAndStartBridgeTokensViaOFTWrapper
            .selector;
        functionSelectors[3] = oftWrapperFacet.setOFTLayerZeroChainId.selector;
        functionSelectors[4] = oftWrapperFacet
            .estimateOFTFeesAndAmountOut
            .selector;
        functionSelectors[5] = oftWrapperFacet.addDex.selector;
        functionSelectors[6] = oftWrapperFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond2, address(oftWrapperFacet), functionSelectors);

        OFTWrapperFacet.ChainIdConfig[]
            memory chainIdConfig = new OFTWrapperFacet.ChainIdConfig[](2);
        chainIdConfig[0] = OFTWrapperFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = OFTWrapperFacet.ChainIdConfig(137, 109);

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond2));

        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);
        oftWrapperFacet.initOFTWrapper(chainIdConfig);
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0.00001e8 && amount < 0.01e8);

        logFilePath = "./test/logs/"; // works but is not really a proper file

        vm.writeLine(logFilePath, vm.toString(amount));

        // approval
        btcboft.approve(_facetTestContractAddress, amount);

        bridgeData.minAmount = amount;
        oftWrapperData.minAmount = (amount * 90) / 100;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }
}
