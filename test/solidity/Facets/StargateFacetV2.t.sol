// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, LiFiDiamond } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, InformationMismatch, AlreadyInitialized } from "src/Errors/GenericErrors.sol";
import { StargateFacetV2 } from "lifi/Facets/StargateFacetV2.sol";
import { IStargate, ITokenMessaging } from "lifi/Interfaces/IStargate.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

import { OFTComposeMsgCodec } from "lifi/Periphery/ReceiverStargateV2.sol";

// Stub StargateFacetV2 Contract
contract TestStargateFacetV2 is StargateFacetV2 {
    constructor(
        address _tokenMessagingAddress
    ) StargateFacetV2(_tokenMessagingAddress) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract StargateFacetV2Test is TestBaseFacet {
    using OFTComposeMsgCodec for address;

    // EVENTS
    event WhitelistUpdated(address[] whitelistedRouters, uint256[] values);
    event Approval(address owner, address spender, uint256 value);
    event PartnerSwap(bytes2 partnerId);
    error InvalidAssetId(uint16 invalidAssetId);

    // These values are for Mainnet
    address internal constant STARGATE_POOL_NATIVE =
        0x77b2043768d28E9C9aB44E1aBfC95944bcE57931;
    address internal constant STARGATE_POOL_USDC =
        0xc026395860Db2d07ee33e05fE50ed7bD583189C7;
    address internal constant TOKEN_MESSAGING =
        0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980;
    uint32 internal constant DST_E_ID_USDC = 30184; // BAS
    uint32 internal constant DST_E_ID_NATIVE = 30111; // OPT
    uint16 internal constant ASSET_ID_USDC = 1;
    uint16 internal constant ASSET_ID_NATIVE = 13;
    bytes internal constant VALID_EXTRA_OPTIONS_VALUE =
        hex"000301001303000000000000000000000000000000061a80";
    // -----

    TestStargateFacetV2 internal stargateFacetV2;
    FeeCollector internal feeCollector;
    StargateFacetV2.StargateData internal stargateData;
    uint256 internal nativeAddToMessageValue;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 19979843;

        initTestBase();

        stargateFacetV2 = new TestStargateFacetV2(TOKEN_MESSAGING);
        feeCollector = new FeeCollector(address(this));

        defaultUSDCAmount = 100 * 10 ** usdc.decimals();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = stargateFacetV2
            .startBridgeTokensViaStargate
            .selector;
        functionSelectors[1] = stargateFacetV2
            .swapAndStartBridgeTokensViaStargate
            .selector;
        functionSelectors[2] = stargateFacetV2.addDex.selector;
        functionSelectors[3] = stargateFacetV2
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = stargateFacetV2.tokenMessaging.selector;

        addFacet(diamond, address(stargateFacetV2), functionSelectors);
        stargateFacetV2 = TestStargateFacetV2(payable(address(diamond)));

        // whitelist DEX and feeCollector addresses and function selectors in diamond
        stargateFacetV2.addDex(address(uniswap));
        stargateFacetV2.addDex(address(feeCollector));
        stargateFacetV2.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        stargateFacetV2.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        stargateFacetV2.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        stargateFacetV2.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        stargateFacetV2.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );
        stargateFacetV2.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(address(stargateFacetV2), "StargateFacetV2");

        // update default bridgeData
        bridgeData.bridge = "stargate";
        bridgeData.minAmount = defaultUSDCAmount;

        // prepare default StargateData
        stargateData = StargateFacetV2.StargateData({
            assetId: ASSET_ID_USDC,
            sendParams: IStargate.SendParam({
                dstEid: 30150,
                to: USER_RECEIVER.addressToBytes32(),
                amountLD: defaultUSDCAmount,
                minAmountLD: (defaultUSDCAmount * 9e4) / 1e5,
                extraOptions: "",
                composeMsg: "",
                oftCmd: OftCmdHelper.bus()
            }),
            fee: IStargate.MessagingFee({ nativeFee: 0, lzTokenFee: 0 }),
            refundAddress: payable(USER_REFUND)
        });

        // add labels for better readability
        vm.label(STARGATE_POOL_USDC, "STARGATE_POOL_USDC");
        vm.label(STARGATE_POOL_NATIVE, "STARGATE_POOL_NATIVE");
        vm.label(TOKEN_MESSAGING, "TOKEN_MESSAGING");
        vm.label(0x1a44076050125825900e736c501f859c50fE728c, "LZ_EndpointV2");

        // get quote and update fee information in stargateData
        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_USDC)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;
        addToMessageValue = fees.nativeFee;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            stargateFacetV2.startBridgeTokensViaStargate{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, stargateData);
        } else {
            stargateFacetV2.startBridgeTokensViaStargate{
                value: addToMessageValue
            }(bridgeData, stargateData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        stargateFacetV2.swapAndStartBridgeTokensViaStargate{
            value: addToMessageValue
        }(bridgeData, swapData, stargateData);
    }

    /// Additional Tests ///

    // ERC20
    function test_canBridgeERC20Tokens() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeERC20TokensWithInsufficientMsgValueForFee()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        vm.expectRevert();

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee - 1
        }(bridgeData, stargateData);
    }

    function test_revert_ReceiverAddressesDontMatchWhenNoDestCall() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);
        bridgeData.receiver = USER_SENDER;

        vm.expectRevert(InformationMismatch.selector);

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_canBridgeERC20TokensWithExistingNonZeroAllowance() public {
        // set non-zero allowance between facet and Stargate pool
        vm.startPrank(address(stargateFacetV2));
        usdc.approve(STARGATE_POOL_USDC, 1);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_canBridgeERC20TokensWithExistingZeroAllowance() public {
        // set non-zero allowance between facet and Stargate pool
        vm.startPrank(address(stargateFacetV2));
        usdc.approve(STARGATE_POOL_USDC, 0);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_canBridgeERC20TokensWithExistingMaxAllowance() public {
        // set non-zero allowance between facet and Stargate pool
        vm.startPrank(address(stargateFacetV2));
        usdc.approve(STARGATE_POOL_USDC, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_canBridgeERC20TokensWithDestCall() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        bridgeData.hasDestinationCall = true;
        stargateData.sendParams.composeMsg = hex"123456";
        stargateData.sendParams.oftCmd = OftCmdHelper.taxi();

        // get quote and update fee information in stargateData
        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_USDC)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;
        addToMessageValue = fees.nativeFee;

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeERC20TokensWithDestCallButNoCalldata() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);
        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeERC20TokensWithDestCallWrongReceiverAddress()
        public
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        // update sendParams for dest call
        stargateData.sendParams.composeMsg = hex"123456";
        stargateData.sendParams.oftCmd = OftCmdHelper.bus();
        stargateData.sendParams.extraOptions = VALID_EXTRA_OPTIONS_VALUE;

        vm.expectRevert(InformationMismatch.selector);
        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeERC20TokensWithDestCallBusMode() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        bridgeData.hasDestinationCall = true;
        stargateData.sendParams.composeMsg = hex"123456";
        stargateData.sendParams.oftCmd = OftCmdHelper.bus();

        vm.expectRevert(InformationMismatch.selector);
        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_canBridgeERC20TokensWithExistingNonZeroApproval() public {
        // set allowance from facet to router to non-zero value
        vm.startPrank(address(stargateFacetV2));
        usdc.approve(STARGATE_POOL_USDC, 1);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        // set allowance from sender to facet
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);

        // expect event to be emitted
        vm.expectEmit(true, true, true, true, address(stargateFacetV2));
        emit LiFiTransferStarted(bridgeData);

        // execute call
        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_CanSwapAndBridgeERC20Tokens() public {
        vm.startPrank(USER_SENDER);

        // get bridge- and stargateData
        _getERC20SwapAndBridgeData();

        vm.expectEmit(true, true, true, true, address(stargateFacetV2));
        emit LiFiTransferStarted(bridgeData);

        stargateFacetV2.swapAndStartBridgeTokensViaStargate{
            value: swapData[0].fromAmount +
                stargateData.fee.nativeFee +
                1 ether
        }(bridgeData, swapData, stargateData);
    }

    function test_revert_UnknownAssetId() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(stargateFacetV2), bridgeData.minAmount);
        stargateData.assetId = type(uint16).max;

        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidAssetId.selector,
                stargateData.assetId
            )
        );

        stargateFacetV2.startBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    // NATIVE
    function testBase_CanBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeBridgingData();

        stargateFacetV2.startBridgeTokensViaStargate{
            value: bridgeData.minAmount + stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeNativeTokensWithInsufficientMsgValue() public {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeBridgingData();

        vm.expectRevert();

        stargateFacetV2.startBridgeTokensViaStargate{
            value: bridgeData.minAmount + stargateData.fee.nativeFee - 1
        }(bridgeData, stargateData);
    }

    function test_CanBridgeNativeTokensWithDestCall() public {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeBridgingData();
        bridgeData.hasDestinationCall = true;

        // update sendParams for dest call
        stargateData.sendParams.composeMsg = hex"123456";
        stargateData.sendParams.oftCmd = OftCmdHelper.taxi();
        stargateData.sendParams.extraOptions = VALID_EXTRA_OPTIONS_VALUE;

        // get quote and update fee information in stargateData
        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_USDC)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;
        addToMessageValue = fees.nativeFee;

        stargateFacetV2.startBridgeTokensViaStargate{
            value: bridgeData.minAmount + stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    function test_revert_BridgeNativeTokensWithDestCallButNoCalldata() public {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeBridgingData();
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);
        stargateFacetV2.startBridgeTokensViaStargate{
            value: bridgeData.minAmount + stargateData.fee.nativeFee
        }(bridgeData, stargateData);
    }

    // SWAP AND BRIDGE
    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeSwapAndBridgeData();

        // set approval for usdc
        usdc.approve(address(stargateFacetV2), swapData[0].fromAmount);

        // expect event to be emitted
        vm.expectEmit(true, true, true, true, address(stargateFacetV2));
        emit LiFiTransferStarted(bridgeData);

        stargateFacetV2.swapAndStartBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, swapData, stargateData);
    }

    function test_CanSwapAndBridgeNativeTokensWithDestCall() public {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeSwapAndBridgeData();

        // set approval for usdc
        usdc.approve(address(stargateFacetV2), swapData[0].fromAmount);

        // update bridgeData
        bridgeData.hasDestinationCall = true;
        stargateData.sendParams.composeMsg = hex"123456";
        stargateData.sendParams.oftCmd = OftCmdHelper.taxi();

        // get quote and update fee information in stargateData
        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_USDC)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;
        addToMessageValue = fees.nativeFee;

        // expect event to be emitted
        vm.expectEmit(true, true, true, true, address(stargateFacetV2));
        emit LiFiTransferStarted(bridgeData);

        stargateFacetV2.swapAndStartBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, swapData, stargateData);
    }

    function test_revert_SwapAndBridgeNativeTokensWithDestCallButNoCalldata()
        public
    {
        vm.startPrank(USER_SENDER);

        // get native bridge- and stargateData
        _getNativeSwapAndBridgeData();

        // set approval for usdc
        usdc.approve(address(stargateFacetV2), swapData[0].fromAmount);

        // update bridgeData
        bridgeData.hasDestinationCall = true;

        // expect event to be emitted
        vm.expectRevert(InformationMismatch.selector);

        stargateFacetV2.swapAndStartBridgeTokensViaStargate{
            value: stargateData.fee.nativeFee
        }(bridgeData, swapData, stargateData);
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // not used for this facet
    }

    function test_contractIsSetUpCorrectly() public {
        stargateFacetV2 = new TestStargateFacetV2(address(0));

        assertEq(
            address(stargateFacetV2.tokenMessaging()) == address(0),
            true
        );

        stargateFacetV2 = new TestStargateFacetV2(TOKEN_MESSAGING);

        assertEq(
            address(stargateFacetV2.tokenMessaging()) == TOKEN_MESSAGING,
            true
        );
    }

    // HELPER FUNCTIONS

    function _getUSDCToExactNativeSwapData() internal {
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = bridgeData.minAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

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
                    address(stargateFacetV2),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function _getNativeToExactUSDCSwapData() internal {
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = bridgeData.minAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    address(stargateFacetV2),
                    block.timestamp + 2000 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function _getNativeSwapAndBridgeData() internal {
        _getNativeBridgingData();

        // update bridgeData
        bridgeData.hasSourceSwaps = true;

        // create swapData
        _getUSDCToExactNativeSwapData();
    }

    function _getERC20SwapAndBridgeData() internal {
        // update bridgeData
        bridgeData.hasSourceSwaps = true;

        // create swapData
        _getNativeToExactUSDCSwapData();
    }

    function _getNativeBridgingData() internal {
        // update bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        // update stargateData
        stargateData.assetId = ASSET_ID_NATIVE;
        stargateData.sendParams.amountLD = defaultNativeAmount;
        stargateData.sendParams.dstEid = DST_E_ID_NATIVE;

        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_NATIVE)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;
    }

    function _getUpdateWhitelistParameters(
        uint256 length
    )
        internal
        view
        returns (address[] memory addresses, uint256[] memory values)
    {
        addresses = new address[](length);
        addresses[0] = address(uniswap);
        values = new uint256[](length);
        values[0] = 1;
    }
}

library OftCmdHelper {
    function taxi() internal pure returns (bytes memory) {
        return "";
    }

    function bus() internal pure returns (bytes memory) {
        return new bytes(1);
    }
}
