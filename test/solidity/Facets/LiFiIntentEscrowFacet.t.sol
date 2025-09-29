// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LiFiIntentEscrowFacet } from "lifi/Facets/LiFiIntentEscrowFacet.sol";

import { MandateOutput, StandardOrder } from "lifi/Interfaces/IOIF.sol";

contract AlwaysYesOracle {
    function isProven(
        uint256,
        /* remoteChainId */ bytes32,
        /* outputOracle */ bytes32,
        /* application */ bytes32 /* dataHash */
    ) external pure returns (bool) {
        return true;
    }

    function efficientRequireProven(
        bytes calldata /* proofSeries */
    ) external pure {}
}

struct SolveParams {
    uint32 timestamp;
    bytes32 solver;
}

interface ILiFiIntentEscrowSettler {
    event Open(bytes32 indexed orderId, StandardOrder order);

    function orderStatus(bytes32 orderid) external returns (uint8);

    function finalise(
        StandardOrder calldata order,
        SolveParams[] calldata solveParams,
        bytes32 destination,
        bytes calldata call
    ) external;

    function orderIdentifier(
        StandardOrder calldata order
    ) external view returns (bytes32);
}

// Stub LiFiIntentEscrowFacet Contract
contract TestLiFiIntentEscrowFacet is LiFiIntentEscrowFacet {
    constructor(address escrowSettler) LiFiIntentEscrowFacet(escrowSettler) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract LiFiIntentEscrowFacetTest is TestBaseFacet {
    error FailedInputSettlerDeployment();
    LiFiIntentEscrowFacet.LiFiIntentEscrowData internal validLIFIIntentData;
    TestLiFiIntentEscrowFacet internal lifiIntentEscrowFacet;
    TestLiFiIntentEscrowFacet internal baseLiFiIntentEscrowFacet;

    address internal lifiIntentEscrowSettler;

    address internal alwaysYesOracle;

    function setUp() public {
        // Block after deployment.
        customBlockNumberForForking = 23445613;
        initTestBase();

        // deploy oracle & allocator
        alwaysYesOracle = address(new AlwaysYesOracle());

        lifiIntentEscrowSettler = 0x000001bf3F3175BD007f3889b50000c7006E72c0;

        baseLiFiIntentEscrowFacet = new TestLiFiIntentEscrowFacet(
            lifiIntentEscrowSettler
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = baseLiFiIntentEscrowFacet
            .startBridgeTokensViaLiFiIntentEscrow
            .selector;
        functionSelectors[1] = baseLiFiIntentEscrowFacet
            .swapAndStartBridgeTokensViaLiFiIntentEscrow
            .selector;
        functionSelectors[2] = baseLiFiIntentEscrowFacet.addDex.selector;
        functionSelectors[3] = baseLiFiIntentEscrowFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(
            diamond,
            address(baseLiFiIntentEscrowFacet),
            functionSelectors
        );
        lifiIntentEscrowFacet = TestLiFiIntentEscrowFacet(address(diamond));
        lifiIntentEscrowFacet.addDex(ADDRESS_UNISWAP);
        lifiIntentEscrowFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        lifiIntentEscrowFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        lifiIntentEscrowFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(lifiIntentEscrowFacet),
            "LiFiIntentEscrowFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "LIFIIntent";
        bridgeData.destinationChainId = 137;

        // produce valid LiFiIntentEscrowData
        validLIFIIntentData = LiFiIntentEscrowFacet.LiFiIntentEscrowData({
            receiverAddress: bytes32(uint256(uint160(bridgeData.receiver))),
            depositAndRefundAddress: address(uint160(123123321321)),
            nonce: uint256(100),
            expires: type(uint32).max,
            fillDeadline: type(uint32).max,
            inputOracle: alwaysYesOracle, // Not used
            outputOracle: bytes32(0), // not used
            outputSettler: bytes32(0), // not used
            outputToken: bytes32(uint256(888999888)),
            outputAmount: 999888999,
            outputCall: hex"",
            outputContext: hex""
        });
    }

    function testRevert_deploy_with_0_address() external {
        vm.expectRevert(abi.encodeWithSignature("InvalidConfig()"));
        new TestLiFiIntentEscrowFacet(address(0));
    }

    event Finalised(
        bytes32 indexed orderId,
        bytes32 solver,
        bytes32 destination
    );

    event IntentRegistered(bytes32 indexed orderId, StandardOrder order);

    function test_LIFIIntent_deposit_status() external {
        bool isNative = false;
        vm.startPrank(USER_SENDER);
        usdc.approve(address(baseLiFiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = isNative ? address(0) : address(usdc);

        // Check that the execution happens as we would expect it to.

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: validLIFIIntentData.outputOracle,
            settler: validLIFIIntentData.outputSettler,
            chainId: bridgeData.destinationChainId,
            token: validLIFIIntentData.outputToken,
            amount: validLIFIIntentData.outputAmount,
            recipient: validLIFIIntentData.receiverAddress,
            call: validLIFIIntentData.outputCall,
            context: validLIFIIntentData.outputContext
        });
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [
            uint256(uint160(bridgeData.sendingAssetId)),
            bridgeData.minAmount
        ];

        StandardOrder memory order = StandardOrder({
            user: validLIFIIntentData.depositAndRefundAddress,
            nonce: validLIFIIntentData.nonce,
            originChainId: block.chainid,
            expires: validLIFIIntentData.expires,
            fillDeadline: validLIFIIntentData.fillDeadline,
            inputOracle: validLIFIIntentData.inputOracle,
            inputs: idsAndAmounts,
            outputs: outputs
        });

        bytes32 orderId = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderIdentifier(order);

        vm.expectEmit();
        emit ILiFiIntentEscrowSettler.Open(orderId, order);

        baseLiFiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrow{
            value: LibAsset.isNativeAsset(bridgeData.sendingAssetId)
                ? bridgeData.minAmount
                : 0
        }(bridgeData, validLIFIIntentData);
        vm.stopPrank();

        // Check that we can redeem the intent (i.e. that we registered the intent we expected.)

        address solver = address(7788778877);
        vm.startPrank(solver);

        uint8 orderStatus = ILiFiIntentEscrowSettler(lifiIntentEscrowSettler)
            .orderStatus(orderId);
        assertEq(orderStatus, 1); // Check orderStatus is deposited.

        bytes32 solverIdentifier = bytes32(uint256(uint160(solver)));
        SolveParams[] memory solveParams = new SolveParams[](1);
        solveParams[0] = SolveParams({
            timestamp: type(uint32).max,
            solver: solverIdentifier
        });

        vm.expectEmit();
        emit Finalised(orderId, solverIdentifier, solverIdentifier);

        ILiFiIntentEscrowSettler(lifiIntentEscrowSettler).finalise(
            order,
            solveParams,
            bytes32(uint256(uint160(solver))),
            hex""
        );

        assertEq(usdc.balanceOf(solver), bridgeData.minAmount);
    }

    function test_revert_LIFIIntent_wrong_receiver() external {
        bool isNative = false;
        vm.startPrank(USER_SENDER);
        usdc.approve(address(baseLiFiIntentEscrowFacet), bridgeData.minAmount);

        bridgeData.sendingAssetId = isNative ? address(0) : address(usdc);

        // Incorrectly modify the receiverAddress
        validLIFIIntentData.receiverAddress = bytes32(
            uint256(uint160(bridgeData.receiver)) + 1
        );

        vm.expectRevert(LiFiIntentEscrowFacet.ReceiverDoesNotMatch.selector);
        baseLiFiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrow{
            value: LibAsset.isNativeAsset(bridgeData.sendingAssetId)
                ? bridgeData.minAmount
                : 0
        }(bridgeData, validLIFIIntentData);
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrow{
                value: bridgeData.minAmount
            }(bridgeData, validLIFIIntentData);
        } else {
            lifiIntentEscrowFacet.startBridgeTokensViaLiFiIntentEscrow(
                bridgeData,
                validLIFIIntentData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrow{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validLIFIIntentData);
        } else {
            lifiIntentEscrowFacet.swapAndStartBridgeTokensViaLiFiIntentEscrow(
                bridgeData,
                swapData,
                validLIFIIntentData
            );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }
}
