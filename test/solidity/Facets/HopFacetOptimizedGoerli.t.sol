// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibAllowList, TestBaseFacet, console, ERC20, LibSwap } from "../utils/TestBaseFacet.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

// Stub HopFacetOptimized Contract
contract TestHopFacet is HopFacetOptimized {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetOptimizedGoerliTest is TestBaseFacet {
    // These values are for Goerli
    address internal constant DAI_BRIDGE =
        0xAa1603822b43e592e33b58d34B4423E1bcD8b4dC; // Wrapped DAI Bridge
    // 0x2d6fd82C7f531328BCaCA96EF985325C0894dB62 // DAI Bridge
    address internal constant USDC_BRIDGE =
        0x53B94FAf104A484ff4E7c66bFe311fd48ce3D887; // Wrapped USDT Bridge
    // 0x4A26dE45BD65ef6e5535846b92a8575E0A0e5CEd // USDT Bridge
    address internal constant NATIVE_BRIDGE =
        0xd9e10C6b1bd26dE4E2749ce8aFe8Dd64294BcBF5; // Wrapped Native Bridge
    // 0xC8A4FB931e8D77df8497790381CA7d228E68a41b // Native Bridge
    uint256 internal constant DSTCHAIN_ID = 59140; // Linea
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacetOptimized.HopData internal validHopData;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_GOERLI";
        customBlockNumberForForking = 8907340;
        ADDRESS_USDC = 0xfad6367E97217cC51b4cd838Cc086831f81d38C2; // USDT
        ADDRESS_DAI = 0xb93cba7013f4557cDFB590fD152d24Ef4063485f;
        ADDRESS_WETH = 0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6;
        ADDRESS_UNISWAP = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

        initTestBase();

        defaultUSDCAmount = 100000;
        defaultDAIAmount = 100000;

        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = hopFacet
            .startBridgeTokensViaHopL1ERC20
            .selector;
        functionSelectors[1] = hopFacet
            .startBridgeTokensViaHopL1Native
            .selector;
        functionSelectors[2] = hopFacet
            .swapAndStartBridgeTokensViaHopL1ERC20
            .selector;
        functionSelectors[3] = hopFacet
            .swapAndStartBridgeTokensViaHopL1Native
            .selector;
        functionSelectors[4] = hopFacet.setApprovalForBridges.selector;
        functionSelectors[5] = hopFacet.addDex.selector;
        functionSelectors[6] = hopFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        hopFacet = TestHopFacet(address(diamond));

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        // Set approval for all bridges
        address[] memory bridges = new address[](2);
        bridges[0] = USDC_BRIDGE;
        bridges[1] = DAI_BRIDGE;
        address[] memory tokens = new address[](2);
        tokens[0] = ADDRESS_USDC;
        tokens[1] = ADDRESS_DAI;
        hopFacet.setApprovalForBridges(bridges, tokens);

        vm.makePersistent(address(hopFacet));

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = DSTCHAIN_ID;

        // produce valid HopData
        validHopData = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(NATIVE_BRIDGE),
            relayer: address(0),
            relayerFee: 0,
            nativeFee: 0
        });

        addToMessageValue = 10_000_000_000_000_000;

        vm.label(
            0xd9e10C6b1bd26dE4E2749ce8aFe8Dd64294BcBF5,
            "L1BridgeWrapper"
        );

        // set native fee value (native Fee is added to all TX on Goerli > Linea)
        validHopData.nativeFee = 10000000000000000;

        // relayerFee zusätzlich bei Native tx
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            // fee parameter Native
            validHopData.relayerFee = 10000000000000000;
            validHopData.relayer = 0x81682250D4566B2986A2B33e23e7c52D401B7aB7;

            hopFacet.startBridgeTokensViaHopL1Native{
                value: bridgeData.minAmount + validHopData.nativeFee
            }(bridgeData, validHopData);
        } else {
            // fee parameter ERC20

            validHopData.relayer = 0xB47dE784aB8702eC35c5eAb225D6f6cE476DdD28;

            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.startBridgeTokensViaHopL1ERC20{
                value: validHopData.nativeFee
            }(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative || bridgeData.sendingAssetId == address(0)) {
            // minimumFee is: 10_000_000_000_000_000
            validHopData.relayerFee = 10_000_000_000_000_000;
            validHopData.relayer = 0x81682250D4566B2986A2B33e23e7c52D401B7aB7;
            validHopData.hopBridge = IHopBridge(NATIVE_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1Native{
                value: validHopData.nativeFee
            }(bridgeData, swapData, validHopData);
        } else {
            validHopData.nativeFee = 10_000_000_000_000_000;
            validHopData.relayer = 0xB47dE784aB8702eC35c5eAb225D6f6cE476DdD28;
            validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
            hopFacet.swapAndStartBridgeTokensViaHopL1ERC20{
                value: validHopData.nativeFee
            }(bridgeData, swapData, validHopData);
        }
    }

    function testCanSwapNativeAndBridgeTokens() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleETHtoUSDC();

        bridgeData.minAmount = defaultUSDCAmount = 100000;

        // update HopData
        validHopData.amountOutMin = defaultUSDCAmount;
        validHopData.hopBridge = IHopBridge(USDC_BRIDGE);
        validHopData.nativeFee = 10000000000000000;
        validHopData.relayer = 0xB47dE784aB8702eC35c5eAb225D6f6cE476DdD28;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        hopFacet.swapAndStartBridgeTokensViaHopL1ERC20{
            value: swapData[0].fromAmount + validHopData.nativeFee
        }(bridgeData, swapData, validHopData);
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = 100_000_000_000_000_000;

        // Calculate DAI amount
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

        //prepare check for events
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

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;

        // set swap data (based on updated amount)
        delete swapData;
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
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

        //prepare check for events
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

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        view
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
        public
        view
        override
    {
        console.log("Not applicable for HopFacetOptimized");
    }
}
