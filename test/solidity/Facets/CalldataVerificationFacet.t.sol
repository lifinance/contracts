// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";
import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { StargateFacetV2 } from "lifi/Facets/StargateFacetV2.sol";
import { IStargate } from "lifi/Interfaces/IStargate.sol";

import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { CelerIM, CelerIMFacetBase } from "lifi/Helpers/CelerIMFacetBase.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBase } from "../utils/TestBase.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";

import { MsgDataTypes } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { console } from "forge-std/console.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { OFTComposeMsgCodec } from "lifi/Periphery/ReceiverStargateV2.sol";

contract CalldataVerificationFacetTest is TestBase {
    using LibBytes for bytes;
    using OFTComposeMsgCodec for address;

    CalldataVerificationFacet internal calldataVerificationFacet;

    function setUp() public {
        customBlockNumberForForking = 19979843;
        initTestBase();
        calldataVerificationFacet = new CalldataVerificationFacet();
        bridgeData = ILiFi.BridgeData({
            transactionId: keccak256("id"),
            bridge: "acme",
            integrator: "acme",
            referrer: address(0),
            sendingAssetId: address(123),
            receiver: address(456),
            minAmount: 1 ether,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: true
        });

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(123),
                receivingAssetId: address(456),
                fromAmount: 1 ether,
                callData: abi.encodePacked("calldata"),
                requiresDeposit: true
            })
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(calldataVerificationFacet),
            "CalldataVerificationFacet"
        );
    }

    function test_DeploysWithoutErrors() public {
        calldataVerificationFacet = new CalldataVerificationFacet();
    }

    function test_IgnoresExtraBytes() public view {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory fullCalldata = bytes.concat(callData, "extra stuff");
        calldataVerificationFacet.extractBridgeData(fullCalldata);
        calldataVerificationFacet.extractSwapData(fullCalldata);
        calldataVerificationFacet.extractData(fullCalldata);
        calldataVerificationFacet.extractMainParameters(fullCalldata);

        fullCalldata = bytes.concat(standardizedCallData, "extra stuff");
        calldataVerificationFacet.extractBridgeData(fullCalldata);
        calldataVerificationFacet.extractSwapData(fullCalldata);
        calldataVerificationFacet.extractData(fullCalldata);
        calldataVerificationFacet.extractMainParameters(fullCalldata);
    }

    function test_CanExtractBridgeData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        ILiFi.BridgeData memory returnedData = calldataVerificationFacet
            .extractBridgeData(callData);

        checkBridgeData(returnedData);
    }

    function test_CanExtractSwapData() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        LibSwap.SwapData[] memory returnedData = calldataVerificationFacet
            .extractSwapData(callData);

        checkSwapData(returnedData);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        returnedData = calldataVerificationFacet.extractSwapData(
            standardizedCallData
        );

        checkSwapData(returnedData);
    }

    function test_CanExtractBridgeAndSwapData() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (returnedBridgeData, returnedSwapData) = calldataVerificationFacet
            .extractData(standardizedCallData);

        checkBridgeData(returnedBridgeData);
        checkSwapData(returnedSwapData);
    }

    function test_CanExtractBridgeAndSwapDataNoSwaps() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        (
            ILiFi.BridgeData memory returnedBridgeData,
            LibSwap.SwapData[] memory returnedSwapData
        ) = calldataVerificationFacet.extractData(callData);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (returnedBridgeData, returnedSwapData) = calldataVerificationFacet
            .extractData(standardizedCallData);

        checkBridgeData(returnedBridgeData);
        assertEq(returnedSwapData.length, 0);
    }

    function test_CanExtractNonEVMAddress() public {
        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.startBridgeTokensViaMayan.selector,
            bridgeData,
            mayanData
        );

        bytes32 returnedNonEVMAddress = calldataVerificationFacet
            .extractNonEVMAddress(callData);

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        returnedNonEVMAddress = calldataVerificationFacet.extractNonEVMAddress(
            standardizedCallData
        );

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));
    }

    function test_CanExtractNonEVMAddressWithSwaps() public {
        bridgeData.hasSourceSwaps = true;

        // produce valid MayanData
        MayanFacet.MayanData memory mayanData = MayanFacet.MayanData(
            bytes32("Just some address"),
            0xF18f923480dC144326e6C65d4F3D47Aa459bb41C, // mayanProtocol address
            hex"00"
        );

        bytes memory callData = abi.encodeWithSelector(
            MayanFacet.swapAndStartBridgeTokensViaMayan.selector,
            bridgeData,
            swapData,
            mayanData
        );

        bytes32 returnedNonEVMAddress = calldataVerificationFacet
            .extractNonEVMAddress(callData);

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        returnedNonEVMAddress = calldataVerificationFacet.extractNonEVMAddress(
            standardizedCallData
        );

        assertEq(returnedNonEVMAddress, bytes32("Just some address"));
    }

    function test_CanExtractMainParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(callData);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, bridgeData.sendingAssetId);
        assertEq(minAmount, bridgeData.minAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        (
            bridge,
            sendingAssetId,
            receiver,
            minAmount,
            destinationChainId,
            hasSourceSwaps,
            hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(
            standardizedCallData
        );

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, bridgeData.sendingAssetId);
        assertEq(minAmount, bridgeData.minAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    function test_RevertsOnInvalidGenericSwapCallData() public {
        // prepare minimum callData
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(123),
            receivingAssetId: address(456),
            fromAmount: 1,
            callData: "",
            requiresDeposit: false
        });
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256(""),
            "",
            "",
            payable(address(1234)),
            1,
            swapData[0]
        );

        // reduce calldata to 483 bytes to not meet min calldata length threshold
        callData = callData.slice(0, 483);

        vm.expectRevert(InvalidCallData.selector);

        calldataVerificationFacet.extractGenericSwapParameters(callData);
    }

    function test_CanExtractGenericSwapMinCallData() public {
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(123),
            receivingAssetId: address(456),
            fromAmount: 1,
            callData: "",
            requiresDeposit: false
        });
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256(""),
            "",
            "",
            payable(address(1234)),
            1,
            swapData[0]
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1);
    }

    function test_CanExtractGenericSwapV3SingleParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            keccak256("id"),
            "acme",
            "acme",
            payable(address(1234)),
            1 ether,
            swapData[0]
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (
            sendingAssetId,
            amount,
            receiver,
            receivingAssetId,
            receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(
            standardizedCallData
        );

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);
    }

    function test_CanExtractGenericSwapV3MultipleParameters() public {
        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20.selector,
            keccak256("id"),
            "acme",
            "acme",
            payable(address(1234)),
            1 ether,
            swapData
        );

        (
            address sendingAssetId,
            uint256 amount,
            address receiver,
            address receivingAssetId,
            uint256 receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(callData);

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (
            sendingAssetId,
            amount,
            receiver,
            receivingAssetId,
            receivingAmount
        ) = calldataVerificationFacet.extractGenericSwapParameters(
            standardizedCallData
        );

        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(amount, swapData[0].fromAmount);
        assertEq(receiver, address(1234));
        assertEq(
            receivingAssetId,
            swapData[swapData.length - 1].receivingAssetId
        );
        assertEq(receivingAmount, 1 ether);
    }

    function test_CanExtractMainParametersWithSwap() public {
        bridgeData.hasSourceSwaps = true;
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.swapAndStartBridgeTokensViaHyphen.selector,
            bridgeData,
            swapData
        );

        (
            string memory bridge,
            address sendingAssetId,
            address receiver,
            uint256 minAmount,
            uint256 destinationChainId,
            bool hasSourceSwaps,
            bool hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(callData);

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(minAmount, swapData[0].fromAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);

        // standardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        (
            bridge,
            sendingAssetId,
            receiver,
            minAmount,
            destinationChainId,
            hasSourceSwaps,
            hasDestinationCall
        ) = calldataVerificationFacet.extractMainParameters(
            standardizedCallData
        );

        assertEq(bridge, bridgeData.bridge);
        assertEq(receiver, bridgeData.receiver);
        assertEq(sendingAssetId, swapData[0].sendingAssetId);
        assertEq(minAmount, swapData[0].fromAmount);
        assertEq(destinationChainId, bridgeData.destinationChainId);
        assertEq(hasSourceSwaps, bridgeData.hasSourceSwaps);
        assertEq(hasDestinationCall, bridgeData.hasDestinationCall);
    }

    function test_CanValidateCalldata() public {
        bytes memory callData = abi.encodeWithSelector(
            HyphenFacet.startBridgeTokensViaHyphen.selector,
            bridgeData
        );

        bool validCall = calldataVerificationFacet.validateCalldata(
            callData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        bool invalidCall = calldataVerificationFacet.validateCalldata(
            callData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            address(0xb33f),
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        assertTrue(validCall);
        assertFalse(invalidCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        validCall = calldataVerificationFacet.validateCalldata(
            standardizedCallData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            bridgeData.receiver,
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        invalidCall = calldataVerificationFacet.validateCalldata(
            standardizedCallData,
            bridgeData.bridge,
            bridgeData.sendingAssetId,
            address(0xb33f),
            bridgeData.minAmount,
            bridgeData.destinationChainId,
            bridgeData.hasSourceSwaps,
            bridgeData.hasDestinationCall
        );
        assertTrue(validCall);
        assertFalse(invalidCall);
    }

    function test_CanValidateAmarokDestinationCalldata() public {
        AmarokFacet.AmarokData memory amarokData = AmarokFacet.AmarokData({
            callData: bytes("foobarbytes"),
            callTo: USER_RECEIVER,
            relayerFee: 0,
            slippageTol: 0,
            delegate: USER_RECEIVER,
            destChainDomainId: 1234,
            payFeeWithSendingAsset: false
        });

        bytes memory callData = abi.encodeWithSelector(
            AmarokFacet.startBridgeTokensViaAmarok.selector,
            bridgeData,
            amarokData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            AmarokFacet.swapAndStartBridgeTokensViaAmarok.selector,
            bridgeData,
            swapData,
            amarokData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );
        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callDataWithSwap
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateStargateDestinationCalldata() public {
        StargateFacet.StargateData memory sgData = StargateFacet.StargateData({
            srcPoolId: 1,
            dstPoolId: 2,
            minAmountLD: 3,
            dstGasForCall: 4,
            lzFee: 5,
            refundAddress: payable(address(0x1234)),
            callTo: abi.encode(USER_RECEIVER),
            callData: bytes("foobarbytes")
        });

        bytes memory callData = abi.encodeWithSelector(
            StargateFacet.startBridgeTokensViaStargate.selector,
            bridgeData,
            sgData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            StargateFacet.swapAndStartBridgeTokensViaStargate.selector,
            bridgeData,
            swapData,
            sgData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callDataWithSwap
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateStargateV2DestinationCalldata() public {
        uint16 ASSET_ID_USDC = 1;
        address STARGATE_POOL_USDC = 0xc026395860Db2d07ee33e05fE50ed7bD583189C7;

        StargateFacetV2.StargateData memory stargateData = StargateFacetV2
            .StargateData({
                assetId: ASSET_ID_USDC,
                sendParams: IStargate.SendParam({
                    dstEid: 30150,
                    to: USER_RECEIVER.addressToBytes32(),
                    amountLD: defaultUSDCAmount,
                    minAmountLD: (defaultUSDCAmount * 9e4) / 1e5,
                    extraOptions: "",
                    composeMsg: bytes("foobarbytes"),
                    oftCmd: OftCmdHelper.bus()
                }),
                fee: IStargate.MessagingFee({ nativeFee: 0, lzTokenFee: 0 }),
                refundAddress: payable(USER_REFUND)
            });

        // get quote and update fee information in stargateData
        IStargate.MessagingFee memory fees = IStargate(STARGATE_POOL_USDC)
            .quoteSend(stargateData.sendParams, false);
        stargateData.fee = fees;

        bytes memory callData = abi.encodeWithSelector(
            StargateFacetV2.startBridgeTokensViaStargate.selector,
            bridgeData,
            stargateData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            StargateFacetV2.swapAndStartBridgeTokensViaStargate.selector,
            bridgeData,
            swapData,
            stargateData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callDataWithSwap
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateCelerIMDestinationCalldata() public {
        CelerIM.CelerIMData memory cimData = CelerIM.CelerIMData({
            maxSlippage: 1,
            nonce: 2,
            callTo: abi.encode(USER_RECEIVER),
            callData: bytes("foobarbytes"),
            messageBusFee: 3,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });

        bytes memory callData = abi.encodeWithSelector(
            CelerIMFacetBase.startBridgeTokensViaCelerIM.selector,
            bridgeData,
            cimData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            CelerIMFacetBase.swapAndStartBridgeTokensViaCelerIM.selector,
            bridgeData,
            swapData,
            cimData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_CanValidateAcrossV3DestinationCalldata() public {
        AcrossFacetV3.AcrossV3Data memory acrossData = AcrossFacetV3
            .AcrossV3Data({
                receiverAddress: USER_RECEIVER,
                refundAddress: USER_REFUND,
                receivingAssetId: ADDRESS_USDC,
                outputAmount: (defaultUSDCAmount * 9) / 10,
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(uint32(block.timestamp) + 1000),
                message: bytes("foobarbytes")
            });

        bytes memory callData = abi.encodeWithSelector(
            AcrossFacetV3.startBridgeTokensViaAcrossV3.selector,
            bridgeData,
            acrossData
        );

        bytes memory callDataWithSwap = abi.encodeWithSelector(
            AcrossFacetV3.swapAndStartBridgeTokensViaAcrossV3.selector,
            bridgeData,
            swapData,
            acrossData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        bool validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                callDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        bool badCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);

        // StandardizedCall
        bytes memory standardizedCallData = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        bytes memory standardizedCallDataWithSwap = abi.encodeWithSelector(
            StandardizedCallFacet.standardizedCall.selector,
            callData
        );

        validCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );
        validCallWithSwap = calldataVerificationFacet
            .validateDestinationCalldata(
                standardizedCallDataWithSwap,
                abi.encode(USER_RECEIVER),
                bytes("foobarbytes")
            );

        badCall = calldataVerificationFacet.validateDestinationCalldata(
            standardizedCallData,
            abi.encode(USER_RECEIVER),
            bytes("badbytes")
        );

        assertTrue(validCall);
        assertTrue(validCallWithSwap);
        assertFalse(badCall);
    }

    function test_RevertsOnDestinationCalldataWithInvalidSelector() public {
        CelerIM.CelerIMData memory cimData = CelerIM.CelerIMData({
            maxSlippage: 1,
            nonce: 2,
            callTo: abi.encode(USER_RECEIVER),
            callData: bytes("foobarbytes"),
            messageBusFee: 3,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });

        bytes memory callData = abi.encodeWithSelector(
            GenericSwapFacet.swapTokensGeneric.selector, // wrong selector, does not support destination calls
            bridgeData,
            cimData
        );

        bool validCall = calldataVerificationFacet.validateDestinationCalldata(
            callData,
            abi.encode(USER_RECEIVER),
            bytes("foobarbytes")
        );

        assertFalse(validCall);
    }

    function checkBridgeData(ILiFi.BridgeData memory data) internal {
        assertTrue(data.transactionId == bridgeData.transactionId);
        assertEq(data.bridge, bridgeData.bridge);
        assertEq(data.integrator, bridgeData.integrator);
    }

    function checkSwapData(LibSwap.SwapData[] memory data) internal {
        assertTrue(data[0].callTo == swapData[0].callTo);
        assertTrue(data[0].approveTo == swapData[0].approveTo);
        assertTrue(data[0].sendingAssetId == swapData[0].sendingAssetId);
        assertTrue(data[0].receivingAssetId == swapData[0].receivingAssetId);
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
