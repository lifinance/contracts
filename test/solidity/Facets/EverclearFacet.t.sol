// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { MessageHashUtils } from "src/Utils/MessageHashUtils.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { EverclearFacet } from "lifi/Facets/EverclearFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { IEverclearFeeAdapter } from "lifi/Interfaces/IEverclearFeeAdapter.sol";
import { InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";

// Stub EverclearFacet Contract
contract TestEverclearFacet is EverclearFacet {
    constructor(address _example) EverclearFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EverclearFacetTest is TestBaseFacet {
    using MessageHashUtils for bytes32;

    EverclearFacet.EverclearData internal validEverclearData;
    TestEverclearFacet internal everclearFacet;
    IEverclearFeeAdapter internal feeAdapter =
        IEverclearFeeAdapter(
            address(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75)
        );

    uint256 internal signerPrivateKey;
    address internal signerAddress;

    // values defaultUSDCAmount and fee taken from quote data where totalFeeBps is 0.6509
    // quote data from:
    //   const quoteResp = await fetch(
    //     `https://api.everclear.org/routes/quotes`,
    //     {
    //       method: 'POST',
    //       headers: { 'Content-Type': 'application/json' },
    //       body: JSON.stringify({
    //         "origin": "42161",
    //         "destinations": [
    //           "10"
    //         ],
    //         "inputAsset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    //         "amount": "100000000",
    //         "to": "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62"
    //       })
    //     }
    //   )
    uint256 internal usdCAmountToSend = 99934901; // its defaultUSDCAmount - fee (100000000 - 65099)
    uint256 internal fee = 65099;

    function setUp() public {
        customBlockNumberForForking = 23433940;
        initTestBase();

        signerPrivateKey = 0x1234;
        signerAddress = vm.addr(signerPrivateKey);

        everclearFacet = new TestEverclearFacet(address(feeAdapter));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = everclearFacet
            .startBridgeTokensViaEverclear
            .selector;
        functionSelectors[1] = everclearFacet
            .swapAndStartBridgeTokensViaEverclear
            .selector;
        functionSelectors[2] = everclearFacet.addDex.selector;
        functionSelectors[3] = everclearFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(everclearFacet), functionSelectors);
        everclearFacet = TestEverclearFacet(address(diamond));
        everclearFacet.addDex(ADDRESS_UNISWAP);
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(everclearFacet), "EverclearFacet");

        uint256 deadline = block.timestamp + 10000;

        deal(ADDRESS_USDC, address(USER_SENDER), usdCAmountToSend + fee);

        vm.startPrank(feeAdapter.owner());
        feeAdapter.updateFeeSigner(signerAddress);
        vm.stopPrank();

        // adjust bridgeData
        bridgeData.bridge = "everclear";
        bridgeData.destinationChainId = 42161;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = usdCAmountToSend + fee;

        // 3. Hash the data that needs to be signed
        // The FeeAdapter signs: abi.encode(_tokenFee, _nativeFee, _inputAsset, _deadline)
        bytes32 messageHash = keccak256(
            abi.encode(fee, 0, bridgeData.sendingAssetId, deadline)
        );
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        // 4. Sign the hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            ethSignedMessageHash
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        // produce valid EverclearData
        validEverclearData = EverclearFacet.EverclearData({
            receiverAddress: bytes32(uint256(uint160(USER_RECEIVER))),
            outputAsset: bytes32(uint256(uint160(ADDRESS_USDC_BASE))),
            maxFee: 0,
            ttl: 0,
            data: "",
            fee: fee,
            deadline: deadline,
            sig: signature
        });
    }

    // All facet test files inherit from `utils/TestBaseFacet.sol` and require the following method overrides:
    // - function initiateBridgeTxWithFacet(bool isNative)
    // - function initiateSwapAndBridgeTxWithFacet(bool isNative)
    //
    // These methods are used to run the following tests which must pass:
    // - testBase_CanBridgeNativeTokens()
    // - testBase_CanBridgeTokens()
    // - testBase_CanBridgeTokens_fuzzed(uint256)
    // - testBase_CanSwapAndBridgeNativeTokens()
    // - testBase_CanSwapAndBridgeTokens()
    // - testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
    // - testBase_Revert_BridgeToSameChainId()
    // - testBase_Revert_BridgeWithInvalidAmount()
    // - testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    // - testBase_Revert_BridgeWithInvalidReceiverAddress()
    // - testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
    // - testBase_Revert_CallerHasInsufficientFunds()
    // - testBase_Revert_SwapAndBridgeToSameChainId()
    // - testBase_Revert_SwapAndBridgeWithInvalidAmount()
    // - testBase_Revert_SwapAndBridgeWithInvalidSwapData()
    //
    // In some cases it doesn't make sense to have all tests. For example the bridge may not support native tokens.
    // In that case you can override the test method and leave it empty. For example:
    //
    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeTokens()
        public
        virtual
        override
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

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

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanBridgeTokens()
        public
        virtual
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(99934901 + validEverclearData.fee) // 99934901 is defaultUSDCAmount - fee (100000000 - 65099)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(
            address(everclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(everclearFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(
        uint256 amount
    ) public virtual override {
        vm.assume(amount > validEverclearData.fee + 1 && amount < 10000000);
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = amount + validEverclearData.fee;

        // approval
        usdc.approve(address(everclearFacet), amount + validEverclearData.fee);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(everclearFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            everclearFacet.startBridgeTokensViaEverclear{
                value: bridgeData.minAmount
            }(bridgeData, validEverclearData);
        } else {
            everclearFacet.startBridgeTokensViaEverclear(
                bridgeData,
                validEverclearData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            everclearFacet.swapAndStartBridgeTokensViaEverclear{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validEverclearData);
        } else {
            everclearFacet.swapAndStartBridgeTokensViaEverclear(
                bridgeData,
                swapData,
                validEverclearData
            );
        }
    }

    function testRevert_InvalidOutputAsset() public {
        vm.startPrank(USER_SENDER);

        // Create invalid everclear data with outputAsset as bytes32(0)
        EverclearFacet.EverclearData
            memory invalidEverclearData = validEverclearData;
        invalidEverclearData.outputAsset = bytes32(0);

        // approval
        usdc.approve(
            address(everclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        vm.expectRevert(InvalidCallData.selector);

        everclearFacet.startBridgeTokensViaEverclear(
            bridgeData,
            invalidEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_InvalidNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        // Set bridgeData receiver to NON_EVM_ADDRESS
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Create invalid everclear data with receiverAddress as bytes32(0)
        EverclearFacet.EverclearData
            memory invalidEverclearData = validEverclearData;
        invalidEverclearData.receiverAddress = bytes32(0);

        // approval
        usdc.approve(
            address(everclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        everclearFacet.startBridgeTokensViaEverclear(
            bridgeData,
            invalidEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_EVMReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        // Set bridgeData receiver to a different address than everclearData.receiverAddress
        address differentReceiver = address(
            0x1234567890123456789012345678901234567890
        );
        bridgeData.receiver = differentReceiver;

        // Keep validEverclearData.receiverAddress as USER_RECEIVER (different from bridgeData.receiver)
        // validEverclearData.receiverAddress is already set to USER_RECEIVER in setUp()

        // approval
        usdc.approve(
            address(everclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        vm.expectRevert(InvalidReceiver.selector);

        everclearFacet.startBridgeTokensViaEverclear(
            bridgeData,
            validEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeInvalidOutputAsset() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Create invalid everclear data with outputAsset as bytes32(0)
        EverclearFacet.EverclearData
            memory invalidEverclearData = validEverclearData;
        invalidEverclearData.outputAsset = bytes32(0);

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        everclearFacet.swapAndStartBridgeTokensViaEverclear(
            bridgeData,
            swapData,
            invalidEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeInvalidNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Create invalid everclear data with receiverAddress as bytes32(0)
        EverclearFacet.EverclearData
            memory invalidEverclearData = validEverclearData;
        invalidEverclearData.receiverAddress = bytes32(0);

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        everclearFacet.swapAndStartBridgeTokensViaEverclear(
            bridgeData,
            swapData,
            invalidEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeEVMReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // Set bridgeData receiver to a different address than everclearData.receiverAddress
        address differentReceiver = address(
            0x1234567890123456789012345678901234567890
        );
        bridgeData.receiver = differentReceiver;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // Keep validEverclearData.receiverAddress as USER_RECEIVER (different from bridgeData.receiver)

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidReceiver.selector);

        everclearFacet.swapAndStartBridgeTokensViaEverclear(
            bridgeData,
            swapData,
            validEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_ConstructorInvalidFeeAdapter() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestEverclearFacet(address(0));
    }
}
