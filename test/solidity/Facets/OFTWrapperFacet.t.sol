// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBase, LiFiDiamond, console, console2 } from "../utils/TestBase.sol";
import { OnlyContractOwner, AlreadyInitialized, UnAuthorized } from "src/Errors/GenericErrors.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { IOFT } from "lifi/Interfaces/IOFT.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
//import { stdStorage } from "forge-std/StdStorage.sol";
import { Test, DSTest, Vm } from "forge-std/Test.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { stdJson } from "forge-std/StdJson.sol";

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

interface ILayerZeroEndPoint {
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes calldata _payload,
        bool _payInZRO,
        bytes calldata _adapterParam
    ) external view returns (uint nativeFee, uint zroFee);
}

interface IProxy {
    function token() external view returns (address token);
}

interface IUSH {
    function getCurrentVotes(address account) external view returns (uint96);
}

interface IOhmProxyOFT {
    function sendOhm(
        uint16 dstChainId_,
        address to_,
        uint256 amount_
    ) external payable;

    function ohm() external view returns (address);

    function estimateSendFee(
        uint16 dstChainId,
        address to,
        uint256 amount,
        bytes memory adapterParams
    ) external view returns (uint256 nativeFee, uint256 zroFee);
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

    function canonicalToken() external view returns (address) {}
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
    constructor() OFTWrapperFacet() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OFTWrapperFacetTest is Test, ILiFi, DiamondTest {
    using stdJson for string;

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

    event WhitelistUpdated(OFTWrapperFacet.WhitelistConfig[] whitelistConfigs);

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    // CONTRACT ADDRESSES
    address internal constant MAINNET_OFTWRAPPER =
        0x2eF002aa0AB6761B6aEa8d639DcdAa20d79b768c;
    address internal constant BTCBOFT_ADDRESS =
        0x2297aEbD383787A160DD0d9F71508148769342E3;

    address internal constant CUSTOM_TOKEN_agEUR_ADDRESS =
        0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8; // agEUR
    address internal constant CUSTOM_TOKEN_agEUR_PROXY_ADDRESS =
        0x4Fa745FCCC04555F2AFA8874cd23961636CdF982; // agEUR Proxy
    address internal constant LZ_ENDPOINT =
        0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675;

    address internal ADDRESS_UNISWAP =
        0x10ED43C718714eb63d5aA57B78B54704E256024E; // PANCAKESWAP @ BSC

    address internal ADDRESS_USH_OFTV1_BSC =
        0x91d6d6aF7635B7b23A8CED9508117965180e2362;
    address internal ADDRESS_RDNT_OFTV2_BSC =
        0xf7DE7E8A6bd59ED41a4b5fe50278b3B7f31384dF;
    address internal ADDRESS_JOE_OFTV2WITHFEE_BSC =
        0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07;
    address internal ADDRESS_ARKEN_PROXYOFTV2_ARB =
        0x64F282290e8d0196c2929a9119250C361e025BAB;
    address internal ADDRESS_JOE_PROXYOFTV2WITHFEE_AVA =
        0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07;
    address internal ADDRESS_USH_PROXYOFTV1_ETH =
        0xA8b326Ca02650Ac968C554d6C534412e49c92BC4;
    address internal ADDRESS_OHM_CustomCode_ETH =
        0x45e563c39cDdbA8699A90078F42353A57509543a;
    address internal ADDRESS_STG_CustomCode_ETH =
        0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6;
    address internal ADDRESS_AGEUR_CustomCode_ETH =
        0x4Fa745FCCC04555F2AFA8874cd23961636CdF982;

    // USERS
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;

    // -----

    TestOFTWrapperFacet internal oftWrapperFacet;
    OFTWrapperFacet.OFTWrapperData internal oftWrapperData;
    ERC20 internal btcboft;
    bytes internal adapterParamsV1;
    bytes internal adapterParamsV2;
    //    bytes4[] internal functionSelectors;
    ILiFi.BridgeData internal bridgeData;
    LibSwap.SwapData[] internal swapData;
    UniswapV2Router02 internal uniswap;
    LiFiDiamond internal diamond;
    bytes4[] internal functionSelectors;

    // fork IDs
    uint256 forkId_ETH;
    uint256 forkId_BSC;
    uint256 forkId_ARB;
    uint256 forkId_AVA;

    function _makeDiamondWithAllFacetsPersistent(address _diamond) internal {
        IDiamondLoupe.Facet[] memory facets = IDiamondLoupe(_diamond).facets();
        vm.makePersistent(_diamond);
        for (uint i; i < facets.length; i++) {
            vm.makePersistent(facets[i].facetAddress);
        }
    }

    function setUp() public {
        // create forks and activate BSC fork (since most tests use this one)
        forkId_ETH = vm.createFork(vm.envString("ETH_NODE_URI_MAINNET"));
        forkId_ARB = vm.createFork(vm.envString("ETH_NODE_URI_ARBITRUM"));
        forkId_AVA = vm.createFork(vm.envString("ETH_NODE_URI_AVALANCHE"));
        forkId_BSC = vm.createSelectFork(vm.envString("ETH_NODE_URI_BSC"));

        // deploy & configure diamond
        diamond = createDiamond();

        oftWrapperFacet = new TestOFTWrapperFacet();

        functionSelectors = new bytes4[](19);
        functionSelectors[0] = oftWrapperFacet.initOFTWrapper.selector;
        functionSelectors[1] = oftWrapperFacet
            .startBridgeTokensViaOFTWrapperV1
            .selector;
        functionSelectors[2] = oftWrapperFacet
            .swapAndStartBridgeTokensViaOFTWrapperV1
            .selector;
        functionSelectors[3] = oftWrapperFacet
            .startBridgeTokensViaOFTWrapperV2
            .selector;
        functionSelectors[4] = oftWrapperFacet
            .swapAndStartBridgeTokensViaOFTWrapperV2
            .selector;
        functionSelectors[5] = oftWrapperFacet
            .startBridgeTokensViaOFTWrapperV2WithFee
            .selector;
        functionSelectors[6] = oftWrapperFacet
            .swapAndStartBridgeTokensViaOFTWrapperV2WithFee
            .selector;
        functionSelectors[7] = oftWrapperFacet
            .startBridgeTokensViaCustomCodeOFT
            .selector;
        functionSelectors[8] = oftWrapperFacet
            .swapAndStartBridgeTokensViaCustomCodeOFT
            .selector;
        functionSelectors[9] = oftWrapperFacet.setOFTLayerZeroChainId.selector;
        functionSelectors[10] = oftWrapperFacet.estimateOFTFees.selector;
        functionSelectors[11] = oftWrapperFacet.addDex.selector;
        functionSelectors[12] = oftWrapperFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[13] = oftWrapperFacet.batchWhitelist.selector;
        functionSelectors[14] = oftWrapperFacet
            .determineOFTBridgeSendFunction
            .selector;
        functionSelectors[15] = oftWrapperFacet
            .getOFTLayerZeroChainId
            .selector;
        functionSelectors[16] = oftWrapperFacet.isOftV1.selector;
        functionSelectors[17] = oftWrapperFacet.isOftV2.selector;
        functionSelectors[18] = oftWrapperFacet.isOftV2WithFee.selector;

        addFacet(diamond, address(oftWrapperFacet), functionSelectors);

        // create mappings for chainId <> layerZeroChainId
        OFTWrapperFacet.ChainIdConfig[]
            memory chainIdConfig = new OFTWrapperFacet.ChainIdConfig[](6);
        chainIdConfig[0] = OFTWrapperFacet.ChainIdConfig(1, 101); // Ethereum
        chainIdConfig[1] = OFTWrapperFacet.ChainIdConfig(137, 109); // Polygon
        chainIdConfig[2] = OFTWrapperFacet.ChainIdConfig(11111, 108); // Aptos
        chainIdConfig[3] = OFTWrapperFacet.ChainIdConfig(42161, 110); // Arbitrum
        chainIdConfig[4] = OFTWrapperFacet.ChainIdConfig(56, 102); // BSC
        chainIdConfig[5] = OFTWrapperFacet.ChainIdConfig(42220, 125); // CELO

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond));

