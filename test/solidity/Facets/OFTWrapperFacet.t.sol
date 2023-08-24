// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, LiFiDiamond, console } from "../utils/TestBaseFacet.sol";
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

interface ILayerZeroOracleV2 {
    function assignJob(
        uint16 _dstChainId,
        uint16 outboundProofType,
        uint64 outboundBlockConfirmations,
        address _ua
    ) external returns (uint256);
}

contract OhmProxyContract {
    function sendOhm(
        uint16 dstChainId_,
        address to_,
        uint256 amount_
    ) external payable {}
}

contract AgEurProxyContract {
    function estimateSendFee(
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint256 _amount,
        bool _useZro,
        bytes calldata _adapterParams
    ) external view returns (uint256 nativeFee, uint256 zroFee) {}

    function send(
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint256 _amount,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams
    ) external payable {}
}

contract STGContract {
    function estimateSendTokensFee(
        uint16 _dstChainId,
        bool _useZro,
        bytes calldata txParameters
    ) external view returns (uint256 nativeFee, uint256 zroFee) {}

    function sendTokens(
        uint16 _dstChainId,
        bytes calldata _to,
        uint256 _qty,
        address zroPaymentAddress,
        bytes calldata adapterParam
    ) public payable {}
}

contract UltraLightNodeV2Contract {
    struct ApplicationConfiguration {
        uint16 inboundProofLibraryVersion;
        uint64 inboundBlockConfirmations;
        address relayer;
        uint16 outboundProofType;
        uint64 outboundBlockConfirmations;
        address oracle;
    }

    function getAppConfig(
        uint16 _remoteChainId,
        address _ua
    ) external view returns (ApplicationConfiguration memory) {}
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
    address internal constant CUSTOM_TOKEN_OHM_ADDRESS =
        0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5; // OHM on ETH
    address internal constant CUSTOM_TOKEN_OHM_PROXY_ADDRESS =
        0x45e563c39cDdbA8699A90078F42353A57509543a; // OHM Proxy on ETH
    address internal constant CUSTOM_TOKEN_agEUR_ADDRESS =
        0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8; // agEUR on ETH
    address internal constant CUSTOM_TOKEN_agEUR_PROXY_ADDRESS =
        0x4Fa745FCCC04555F2AFA8874cd23961636CdF982; // agEUR Proxy on ETH
    address internal UNISWAP_FACTORY =
        0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    uint256 internal constant DST_CHAIN_ID = 137;
    // -----

    TestOFTWrapperFacet internal oftWrapperFacet;
    OFTWrapperFacet.OFTWrapperData internal oftWrapperData;
    ERC20 internal btcboft;
    ERC20 internal customTokenOHM;
    bytes internal adapterParamsV1;
    bytes internal adapterParamsV2;

    function setUp() public {
        // set custom block number for forking
        //        customBlockNumberForForking = 17063500;
        customBlockNumberForForking = 17977594;
        adapterParamsV1 = abi.encodePacked(uint16(1), uint256(2000000));
        adapterParamsV2 = abi.encodePacked(
            uint16(1),
            uint256(2000000),
            uint256(0),
            address(0)
        );

        initTestBase();

        btcboft = ERC20(BTCBOFT_ADDRESS);
        customTokenOHM = ERC20(CUSTOM_TOKEN_OHM_ADDRESS);

        oftWrapperFacet = new TestOFTWrapperFacet(
            IOFTWrapper(MAINNET_OFTWRAPPER)
        );

        bytes4[] memory functionSelectors = new bytes4[](8);
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
        functionSelectors[7] = oftWrapperFacet.batchWhitelist.selector;

        addFacet(diamond, address(oftWrapperFacet), functionSelectors);

        OFTWrapperFacet.ChainIdConfig[]
            memory chainIdConfig = new OFTWrapperFacet.ChainIdConfig[](4);
        chainIdConfig[0] = OFTWrapperFacet.ChainIdConfig(1, 101);
        chainIdConfig[1] = OFTWrapperFacet.ChainIdConfig(137, 109);
        // Test purpose
        // 108 is LayerZero Chain id for Aptos
        chainIdConfig[2] = OFTWrapperFacet.ChainIdConfig(11111, 108);
        chainIdConfig[3] = OFTWrapperFacet.ChainIdConfig(42161, 110);

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond));

        // create empty whitelistConfig
        OFTWrapperFacet.WhitelistConfig[] memory whitelistConfig;

        oftWrapperFacet.initOFTWrapper(chainIdConfig, whitelistConfig);

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
            }),
            customCode_sendTokensCallData: "",
            customCode_approveTo: address(0)
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

        // add labels for better logs
        vm.label(0x4Fa745FCCC04555F2AFA8874cd23961636CdF982, "agEUR_PROXY");
        vm.label(
            0xd735611AE930D2fd3788AAbf7696e6D8f664d15e,
            "agEUR_PROXY_IMPL"
        );
        vm.label(0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8, "agEUR_TOKEN");
        vm.label(0x45e563c39cDdbA8699A90078F42353A57509543a, "OHM_PROXY");
        vm.label(0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5, "OHM_TOKEN");
        vm.label(0x4Fa745FCCC04555F2AFA8874cd23961636CdF982, "STG_TOKEN");
        vm.label(0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675, "lzEndpoint");
        vm.label(0x3773E1E9Deb273fCdf9f80bc88bB387B1e6Ce34d, "TreasuryV2");
        vm.label(
            0x4D73AdB72bC3DD368966edD0f0b2148401A178E2,
            "UltraLightNodeV2"
        );
        vm.label(
            0x5a54fe5234E811466D5366846283323c954310B2,
            "LayerZeroOracleV2"
        );
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

        // create empty whitelistConfig
        OFTWrapperFacet.WhitelistConfig[] memory whitelistConfig;

        vm.expectRevert(AlreadyInitialized.selector);
        oftWrapperFacet.initOFTWrapper(chainIdConfig, whitelistConfig);
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

        // create empty whitelistConfig
        OFTWrapperFacet.WhitelistConfig[] memory whitelistConfig;

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond2));

        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);
        oftWrapperFacet.initOFTWrapper(chainIdConfig, whitelistConfig);
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

    // test with OHM token - not able to get it passing
    function test_CanBridgeWhitelistedCustomToken_OHM() public {
        // deal tokens to user
        deal(CUSTOM_TOKEN_OHM_ADDRESS, USER_SENDER, 100_000e8);

        // add custom token (OHM) to whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            CUSTOM_TOKEN_OHM_PROXY_ADDRESS,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);

        vm.startPrank(USER_SENDER);

        // prepare oftWrapperData
        oftWrapperData.proxyOFT = CUSTOM_TOKEN_OHM_PROXY_ADDRESS; // OHM Proxy on ETH
        uint16 lzChainIdArbitrum = 110;
        oftWrapperData
            .customCode_approveTo = 0xa90bFe53217da78D900749eb6Ef513ee5b6a491e; // Olympus Minter contract
        oftWrapperData.tokenType = OFTWrapperFacet.TokenType.CustomCodeOFT;
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            OhmProxyContract.sendOhm.selector,
            lzChainIdArbitrum,
            USER_SENDER,
            bridgeData.minAmount
        );
        oftWrapperData.lzFee = addToMessageValue = 1000e12;

        // update bridgeData
        bridgeData.destinationChainId = 42161; // Arbitrum chainId
        bridgeData.sendingAssetId = CUSTOM_TOKEN_OHM_ADDRESS; // OHM Token on ETH

        // approval
        customTokenOHM.approve(
            _facetTestContractAddress,
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // test with agEUR token
    function test_CanBridgeWhitelistedCustomToken_agEUR() public {
        uint16 lzChainIdArbitrum = 110;

        // deal tokens to user
        deal(CUSTOM_TOKEN_agEUR_ADDRESS, USER_SENDER, 100_000e18);

        // add custom token (agEUR) to whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            CUSTOM_TOKEN_agEUR_PROXY_ADDRESS,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // Arbitrum chainId
        bridgeData.sendingAssetId = CUSTOM_TOKEN_agEUR_ADDRESS; // agEUR Token on ETH
        bridgeData.minAmount = 100e18;

        // estimate sendFee
        AgEurProxyContract agEurProxy = AgEurProxyContract(
            CUSTOM_TOKEN_agEUR_PROXY_ADDRESS
        );
        (uint256 nativeFee, ) = agEurProxy.estimateSendFee(
            lzChainIdArbitrum,
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount,
            false,
            oftWrapperData.adapterParams
        );

        vm.startPrank(USER_SENDER);

        // prepare oftWrapperData
        oftWrapperData.lzFee = addToMessageValue = nativeFee;
        oftWrapperData.proxyOFT = CUSTOM_TOKEN_agEUR_PROXY_ADDRESS; // agEUR Proxy on ETH
        oftWrapperData.tokenType = OFTWrapperFacet.TokenType.CustomCodeOFT;
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            AgEurProxyContract.send.selector,
            lzChainIdArbitrum,
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount,
            USER_SENDER,
            address(0),
            adapterParamsV1
        );
        oftWrapperData.customCode_approveTo = CUSTOM_TOKEN_agEUR_PROXY_ADDRESS;

        // approval
        ERC20 agEurToken = ERC20(CUSTOM_TOKEN_agEUR_ADDRESS);
        agEurToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // test with STG token
    // TODO: this test needs to be fixed (nativeFee estimations returned by token contract are insufficient)
    // waiting for response of lz team
    function test_CanBridgeWhitelistedCustomToken_STG() public {
        address CUSTOM_TOKEN_STG_ADDRESS = 0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6;

        uint16 lzChainIdPolygon = 109;

        // deal tokens to user
        deal(CUSTOM_TOKEN_STG_ADDRESS, USER_SENDER, 100_000e18);

        // add custom token (agEUR) to whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            CUSTOM_TOKEN_STG_ADDRESS,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);

        // update bridgeData
        bridgeData.destinationChainId = 137; // polygon chainId
        bridgeData.sendingAssetId = CUSTOM_TOKEN_STG_ADDRESS; // STG Token on ETH
        bridgeData.minAmount = 100e18;

        // estimate sendFee
        STGContract stgToken = STGContract(CUSTOM_TOKEN_STG_ADDRESS);
        (uint256 nativeFee, ) = stgToken.estimateSendTokensFee(
            lzChainIdPolygon, // 109
            false,
            adapterParamsV1 // 0x000100000000000000000000000000000000000000000000000000000000001e8480
        );

        console.log("nativeFee: ", nativeFee); // result (example): 651029113874149
        // late on the test calls =>  TreasuryV2::getFees(false, 646376348505924, 4747807653363)
        // from which I can derive that these fee values have been determined in the UltraLightNodeV2.send() function:
        //      relayerFee: 646376348505924
        //      oracleFee :   4747807653363
        //           total: 651124156159287 (is less than the native fee estimated by estimateSendTokensFee function)

        // get oracle fee
        //uint256 oracleFee = LayerZeroOracleV2(oracleAddress).assignJob(_dstChainId, _uaConfig.outboundProofType, _uaConfig.outboundBlockConfirmations, _ua);

        vm.startPrank(USER_SENDER);

        // prepare oftWrapperData
        //        oftWrapperData.lzFee = addToMessageValue = nativeFee + 1 ether; // this works //TODO remove
        oftWrapperData.lzFee = addToMessageValue = nativeFee; // this does not work
        oftWrapperData.proxyOFT = CUSTOM_TOKEN_STG_ADDRESS; // STG on ETH
        oftWrapperData.tokenType = OFTWrapperFacet.TokenType.CustomCodeOFT;
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            STGContract.sendTokens.selector,
            lzChainIdPolygon,
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount,
            address(0),
            adapterParamsV1
        );
        oftWrapperData.customCode_approveTo = CUSTOM_TOKEN_STG_ADDRESS;

        // approval
        ERC20 stgTokenERC20 = ERC20(CUSTOM_TOKEN_STG_ADDRESS);
        stgTokenERC20.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }
}
