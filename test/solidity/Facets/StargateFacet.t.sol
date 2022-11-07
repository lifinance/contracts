// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IStargateRouter } from "lifi/Interfaces/IStargateRouter.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

// Stub CBridgeFacet Contract
contract TestStargateFacet is StargateFacet {
    /// @notice Initialize the contract.
    /// @param _router The contract address of the stargate router on the source chain.
    constructor(IStargateRouter _router) StargateFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract StargateFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xee5B5B923fFcE93A870B3104b7CA09c3db80047A;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant MAINNET_ROUTER = 0x8731d54E9D02c286767d56ac03e8037C07e01e98;
    address internal constant DAI_HOLDER = 0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    // -----


    Vm internal immutable vm = Vm(HEVM_ADDRESS); //TODO: Where is HEVM_ADDRESS coming from?
    LiFiDiamond internal diamond;
    TestStargateFacet internal stargate;
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    FeeCollector internal feeCollector;

    function fork() internal {
        //! test is executed in ETH mainnet from block 15588208
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        //! activate ETH mainnet fork
        fork();

        diamond = createDiamond();
        stargate = new TestStargateFacet(IStargateRouter(MAINNET_ROUTER));
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);
        feeCollector = new FeeCollector(address(this));

        //! Collect all function selectors of the stargate facet as well as all 
        //! selectors that were added in the TestStargateFacet contract in this file
        bytes4[] memory functionSelectors = new bytes4[](8);
        functionSelectors[0] = stargate.initStargate.selector;
        functionSelectors[1] = stargate.startBridgeTokensViaStargate.selector;
        functionSelectors[2] = stargate.swapAndStartBridgeTokensViaStargate.selector;
        functionSelectors[3] = stargate.setLayerZeroChainId.selector;
        functionSelectors[4] = stargate.setStargatePoolId.selector;
        functionSelectors[5] = stargate.quoteLayerZeroFee.selector;
        functionSelectors[6] = stargate.addDex.selector;
        functionSelectors[7] = stargate.setFunctionApprovalBySignature.selector;

        //! add the facet to the newly created diamond
        addFacet(diamond, address(stargate), functionSelectors);

        //! Create a struct that consists of a token address and a poolId 
        StargateFacet.PoolIdConfig[] memory poolIdConfig = new StargateFacet.PoolIdConfig[](2);
        //! Create a struct that consists of a chain ID and its corresponding layerZeroChainId 
        StargateFacet.ChainIdConfig[] memory chainIdConfig = new StargateFacet.ChainIdConfig[](2);
        //! fill structs with data (USDC address, poolId 1)
        poolIdConfig[0] = StargateFacet.PoolIdConfig(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 1);
        //! fill structs with data (??? address, poolId 1)
        //TODO what address is this?
        poolIdConfig[1] = StargateFacet.PoolIdConfig(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174, 1);                //! fill structs with data (??? address, poolId 1)
        //! fill structs with data for mainnet (chainId 1 == layerZeroChainId 101)
        chainIdConfig[0] = StargateFacet.ChainIdConfig(1, 101);
        //! fill structs with data polygon (chainId 137 == layerZeroChainId 109)
        chainIdConfig[1] = StargateFacet.ChainIdConfig(137, 109);

        //! take the diamond contract and convert it to TestStarGateFacet
        //! (probably to make the facet functions known
        stargate = TestStargateFacet(address(diamond));

        //! initiate stargate facet with pool and chain ID configurations
        stargate.initStargate(poolIdConfig, chainIdConfig);

        //! add dex1 = uniswap (to be able to swap tokens)
        stargate.addDex(address(uniswap));
        //! add dex2 = uniswap (to be able to collect fees during swaps)
        stargate.addDex(address(feeCollector));
        //! add dex functions to list of allowed function selectors
        // TODO Find out in which cases I have to do this step
        stargate.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        stargate.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        stargate.setFunctionApprovalBySignature(feeCollector.collectNativeFees.selector);
        stargate.setFunctionApprovalBySignature(feeCollector.collectTokenFees.selector);
    }

    function testCanGetFees() public {
        //! send following transactions from USDC holder account
        //TODO where is this variable coming from?
        vm.startPrank(USDC_HOLDER);
        StargateFacet.StargateData memory stargateData = StargateFacet.StargateData(
            2,                                  //! destination pool ID
            100,                                //! minAmountOut destination
            0,                                  //! additional gas for call at dest
            0,                                  //! estimated message fee
            payable(USDC_HOLDER),               //! refund address for extra gas at dest
            abi.encodePacked(USDC_HOLDER),      //! receiver address of tokens
            ""                                  //! data for call at dest
        );
        //! get a quote for the fee required to call swap() in the stargate router
        stargate.quoteLayerZeroFee(137, stargateData);
        //TODO confirm that this is right: we dont need to validate the return values here since its
        //TODO sufficient for us to know that the tx did not revert, otherwise the test would fail
        //TODO correct?
    }

    function testCanBridgeERC20Tokens() public {
        //! send following transactions from USDC holder account
        vm.startPrank(USDC_HOLDER);
        //! approve diamond w/ stargate facet to move 10000 USDC from holder USDC_HOLER account
        usdc.approve(address(stargate), 10_000 * 10**usdc.decimals());

        //! prepare a bridging transaction of 10 USDC (out?) without swaps or message calls
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",                 //! transactionId
            "stargate",         //! bridge
            "",                 //! integrator   
            address(0),         //! referrer
            USDC_ADDRESS,       //! sendingAssetAddress
            USDC_HOLDER,        //! receiver
            10,                 //! minAmount
            137,                //! dest chain Id
            false,              //! hasSourceSwaps
            false               //! hasDestinationCall
        );
        //TODO find out what an integrator does exactly and in which cases they receive fees
        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            1,                                  //! destination pool ID
            9,                                  //! minAmountOut destination
            0,                                  //! additional gas for call at dest
            0,                                  //! estimated message fee
            payable(USDC_HOLDER),               //! refund address for extra gas at dest
            abi.encodePacked(address(0)),       //! receiver address of tokens
            ""                                  //! data for call at dest
        );
        //TODO why is the receiverAddress the ZERO_ADDRESS? Why is this even allowed?
        
        //! get fee quote for transfer of 10 USDC from mainnet (1) to polygon (137) with 
        //! minAmountOut 9 USDC  
        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
        
        //! add estimated fee to stargate data
        data.lzFee = fees;
        
        //! initiate bridging
        stargate.startBridgeTokensViaStargate{ value: fees }(bridgeData, data);
                
        //TODO do we have to do this at the end (since each tests runs in its own EVM)?
        vm.stopPrank();
    }

    //! swap DAI to USDC on SOURCE CHAIN AND THEN BRIDGE TOKENS
    function testCanSwapAndBridgeERC20Tokens() public {
        vm.startPrank(DAI_HOLDER);
        dai.approve(address(stargate), 10_000 * 10**dai.decimals());

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountOut = 10 * 10**usdc.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(stargate),
                block.timestamp + 20 minutes
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",                 //! transactionId
            "stargate",         //! bridge
            "",                 //! integrator
            address(0),         //! referrer
            USDC_ADDRESS,       //! sendingAssetAddress
            DAI_HOLDER,         //! receiver
            9,                  //! minAmount
            137,                //! dest chain Id
            true,               //! hasSourceSwaps
            true                //! hasDestinationCall
        );            

        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            1,                                                   //! destination pool ID
            9,                                                   //! minAmountOut destination
            0,                                                   //! additional gas for call at dest
            0,                                                   //! estimated message fee
            payable(USDC_HOLDER),                                //! refund address for extra gas at dest
            abi.encodePacked(address(0)),                        //! receiver address of tokens
            abi.encode("", swapData, USDC_ADDRESS, DAI_HOLDER)   //! data for call at dest
        );                  
        //! get fee quote for transfer of 10 USDC from mainnet (1) to polygon (137) with 
        //! minAmountOut 9 USDC               
        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
                
        //! add estimated fee to stargate data
        data.lzFee = fees;

        //! initiate swap and bridging
        //TODO does the swap happen before or after the bridging?
        stargate.swapAndStartBridgeTokensViaStargate{ value: fees }(bridgeData, swapData, data);
        vm.stopPrank();
    }

    function testCanCollectFeesAndBridgeERC20Tokens() public {
        vm.startPrank(DAI_HOLDER);

        uint256 amountToBridge = 10 * 10**usdc.decimals();
        uint256 fee = 0.001 ether;
        uint256 lifiFee = 0.00015 ether;

        // Calculate USDC amount
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;
        uint256[] memory amounts = uniswap.getAmountsIn(amountToBridge, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            address(0),
            address(0),
            fee + lifiFee,
            abi.encodeWithSelector(feeCollector.collectNativeFees.selector, fee, lifiFee, address(0xb33f)),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapETHForExactTokens.selector,
                amountToBridge,
                path,
                address(stargate),
                block.timestamp
            ),
            false
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "stargate",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ADDRESS,
            receiver: DAI_HOLDER,
            minAmount: 9 * 10**usdc.decimals(),
            destinationChainId: 137,
            hasSourceSwaps: true,
            hasDestinationCall: true
        });

        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            1,
            7 * 10**usdc.decimals(),
            0,
            0,
            payable(USDC_HOLDER),
            abi.encodePacked(address(0)),
            abi.encode("", swapData, USDC_ADDRESS, DAI_HOLDER)
        );
        (uint256 fees, ) = stargate.quoteLayerZeroFee(137, data);
        data.lzFee = fees;
        stargate.swapAndStartBridgeTokensViaStargate{ value: fees + amountIn + fee + lifiFee }(
            bridgeData,
            swapData,
            data
        );
        vm.stopPrank();

        assertEq(feeCollector.getTokenBalance(address(0xb33f), address(0)), fee);
        assertEq(feeCollector.getLifiTokenBalance(address(0)), lifiFee);
        assertEq(address(stargate).balance, 0);
        assertEq(usdc.balanceOf(address(stargate)), 0);
    }
}
