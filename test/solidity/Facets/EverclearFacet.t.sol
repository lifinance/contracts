// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { EverclearFacet } from "lifi/Facets/EverclearFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { IEverclearFeeAdapter } from "lifi/Interfaces/IEverclearFeeAdapter.sol";
import { MockEverclearFeeAdapter } from "../utils/MockEverclearFeeAdapter.sol";
import { InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver, NativeAssetNotSupported } from "lifi/Errors/GenericErrors.sol";

// Stub EverclearFacet Contract
contract TestEverclearFacet is EverclearFacet {
    constructor(address _feeAdapter) EverclearFacet(_feeAdapter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EverclearFacetTest is TestBaseFacet {
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

    /// @dev Returns the keccak256 digest of an ERC-191 signed data with version `0x45` (`personal_sign` messages).
    /// Copied from OpenZeppelin's MessageHashUtils to avoid dependency
    function toEthSignedMessageHash(
        bytes32 messageHash
    ) internal pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            mstore(0x00, "\x19Ethereum Signed Message:\n32") // 32 is the bytes-length of messageHash
            mstore(0x1c, messageHash) // 0x1c (28) is the length of the prefix
            digest := keccak256(0x00, 0x3c) // 0x3c is the length of the prefix (0x1c) + messageHash (0x20)
        }
    }

    function setUp() public {
        customBlockNumberForForking = 23541361;
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
        bytes32 ethSignedMessageHash = toEthSignedMessageHash(messageHash);

        // 4. Sign the hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            ethSignedMessageHash
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        // produce valid EverclearData
        validEverclearData = EverclearFacet.EverclearData({
            receiverAddress: bytes32(uint256(uint160(USER_RECEIVER))),
            nativeFee: 0,
            outputAsset: bytes32(uint256(uint160(ADDRESS_USDC_BASE))),
            maxFee: 0,
            ttl: 0,
            data: "",
            fee: fee,
            deadline: deadline,
            sig: signature
        });
    }

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

    function test_CanBridgeTokensToNonEVMChain()
        public
        virtual
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

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validEverclearData.receiverAddress = bytes32(
            uint256(uint160(USER_RECEIVER))
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(everclearFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            validEverclearData.receiverAddress
        );

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

        // create invalid everclear data with outputAsset as bytes32(0)
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

    function testRevert_BridgeToNonEVMChainWithInvalidReceiverAddress()
        public
    {
        vm.startPrank(USER_SENDER);

        // set bridgeData receiver to NON_EVM_ADDRESS
        bridgeData.receiver = NON_EVM_ADDRESS;

        // create invalid everclear data with receiverAddress as bytes32(0)
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

        // set bridgeData receiver to a different address than everclearData.receiverAddress
        address differentReceiver = address(
            0x1234567890123456789012345678901234567890
        );
        bridgeData.receiver = differentReceiver;

        // keep validEverclearData.receiverAddress as USER_RECEIVER (different from bridgeData.receiver)
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

        // create invalid everclear data with outputAsset as bytes32(0)
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

        // create invalid everclear data with receiverAddress as bytes32(0)
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

        // set bridgeData receiver to a different address than everclearData.receiverAddress
        address differentReceiver = address(
            0x1234567890123456789012345678901234567890
        );
        bridgeData.receiver = differentReceiver;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // keep validEverclearData.receiverAddress as USER_RECEIVER (different from bridgeData.receiver)

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

    function testRevert_StartBridgeWithNativeAsset() public {
        vm.startPrank(USER_SENDER);

        // Create bridge data with native asset (address(0))
        ILiFi.BridgeData memory nativeBridgeData = bridgeData;
        nativeBridgeData.sendingAssetId = address(0); // Native asset

        vm.expectRevert(NativeAssetNotSupported.selector);

        everclearFacet.startBridgeTokensViaEverclear{
            value: nativeBridgeData.minAmount
        }(nativeBridgeData, validEverclearData);

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithNativeAssetOutput() public {
        vm.startPrank(USER_SENDER);

        // Create bridge data with native asset as the final output
        ILiFi.BridgeData memory nativeBridgeData = bridgeData;
        nativeBridgeData.hasSourceSwaps = true;
        nativeBridgeData.sendingAssetId = address(0); // Native asset as final output after swap

        // Create swap data that would output native asset
        LibSwap.SwapData[] memory nativeSwapData = new LibSwap.SwapData[](1);
        nativeSwapData[0] = LibSwap.SwapData({
            callTo: ADDRESS_UNISWAP,
            approveTo: ADDRESS_UNISWAP,
            sendingAssetId: ADDRESS_DAI,
            receivingAssetId: address(0), // Native asset
            fromAmount: defaultDAIAmount,
            callData: abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                defaultDAIAmount,
                0,
                getPathDAItoETH(),
                address(everclearFacet),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // Approve DAI for the swap
        dai.approve(address(everclearFacet), defaultDAIAmount);

        vm.expectRevert(NativeAssetNotSupported.selector);

        everclearFacet.swapAndStartBridgeTokensViaEverclear(
            nativeBridgeData,
            nativeSwapData,
            validEverclearData
        );

        vm.stopPrank();
    }

    function testRevert_StartBridgeWithNativeAssetZeroValue() public {
        vm.startPrank(USER_SENDER);

        // Create bridge data with native asset but send zero value
        ILiFi.BridgeData memory nativeBridgeData = bridgeData;
        nativeBridgeData.sendingAssetId = address(0); // Native asset
        nativeBridgeData.minAmount = 1 ether;

        // Don't send any ETH value, should revert with NativeAssetNotSupported before checking value
        vm.expectRevert(NativeAssetNotSupported.selector);

        everclearFacet.startBridgeTokensViaEverclear(
            nativeBridgeData,
            validEverclearData
        );

        vm.stopPrank();
    }

    function getPathDAItoETH() internal view returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;
        return path;
    }

    function getPathDAItoUSDC() internal view returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;
        return path;
    }

    function test_CanBridgeTokensWithNativeFee()
        public
        virtual
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(usdCAmountToSend + validEverclearData.fee)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        // Deploy mock fee adapter that requires native fees
        MockEverclearFeeAdapter mockFeeAdapter = new MockEverclearFeeAdapter(
            address(this), // owner
            signerAddress // fee signer
        );

        // Deploy new facet with mock adapter
        TestEverclearFacet mockEverclearFacet = new TestEverclearFacet(
            address(mockFeeAdapter)
        );

        vm.startPrank(USER_SENDER);

        uint256 nativeFee = 0.01 ether;
        uint256 deadline = block.timestamp + 10000;

        // Create signature with native fee
        bytes32 messageHash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        bytes32 ethSignedMessageHash = toEthSignedMessageHash(messageHash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            ethSignedMessageHash
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        // Update everclear data with native fee
        EverclearFacet.EverclearData
            memory everclearDataWithNativeFee = validEverclearData;
        everclearDataWithNativeFee.nativeFee = nativeFee;
        everclearDataWithNativeFee.deadline = deadline;
        everclearDataWithNativeFee.sig = signature;

        // approval
        usdc.approve(
            address(mockEverclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        // Give USER_SENDER some ETH for native fee
        vm.deal(USER_SENDER, nativeFee + 1 ether);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(mockEverclearFacet));
        emit LiFiTransferStarted(bridgeData);

        // Call with native fee
        mockEverclearFacet.startBridgeTokensViaEverclear{ value: nativeFee }(
            bridgeData,
            everclearDataWithNativeFee
        );

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensWithNativeFee() public virtual {
        address mockAdapter = address(
            new MockEverclearFeeAdapter(address(this), signerAddress)
        );
        address mockFacet = address(new TestEverclearFacet(mockAdapter));

        TestEverclearFacet(mockFacet).addDex(ADDRESS_UNISWAP);
        TestEverclearFacet(mockFacet).setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;

        uint256 nativeFee = 0.02 ether;
        uint256 deadline = block.timestamp + 10000;

        // create signature
        bytes32 hash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            toEthSignedMessageHash(hash)
        );

        // update data
        EverclearFacet.EverclearData memory data = validEverclearData;
        data.nativeFee = nativeFee;
        data.deadline = deadline;
        data.sig = abi.encodePacked(r, s, v);

        // get swap amount and create swap data
        uint256 swapAmount = uniswap.getAmountsIn(
            bridgeData.minAmount,
            getPathDAItoUSDC()
        )[0];
        LibSwap.SwapData[] memory swaps = _createSwapData(
            swapAmount,
            mockFacet
        );

        dai.approve(mockFacet, swapAmount);
        vm.deal(USER_SENDER, nativeFee + 1 ether);

        vm.expectEmit(true, true, true, true, mockFacet);
        emit LiFiTransferStarted(bridgeData);

        TestEverclearFacet(mockFacet).swapAndStartBridgeTokensViaEverclear{
            value: nativeFee
        }(bridgeData, swaps, data);
        vm.stopPrank();
    }

    function _createSwapData(
        uint256 swapAmount,
        address mockFacet
    ) internal view returns (LibSwap.SwapData[] memory) {
        LibSwap.SwapData[] memory swaps = new LibSwap.SwapData[](1);
        swaps[0] = LibSwap.SwapData({
            callTo: ADDRESS_UNISWAP,
            approveTo: ADDRESS_UNISWAP,
            sendingAssetId: ADDRESS_DAI,
            receivingAssetId: ADDRESS_USDC,
            fromAmount: swapAmount,
            callData: abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swapAmount,
                bridgeData.minAmount,
                getPathDAItoUSDC(),
                mockFacet,
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });
        return swaps;
    }

    function test_CanBridgeTokensToNonEVMChainWithNativeFee()
        public
        virtual
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(usdCAmountToSend + validEverclearData.fee)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        // deploy mock fee adapter that requires native fees
        MockEverclearFeeAdapter mockFeeAdapter = new MockEverclearFeeAdapter(
            address(this), // owner
            signerAddress // fee signer
        );

        // deploy new facet with mock adapter
        TestEverclearFacet mockEverclearFacet = new TestEverclearFacet(
            address(mockFeeAdapter)
        );

        vm.startPrank(USER_SENDER);

        uint256 nativeFee = 0.015 ether;
        uint256 deadline = block.timestamp + 10000;

        // create signature with native fee
        bytes32 messageHash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        bytes32 ethSignedMessageHash = toEthSignedMessageHash(messageHash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            ethSignedMessageHash
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        // update everclear data with native fee
        EverclearFacet.EverclearData
            memory everclearDataWithNativeFee = validEverclearData;
        everclearDataWithNativeFee.nativeFee = nativeFee;
        everclearDataWithNativeFee.deadline = deadline;
        everclearDataWithNativeFee.sig = signature;

        // approval
        usdc.approve(
            address(mockEverclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        // set up for non-EVM chain
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;
        everclearDataWithNativeFee.receiverAddress = bytes32(
            uint256(uint160(USER_RECEIVER))
        );

        // give USER_SENDER some ETH for native fee
        vm.deal(USER_SENDER, nativeFee + 1 ether);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(mockEverclearFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            everclearDataWithNativeFee.receiverAddress
        );

        vm.expectEmit(true, true, true, true, address(mockEverclearFacet));
        emit LiFiTransferStarted(bridgeData);

        // Call with native fee
        mockEverclearFacet.startBridgeTokensViaEverclear{ value: nativeFee }(
            bridgeData,
            everclearDataWithNativeFee
        );

        vm.stopPrank();
    }

    function testRevert_InsufficientNativeFee() public {
        // deploy mock fee adapter that requires native fees
        MockEverclearFeeAdapter mockFeeAdapter = new MockEverclearFeeAdapter(
            address(this), // owner
            signerAddress // fee signer
        );

        // deploy new facet with mock adapter
        TestEverclearFacet mockEverclearFacet = new TestEverclearFacet(
            address(mockFeeAdapter)
        );

        vm.startPrank(USER_SENDER);

        uint256 nativeFee = 0.01 ether;
        uint256 deadline = block.timestamp + 10000;

        // create signature with native fee
        bytes32 messageHash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        bytes32 ethSignedMessageHash = toEthSignedMessageHash(messageHash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            ethSignedMessageHash
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        // update everclear data with native fee
        EverclearFacet.EverclearData
            memory everclearDataWithNativeFee = validEverclearData;
        everclearDataWithNativeFee.nativeFee = nativeFee;
        everclearDataWithNativeFee.deadline = deadline;
        everclearDataWithNativeFee.sig = signature;

        // approval
        usdc.approve(
            address(mockEverclearFacet),
            usdCAmountToSend + validEverclearData.fee
        );

        // give USER_SENDER some ETH but send insufficient amount
        vm.deal(USER_SENDER, nativeFee + 1 ether);

        vm.expectRevert(); // should revert due to insufficient native fee
        // call with insufficient native fee (send less than required)
        mockEverclearFacet.startBridgeTokensViaEverclear{
            value: nativeFee - 1
        }(bridgeData, everclearDataWithNativeFee);

        vm.stopPrank();
    }

    function test_ExcessNativeFeeGetsRefunded() public {
        address mockAdapter = address(
            new MockEverclearFeeAdapter(address(this), signerAddress)
        );
        address mockFacet = address(new TestEverclearFacet(mockAdapter));

        uint256 nativeFee = 0.01 ether;
        uint256 totalSent = nativeFee + 0.005 ether; // Send excess
        uint256 deadline = block.timestamp + 10000;

        vm.startPrank(USER_SENDER);

        // create signature
        bytes32 hash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            toEthSignedMessageHash(hash)
        );

        // update data
        EverclearFacet.EverclearData memory data = validEverclearData;
        data.nativeFee = nativeFee;
        data.deadline = deadline;
        data.sig = abi.encodePacked(r, s, v);

        // execute test
        usdc.approve(mockFacet, usdCAmountToSend + validEverclearData.fee);
        vm.deal(USER_SENDER, totalSent + 1 ether);

        uint256 balanceBefore = USER_SENDER.balance;
        TestEverclearFacet(mockFacet).startBridgeTokensViaEverclear{
            value: totalSent
        }(bridgeData, data);
        uint256 balanceAfter = USER_SENDER.balance;

        assertEq(
            balanceBefore - balanceAfter,
            nativeFee,
            "Excess native fee should be refunded"
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeInsufficientNativeFee() public {
        address mockAdapter = address(
            new MockEverclearFeeAdapter(address(this), signerAddress)
        );
        address mockFacet = address(new TestEverclearFacet(mockAdapter));

        TestEverclearFacet(mockFacet).addDex(ADDRESS_UNISWAP);
        TestEverclearFacet(mockFacet).setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;

        uint256 nativeFee = 0.02 ether;
        uint256 deadline = block.timestamp + 10000;

        // create signature
        bytes32 hash = keccak256(
            abi.encode(fee, nativeFee, bridgeData.sendingAssetId, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPrivateKey,
            toEthSignedMessageHash(hash)
        );

        // update data
        EverclearFacet.EverclearData memory data = validEverclearData;
        data.nativeFee = nativeFee;
        data.deadline = deadline;
        data.sig = abi.encodePacked(r, s, v);

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(mockFacet, swapData[0].fromAmount);
        vm.deal(USER_SENDER, nativeFee + 1 ether);

        vm.expectRevert();
        TestEverclearFacet(mockFacet).swapAndStartBridgeTokensViaEverclear{
            value: nativeFee - 1
        }(bridgeData, swapData, data);
        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeUnsupportedEverclearChainId() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData for swap and bridge
        bridgeData.hasSourceSwaps = true;
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON; // another unsupported non-EVM chain

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // set a valid receiverAddress for non-EVM chain
        EverclearFacet.EverclearData
            memory everclearDataWithUnsupportedChain = validEverclearData;
        everclearDataWithUnsupportedChain.receiverAddress = bytes32(
            uint256(uint160(USER_RECEIVER))
        );

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(EverclearFacet.UnsupportedEverclearChainId.selector);

        everclearFacet.swapAndStartBridgeTokensViaEverclear(
            bridgeData,
            swapData,
            everclearDataWithUnsupportedChain
        );

        vm.stopPrank();
    }
}