        // create empty whitelistConfig
        OFTWrapperFacet.WhitelistConfig[] memory whitelistConfig;

        // initialize facet with chainId mappings and whitelistConfig
        oftWrapperFacet.initOFTWrapper(chainIdConfig, whitelistConfig);

        // add dex and signatures for swaps
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
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

        // prepare adapterParams
        adapterParamsV1 = abi.encodePacked(uint16(2), uint256(2000000));
        adapterParamsV2 = abi.encodePacked(
            uint16(1),
            uint256(2000000),
            uint256(0),
            address(0)
        );

        btcboft = ERC20(BTCBOFT_ADDRESS);
        deal(BTCBOFT_ADDRESS, USER_SENDER, 100_000e8);

        // Use this variable for BTCBOFT amount
        //        defaultUSDCAmount = 0.01e8;

        // prepare bridgeData
        bridgeData.bridge = "oft";
        bridgeData.sendingAssetId = BTCBOFT_ADDRESS;
        bridgeData.destinationChainId = 42161; // Arbitrum chainId
        bridgeData.minAmount = 10e18;

        // prepare oftWrapperData
        oftWrapperData = OFTWrapperFacet.OFTWrapperData({
            proxyOftAddress: address(0),
            receiver: bytes32(uint256(uint160(USER_SENDER)) << 96),
            minAmount: (bridgeData.minAmount * 90) / 100,
            lzFee: 0,
            zroPaymentAddress: address(0),
            adapterParams: abi.encodePacked(uint16(1), uint256(2000000)),
            feeObj: IOFT.FeeObj({
                callerBps: 0,
                caller: address(0),
                partnerId: bytes2("")
            }),
            customCode_sendTokensCallData: "",
            customCode_approveTo: address(0)
        });

