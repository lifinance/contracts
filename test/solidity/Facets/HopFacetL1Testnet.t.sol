// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetTest is TestBaseFacet {
    // EVENTS
    event HopBridgeRegistered(address indexed assetId, address bridge);
    event HopInitialized(HopFacet.Config[] configs);

    // These values are for Goerli
    address internal constant DAI_BRIDGE =
        0xAa1603822b43e592e33b58d34B4423E1bcD8b4dC; // Wrapped DAI Bridge
    address internal constant USDC_BRIDGE =
        0x53B94FAf104A484ff4E7c66bFe311fd48ce3D887; // Wrapped USDT Bridge
    address internal constant NATIVE_BRIDGE =
        0xd9e10C6b1bd26dE4E2749ce8aFe8Dd64294BcBF5; // Wrapped Native Bridge
    uint256 internal constant DSTCHAIN_ID = 59140; // Linea
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacet.HopData internal validHopData;

    function setUp() public {
        // Testnet config
        customRpcUrlForForking = "ETH_NODE_URI_GOERLI";
        customBlockNumberForForking = 8907340;
        ADDRESS_USDC = 0xfad6367E97217cC51b4cd838Cc086831f81d38C2; // USDT
        ADDRESS_DAI = 0xb93cba7013f4557cDFB590fD152d24Ef4063485f;
        ADDRESS_WETH = 0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6;
        ADDRESS_UNISWAP = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

        initTestBase();

        // smaler amounts because of limited liquidity
        defaultUSDCAmount = 100000;
        defaultDAIAmount = 100000;
        defaultNativeAmount = 0.01 ether;
        setDefaultBridgeData();

        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHop.selector;
        functionSelectors[1] = hopFacet
            .swapAndStartBridgeTokensViaHop
            .selector;
        functionSelectors[2] = hopFacet.initHop.selector;
        functionSelectors[3] = hopFacet.registerBridge.selector;
        functionSelectors[4] = hopFacet.addDex.selector;
        functionSelectors[5] = hopFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](3);
        configs[0] = HopFacet.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs[1] = HopFacet.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs[2] = HopFacet.Config(address(0), NATIVE_BRIDGE);

        hopFacet = TestHopFacet(address(diamond));
        hopFacet.initHop(configs);

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
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        vm.makePersistent(address(hopFacet));

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = DSTCHAIN_ID;

        // produce valid HopData
        validHopData = HopFacet.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            relayer: address(0),
            relayerFee: 0,
            nativeFee: 10000000000000000
        });

        // native fee expected to be payed on top
        addToMessageValue = 10000000000000000;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            // fee parameter Native
            validHopData.relayerFee = 10000000000000000;
            validHopData.relayer = 0x81682250D4566B2986A2B33e23e7c52D401B7aB7;
        } else {
            // fee parameter ERC20
            validHopData.relayer = 0xB47dE784aB8702eC35c5eAb225D6f6cE476DdD28;
        }

        if (isNative) {
            hopFacet.startBridgeTokensViaHop{
                value: bridgeData.minAmount + validHopData.nativeFee
            }(bridgeData, validHopData);
        } else {
            hopFacet.startBridgeTokensViaHop{ value: validHopData.nativeFee }(
                bridgeData,
                validHopData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        // parameters based on the asset which is transferred via hop
        if (bridgeData.sendingAssetId == address(0)) {
            // fee parameter Native
            validHopData.relayerFee = 10000000000000000;
            validHopData.relayer = 0x81682250D4566B2986A2B33e23e7c52D401B7aB7;
        } else {
            // fee parameter ERC20
            validHopData.relayer = 0xB47dE784aB8702eC35c5eAb225D6f6cE476DdD28;
        }

        // parameters based on the asset the user is starting the transfer with
        if (isNative) {
            hopFacet.swapAndStartBridgeTokensViaHop{
                value: swapData[0].fromAmount + validHopData.nativeFee
            }(bridgeData, swapData, validHopData);
        } else {
            hopFacet.swapAndStartBridgeTokensViaHop{
                value: validHopData.nativeFee
            }(bridgeData, swapData, validHopData);
        }
    }
}