        // add labels for better logs
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
        vm.label(0x4Fa745FCCC04555F2AFA8874cd23961636CdF982, "agEUR OFT");
        vm.label(0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6, "STG OFT");
        vm.label(0x45e563c39cDdbA8699A90078F42353A57509543a, "OHM OFT");
        vm.label(0xA8b326Ca02650Ac968C554d6C534412e49c92BC4, "USH PROXYOFTV1");
        vm.label(
            0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07,
            "JOE PROXYOFTV2WITHFEE"
        );
        vm.label(
            0x64F282290e8d0196c2929a9119250C361e025BAB,
            "ARKEN PRXYOFTV2"
        );
        vm.label(
            0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07,
            "JOE OFTV2WITHFEE"
        );
        vm.label(0xf7DE7E8A6bd59ED41a4b5fe50278b3B7f31384dF, "RDNT OFTV2");
        vm.label(0x91d6d6aF7635B7b23A8CED9508117965180e2362, "USH PROXYOFTV1");
        vm.label(0x10ED43C718714eb63d5aA57B78B54704E256024E, "UNISWAP");

        _makeDiamondWithAllFacetsPersistent(address(diamond));
    }

    // TODO: token has some stupid custom behaviour, need to find another token for testing
    // bridges USH token via OftWrapper using USH Proxy from ETH to ARB
    function canBridgeOftV1Proxy() public {
        //    function test_canBridgeOftV1Proxy() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        // get actual token
        address testTokenProxy = ADDRESS_USH_PROXYOFTV1_ETH; // USHProxyOFT
        address testTokenUSH = IProxy(testTokenProxy).token();

        // add labels for better logs
        vm.label(testTokenProxy, "USHProxyOFT");
        vm.label(testTokenUSH, "USHToken");

        // deal tokens to user
        deal(testTokenUSH, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // Arbitrum chainId
        bridgeData.sendingAssetId = testTokenUSH;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testTokenProxy,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = testTokenProxy;
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testTokenUSH).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV1{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_CanBridgeWhitelistedCustomToken_STG() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        // add labels for better logs
        vm.label(0x4Fa745FCCC04555F2AFA8874cd23961636CdF982, "STG_TOKEN");
        vm.label(ADDRESS_STG_CustomCode_ETH, "STG_PROXY");

        address CUSTOM_TOKEN_STG_ADDRESS = ADDRESS_STG_CustomCode_ETH;

        uint16 lzChainIdPolygon = 109;

        // deal tokens to user
        deal(CUSTOM_TOKEN_STG_ADDRESS, USER_SENDER, 100_000e18);
        deal(USER_SENDER, 1000e18); // native

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
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.sendingAssetId = CUSTOM_TOKEN_STG_ADDRESS; // STG Token on ETH
        bridgeData.minAmount = 100e18;

        // estimate sendFee via lzEndpoint (since STG token returns wrong value)
        ILayerZeroEndPoint lzEndPoint = ILayerZeroEndPoint(LZ_ENDPOINT);

        // borrowed from here: https://github.com/LayerZero-Labs/solidity-examples/blob/b527c3aee6749e69899f06297bbe163fba0c251a/contracts/token/oft/OFTCore.sol#L25
        // mock the payload for sendFrom()
        uint16 PT_SEND = 0; // packet type from OFTCore
        bytes memory payload = abi.encode(
            PT_SEND,
            abi.encode(USER_RECEIVER),
            bridgeData.minAmount
        );

        (uint256 nativeFee, ) = lzEndPoint.estimateFees(
            lzChainIdPolygon,
            address(this),
            payload,
            false, // useZro
            adapterParamsV1
        );

        // TODO: remove once V2 is implemented in backend

        //        STGContract stgToken = STGContract(CUSTOM_TOKEN_STG_ADDRESS);
        //        (uint256 nativeFee, ) = stgToken.estimateSendTokensFee(
        //            lzChainIdPolygon, // 109
        //            false,
        //            adapterParamsV1 // 0x000100000000000000000000000000000000000000000000000000000000001e8480
        //        );

        // late on the test calls =>  TreasuryV2::getFees(false, 646376348505924, 4747807653363)
        // from which I can derive that these fee values have been determined in the UltraLightNodeV2.send() function:
        //      relayerFee: 646376348505924
        //      oracleFee :   4747807653363
        //           total: 651124156159287 (is less than the native fee estimated by estimateSendTokensFee function)

        // get oracle fee
        //uint256 oracleFee = LayerZeroOracleV2(oracleAddress).assignJob(_dstChainId, _uaConfig.outboundProofType, _uaConfig.outboundBlockConfirmations, _ua);

        vm.startPrank(USER_SENDER);

        // prepare oftWrapperData
        oftWrapperData.lzFee = nativeFee;
        oftWrapperData.proxyOftAddress = CUSTOM_TOKEN_STG_ADDRESS; // STG on ETH
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            STGContract.sendTokens.selector,
            lzChainIdPolygon, // 109
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount, // 100e18
            address(0),
            adapterParamsV1 //  // 0x000100000000000000000000000000000000000000000000000000000000001e8480
        );
        oftWrapperData.customCode_approveTo = CUSTOM_TOKEN_STG_ADDRESS;

        // approval
        ERC20 stgTokenERC20 = ERC20(CUSTOM_TOKEN_STG_ADDRESS);
        stgTokenERC20.approve(address(oftWrapperFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaCustomCodeOFT{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    // WORKING TESTS

    function _addContractToWhitelist(address contractAddress) internal {
        // whitelist token contract in facet
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            contractAddress,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);
    }

    function test_canBridgeOftV1() public {
        // add labels for better logs
        vm.label(ADDRESS_USH_OFTV1_BSC, "USH_PROXY");

        address testToken = ADDRESS_USH_OFTV1_BSC; // USH

        // add contract to whitelist
        _addContractToWhitelist(testToken);

        // deal tokens to user
        deal(testToken, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 1; // mainnet
        bridgeData.sendingAssetId = testToken;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testToken,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = address(0);
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testToken).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV1{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_canBridgeOftV2() public {
        // get actual token
        address testToken = ADDRESS_RDNT_OFTV2_BSC;

        // add labels for better logs
        vm.label(testToken, "RDNT Token");

        // deal tokens to user
        deal(testToken, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        // add contract to whitelist
        _addContractToWhitelist(testToken);

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // ARB chainId
        bridgeData.sendingAssetId = testToken;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testToken,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = address(0);
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testToken).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV2{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_canBridgeOftV2Proxy() public {
        // activate ARB fork
        vm.selectFork(forkId_ARB);

        // get actual token
        address testTokenProxy = ADDRESS_ARKEN_PROXYOFTV2_ARB; // ArkenProxyOFT
        address testTokenARKEN = IProxy(testTokenProxy).token();

        // add labels for better logs
        vm.label(testTokenProxy, "ArkenProxyOFT");
        vm.label(testTokenARKEN, "ArkenToken");

        // deal tokens to user
        deal(testTokenARKEN, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        // add contract to whitelist
        _addContractToWhitelist(testTokenProxy);

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 56; // BSC chainId
        bridgeData.sendingAssetId = testTokenARKEN;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testTokenProxy,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = testTokenProxy;
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testTokenARKEN).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV2{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_canBridgeOftV2WithFee() public {
        // get actual token
        address testToken = ADDRESS_JOE_OFTV2WITHFEE_BSC; // JOE

        // add labels for better logs
        vm.label(testToken, "JOE Token");

        // deal tokens to user
        deal(testToken, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        // add contract to whitelist
        _addContractToWhitelist(testToken);

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // ARB chainId
        bridgeData.sendingAssetId = testToken;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testToken,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = address(0);
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testToken).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV2WithFee{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_canBridgeOftV2WithFeeProxy() public {
        // activate AVA fork
        vm.selectFork(forkId_AVA);

        // get actual token
        address testTokenProxy = ADDRESS_JOE_PROXYOFTV2WITHFEE_AVA; // JoeProxyOFT
        address testToken = IProxy(testTokenProxy).token();

        // add labels for better logs
        vm.label(testToken, "JoeToken");

        // deal tokens to user
        deal(testToken, USER_SENDER, 10e18);
        deal(USER_SENDER, 1000e18); // native

        // add contract to whitelist
        _addContractToWhitelist(testTokenProxy);

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // ARB chainId
        bridgeData.sendingAssetId = testToken;
        bridgeData.minAmount = 10e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate fee
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                testTokenProxy,
                bridgeData.destinationChainId,
                bridgeData.minAmount,
                bytes32(uint256(uint160(USER_SENDER)) << 96),
                false,
                oftWrapperData.adapterParams,
                ""
            );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = testTokenProxy;
        oftWrapperData.customCode_approveTo = address(0);
        oftWrapperData.customCode_sendTokensCallData = "";
        oftWrapperData.lzFee = feeEstimate.nativeFee;

        // approval
        ERC20(testToken).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaOFTWrapperV2WithFee{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
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

    function test_getOFTLayerZeroChainId() public {
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(1), 101);
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(137), 109);
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(11111), 108);
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(42161), 110);
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(56), 102);
        assertEq(oftWrapperFacet.getOFTLayerZeroChainId(42220), 125);
    }

    function test_revert_BatchWhitelistAsNonOwner() public {
        vm.startPrank(USER_SENDER);

        // prepare whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            ADDRESS_UNISWAP,
            true
        );

        vm.expectRevert(UnAuthorized.selector);
        oftWrapperFacet.batchWhitelist(whitelistConfig);
    }

    function test_BatchWhitelistAsOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // prepare whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            ADDRESS_UNISWAP,
            true
        );

        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit WhitelistUpdated(whitelistConfig);
        oftWrapperFacet.batchWhitelist(whitelistConfig);
    }

    function test_revert_InitializeAsNonOwner() public {
        LiFiDiamond diamond2 = createDiamond();
        oftWrapperFacet = new TestOFTWrapperFacet();

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

    function test_InitializeAsOwnerWithActualData() public {
        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/config/oftwrapper.json");
        string memory json = vm.readFile(path);

        LiFiDiamond diamond2 = createDiamond();
        oftWrapperFacet = new TestOFTWrapperFacet();

        addFacet(diamond2, address(oftWrapperFacet), functionSelectors);

        // create chainId mapping from config file
        bytes memory rawChains = json.parseRaw(".chains");
        OFTWrapperFacet.ChainIdConfig[] memory chainIdConfig = abi.decode(
            rawChains,
            (OFTWrapperFacet.ChainIdConfig[])
        );

        // create whitelisted contracts parameter from config file
        bytes memory rawContracts = json.parseRaw(
            string.concat(".whitelistedOftBridgeContracts", ".", "mainnet")
        );
        console.log("rawContracts.length: ", rawContracts.length);
        address[] memory whitelistedContracts = abi.decode(
            rawContracts,
            (address[])
        );

        console.log(
            "whitelistedContracts.length: ",
            whitelistedContracts.length
        );
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](
                whitelistedContracts.length
            );
        for (uint i; i < whitelistedContracts.length; i++) {
            whitelistConfig[i] = OFTWrapperFacet.WhitelistConfig(
                whitelistedContracts[i],
                true
            );
        }

        oftWrapperFacet = TestOFTWrapperFacet(address(diamond2));

        oftWrapperFacet.initOFTWrapper(chainIdConfig, whitelistConfig);
    }

    function test_CanBridgeWhitelistedCustomToken_OHM() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        // get actual token
        address testTokenProxy = ADDRESS_OHM_CustomCode_ETH;
        address testToken = IOhmProxyOFT(testTokenProxy).ohm();

        // add labels for better logs
        vm.label(testTokenProxy, "OHM_PROXY");
        vm.label(testToken, "OHM_TOKEN");

        // deal tokens to user
        deal(testToken, USER_SENDER, 1000e18);
        deal(USER_SENDER, 1000e18); // native

        // add custom token (OHM) to whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            testTokenProxy,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);

        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.destinationChainId = 42161; // Arbitrum chainId
        bridgeData.sendingAssetId = testToken; // OHM Token on ETH
        bridgeData.receiver = USER_RECEIVER;
        bridgeData.minAmount = 10e14;

        // estimate fee
        (uint256 nativeFee, ) = IOhmProxyOFT(testTokenProxy).estimateSendFee(
            oftWrapperFacet.getOFTLayerZeroChainId(
                bridgeData.destinationChainId
            ),
            USER_SENDER,
            bridgeData.minAmount,
            oftWrapperData.adapterParams
        );

        // prepare oftWrapperData
        oftWrapperData.proxyOftAddress = testTokenProxy; // OHM Proxy on ETH
        uint16 lzChainIdArbitrum = 110;
        oftWrapperData
            .customCode_approveTo = 0xa90bFe53217da78D900749eb6Ef513ee5b6a491e; // Olympus Minter contract
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            IOhmProxyOFT.sendOhm.selector,
            lzChainIdArbitrum,
            USER_RECEIVER,
            bridgeData.minAmount
        );
        oftWrapperData.lzFee = nativeFee;

        // approval
        ERC20(testToken).approve(
            address(oftWrapperFacet),
            bridgeData.minAmount
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaCustomCodeOFT{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_CanBridgeWhitelistedCustomToken_agEUR() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        // get actual token
        address testTokenProxy = ADDRESS_AGEUR_CustomCode_ETH; // agEURProxy
        address testToken = AgEurProxyContract(testTokenProxy)
            .canonicalToken();

        // add labels for better logs
        vm.label(testTokenProxy, "agEUR_PROXY");
        vm.label(
            0xd735611AE930D2fd3788AAbf7696e6D8f664d15e,
            "agEUR_PROXY_IMPL"
        );
        vm.label(testToken, "agEUR_TOKEN");

        uint16 lzChainIdArbitrum = 110;

        // deal tokens to user
        deal(testToken, USER_SENDER, 100_000e18);
        deal(USER_SENDER, 1000e18); // native

        // add custom token (agEUR) to whitelist
        OFTWrapperFacet.WhitelistConfig[]
            memory whitelistConfig = new OFTWrapperFacet.WhitelistConfig[](1);
        whitelistConfig[0] = OFTWrapperFacet.WhitelistConfig(
            CUSTOM_TOKEN_agEUR_PROXY_ADDRESS,
            true
        );
        oftWrapperFacet.batchWhitelist(whitelistConfig);

        // update bridgeData
        bridgeData.destinationChainId = 42220; // CELO chainId
        bridgeData.sendingAssetId = testToken; // agEUR Token on ETH
        bridgeData.minAmount = 100e18;
        bridgeData.receiver = USER_RECEIVER;

        // estimate sendFee
        AgEurProxyContract agEurProxy = AgEurProxyContract(testTokenProxy);
        (uint256 nativeFee, ) = agEurProxy.estimateSendFee(
            lzChainIdArbitrum,
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount,
            false,
            adapterParamsV1
        );

        vm.startPrank(USER_SENDER);

        // prepare oftWrapperData
        oftWrapperData.lzFee = nativeFee;
        oftWrapperData.proxyOftAddress = testTokenProxy; // agEUR Proxy on ETH
        oftWrapperData.customCode_sendTokensCallData = abi.encodeWithSelector(
            AgEurProxyContract.send.selector,
            lzChainIdArbitrum,
            abi.encodePacked(bytes20(USER_SENDER)),
            bridgeData.minAmount,
            USER_SENDER,
            address(0),
            adapterParamsV1
        );
        oftWrapperData.customCode_approveTo = testTokenProxy;

        // approval
        ERC20 agEurToken = ERC20(testToken);
        agEurToken.approve(address(oftWrapperFacet), bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(oftWrapperFacet));
        emit LiFiTransferStarted(bridgeData);

        oftWrapperFacet.startBridgeTokensViaCustomCodeOFT{
            value: oftWrapperData.lzFee
        }(bridgeData, oftWrapperData);

        vm.stopPrank();
    }

    function test_determineOFTBridgeSendFunction_V1() public {
        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV1.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_USH_OFTV1_BSC,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaOFTWrapperV1.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_USH_OFTV1_BSC,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_V1Proxy() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV1.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_USH_PROXYOFTV1_ETH,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaOFTWrapperV1.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_USH_PROXYOFTV1_ETH,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_V2() public {
        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV2.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_RDNT_OFTV2_BSC,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaOFTWrapperV2.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_RDNT_OFTV2_BSC,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_V2Proxy() public {
        // activate ARB fork
        vm.selectFork(forkId_ARB);

        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV2.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_ARKEN_PROXYOFTV2_ARB,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaOFTWrapperV2.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_ARKEN_PROXYOFTV2_ARB,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_V2WithFee() public {
        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV2WithFee.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_JOE_OFTV2WITHFEE_BSC,
                false
            )
        );
        assertEq(
            OFTWrapperFacet
                .swapAndStartBridgeTokensViaOFTWrapperV2WithFee
                .selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_JOE_OFTV2WITHFEE_BSC,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_V2WithFeeProxy() public {
        // activate AVA fork
        vm.selectFork(forkId_AVA);

        assertEq(
            OFTWrapperFacet.startBridgeTokensViaOFTWrapperV2WithFee.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_JOE_PROXYOFTV2WITHFEE_AVA,
                false
            )
        );
        assertEq(
            OFTWrapperFacet
                .swapAndStartBridgeTokensViaOFTWrapperV2WithFee
                .selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_JOE_PROXYOFTV2WITHFEE_AVA,
                true
            )
        );
    }

    function test_determineOFTBridgeSendFunction_CustomCode() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        assertEq(
            OFTWrapperFacet.startBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_OHM_CustomCode_ETH,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_OHM_CustomCode_ETH,
                true
            )
        );
        assertEq(
            OFTWrapperFacet.startBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_STG_CustomCode_ETH,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_STG_CustomCode_ETH,
                true
            )
        );
        assertEq(
            OFTWrapperFacet.startBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_AGEUR_CustomCode_ETH,
                false
            )
        );
        assertEq(
            OFTWrapperFacet.swapAndStartBridgeTokensViaCustomCodeOFT.selector,
            oftWrapperFacet.determineOFTBridgeSendFunction(
                ADDRESS_AGEUR_CustomCode_ETH,
                true
            )
        );
    }

    function test_estimateOFTFeesAnd_V1() public {
        // activate BSC fork
        vm.selectFork(forkId_BSC);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(31470699);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_USH_OFTV1_BSC,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 4085019515262038, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_V1Proxy() public {
        // activate BSC fork
        vm.selectFork(forkId_BSC);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(31470699);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_USH_OFTV1_BSC,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 4085019515262038, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_V2() public {
        // activate BSC fork
        vm.selectFork(forkId_BSC);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(31470699);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_RDNT_OFTV2_BSC,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 4035021132398375, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_V2Proxy() public {
        // activate Avalanche fork
        vm.selectFork(forkId_ARB);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(128176701);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_ARKEN_PROXYOFTV2_ARB,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 532625681436064, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_V2WithFee() public {
        // set active fork to given block (to ensure predictable results
        vm.rollFork(31470148);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_JOE_OFTV2WITHFEE_BSC,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 6269688761801826, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_V2WithFeeProxy() public {
        // activate Avalanche fork
        vm.selectFork(forkId_AVA);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(34789856);

        uint256 testAmount = 123456789;

        // get fee estimate from our facet
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_JOE_PROXYOFTV2WITHFEE_AVA,
                bridgeData.destinationChainId,
                testAmount,
                bytes32(uint256(uint160(USER_RECEIVER)) << 96),
                false,
                adapterParamsV1,
                ""
            );

        assertApproxEqRel(feeEstimate.nativeFee, 136838283700560541, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }

    function test_estimateOFTFeesAnd_CustomCode() public {
        // activate ETH fork
        vm.selectFork(forkId_ETH);

        // set active fork to given block (to ensure predictable results
        vm.rollFork(18068415);

        uint16 layerZeroChainId = oftWrapperFacet.getOFTLayerZeroChainId(
            bridgeData.destinationChainId
        );

        // prepare callData for customCodeOFT fee estimate
        bytes memory customCodeOftCallData = abi.encodeWithSignature(
            "estimateSendTokensFee(uint16,bool,bytes)",
            layerZeroChainId,
            false,
            adapterParamsV1
        );

        uint256 testAmount = 123456789;

        // get fee estimate with pre-computed calldata (no other parameters required)
        OFTWrapperFacet.OftFeeEstimate memory feeEstimate = oftWrapperFacet
            .estimateOFTFees(
                ADDRESS_STG_CustomCode_ETH,
                0,
                testAmount,
                bytes32(uint256(uint160(0)) << 96),
                false,
                "",
                customCodeOftCallData
            );

        assertApproxEqRel(feeEstimate.nativeFee, 888436917822948, 1e17); // value can vary by 10%
        assertEq(feeEstimate.zroFee, 0);
    }
}
