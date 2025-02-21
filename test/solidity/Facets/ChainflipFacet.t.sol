// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ChainflipFacet } from "lifi/Facets/ChainflipFacet.sol";
import { IChainflipVault } from "lifi/Interfaces/IChainflip.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InformationMismatch, CannotBridgeToSameNetwork } from "lifi/Errors/GenericErrors.sol";

// Stub ChainflipFacet Contract
contract TestChainflipFacet is ChainflipFacet {
    constructor(
        address _chainflipVault
    ) ChainflipFacet(IChainflipVault(_chainflipVault)) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ChainflipFacetTest is TestBaseFacet {
    ChainflipFacet.ChainflipData internal validChainflipData;
    TestChainflipFacet internal chainflipFacet;
    address internal CHAINFLIP_VAULT;
    LibSwap.SwapData[] internal dstSwapData;

    uint256 internal constant CHAIN_ID_ETHEREUM = 1;
    uint256 internal constant CHAIN_ID_ARBITRUM = 42161;
    uint256 internal constant CHAIN_ID_SOLANA = 1151111081099710;
    uint256 internal constant CHAIN_ID_BITCOIN = 20000000000001;

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        // Read chainflip vault address from config using the new helper
        CHAINFLIP_VAULT = getConfigAddressFromPath(
            "chainflip.json",
            ".mainnet.chainflipVault"
        );
        vm.label(CHAINFLIP_VAULT, "Chainflip Vault");
        console.log("Chainflip Vault Address:", CHAINFLIP_VAULT);

        chainflipFacet = new TestChainflipFacet(CHAINFLIP_VAULT);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = chainflipFacet
            .startBridgeTokensViaChainflip
            .selector;
        functionSelectors[1] = chainflipFacet
            .swapAndStartBridgeTokensViaChainflip
            .selector;
        functionSelectors[2] = chainflipFacet.addDex.selector;
        functionSelectors[3] = chainflipFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(chainflipFacet), functionSelectors);
        chainflipFacet = TestChainflipFacet(address(diamond));
        chainflipFacet.addDex(ADDRESS_UNISWAP);
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(chainflipFacet), "ChainflipFacet");

        // adjust bridgeData
        bridgeData.bridge = "chainflip";
        bridgeData.destinationChainId = 42161; // Arbitrum chain ID

        // Most properties are unused for normal bridging
        validChainflipData.dstToken = 7;
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            chainflipFacet.startBridgeTokensViaChainflip{
                value: bridgeData.minAmount
            }(bridgeData, validChainflipData);
        } else {
            chainflipFacet.startBridgeTokensViaChainflip(
                bridgeData,
                validChainflipData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validChainflipData);
        } else {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip(
                bridgeData,
                swapData,
                validChainflipData
            );
        }
    }

    function test_CanBridgeTokensToSolana()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_SOLANA;
        validChainflipData.dstToken = 6;
        validChainflipData.nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToBitcoin()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_BITCOIN;
        validChainflipData.dstToken = 6;
        validChainflipData.nonEVMReceiver = bytes32(
            abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
        );

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToEthereum()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        // Set source chain to Arbitrum for this test
        vm.chainId(CHAIN_ID_ARBITRUM);
        vm.roll(208460950); // Set specific block number for Arbitrum chain

        // Set destination to Ethereum
        bridgeData.destinationChainId = CHAIN_ID_ETHEREUM;
        validChainflipData.dstToken = 3; // USDC on Ethereum

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenUsingUnsupportedDestinationChain() public {
        // Set destination chain to Polygon (unsupported)
        bridgeData.destinationChainId = 137;

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(ChainflipFacet.UnsupportedChainflipChainId.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensWithDestinationCall()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(defaultNativeAmount)
        )
    {
        delete dstSwapData;
        dstSwapData.push(
            LibSwap.SwapData({
                callTo: address(0x123),
                approveTo: address(0x123),
                sendingAssetId: address(0),
                receivingAssetId: address(0),
                fromAmount: 0,
                callData: "0x123456",
                requiresDeposit: false
            })
        );

        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        bridgeData.hasDestinationCall = true;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        validChainflipData.dstToken = 7;
        validChainflipData.dstCallReceiver = address(0x123);
        validChainflipData.dstCallSwapData = dstSwapData;
        validChainflipData.gasAmount = 100000;

        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensWithoutDestinationCall()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(defaultNativeAmount)
        )
    {
        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        bridgeData.hasDestinationCall = false;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        validChainflipData.dstToken = 7;

        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testRevert_WhenDestinationCallFlagMismatchesMessage() public {
        // Case 1: hasDestinationCall is true but message is empty
        bridgeData.hasDestinationCall = true;
        validChainflipData.dstCallSwapData = dstSwapData;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);
        initiateBridgeTxWithFacet(false);

        // Case 2: hasDestinationCall is false but message is not empty
        bridgeData.hasDestinationCall = false;
        delete dstSwapData;
        dstSwapData.push(
            LibSwap.SwapData({
                callTo: address(0x123),
                approveTo: address(0x123),
                sendingAssetId: address(0),
                receivingAssetId: address(0),
                fromAmount: 0,
                callData: "0x123456",
                requiresDeposit: false
            })
        );
        validChainflipData.dstCallSwapData = dstSwapData;

        vm.expectRevert(InformationMismatch.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_ChainIdMappings() public {
        // Set source chain to Arbitrum for these tests
        vm.chainId(CHAIN_ID_ARBITRUM);
        vm.roll(208460950); // Set specific block number for Arbitrum chain

        vm.startPrank(USER_SENDER);

        // Test Ethereum mapping
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = CHAIN_ID_ETHEREUM;
        initiateBridgeTxWithFacet(false);

        // Test Arbitrum mapping (should fail as same network)
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        vm.expectRevert(CannotBridgeToSameNetwork.selector);
        initiateBridgeTxWithFacet(false);

        // Test Solana mapping
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = CHAIN_ID_SOLANA;
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        validChainflipData.nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        initiateBridgeTxWithFacet(false);

        // Test Bitcoin mapping
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = CHAIN_ID_BITCOIN;
        validChainflipData.nonEVMReceiver = bytes32(
            abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
        );
        initiateBridgeTxWithFacet(false);

        // Test invalid chain ID
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = 137; // Polygon
        vm.expectRevert(ChainflipFacet.UnsupportedChainflipChainId.selector);
        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_WhenUsingEmptyNonEVMAddress() public {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_SOLANA;
        validChainflipData.dstToken = 6;
        validChainflipData.nonEVMReceiver = bytes32(0); // Empty address should fail

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(ChainflipFacet.EmptyNonEvmAddress.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensWithDestinationCall()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        bridgeData.hasDestinationCall = true;

        delete dstSwapData;
        dstSwapData.push(
            LibSwap.SwapData({
                callTo: address(0x123),
                approveTo: address(0x123),
                sendingAssetId: address(0),
                receivingAssetId: address(0),
                fromAmount: 0,
                callData: "0x123456",
                requiresDeposit: false
            })
        );

        validChainflipData.dstToken = 7;
        validChainflipData.dstCallReceiver = address(0x123);
        validChainflipData.dstCallSwapData = dstSwapData;
        validChainflipData.gasAmount = 100000;

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNonEVMAddressWithEVMReceiver() public {
        // Set source chain to Arbitrum for this test
        vm.chainId(CHAIN_ID_ARBITRUM);
        vm.roll(208460950); // Set specific block number for Arbitrum chain

        // Try to use nonEVMReceiver with an EVM address
        bridgeData.receiver = USER_RECEIVER; // Use EVM address
        bridgeData.destinationChainId = CHAIN_ID_ETHEREUM;
        validChainflipData.dstToken = 6;
        validChainflipData.nonEVMReceiver = bytes32(
            abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Should proceed normally since nonEVMReceiver is ignored for EVM addresses
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenDestinationCallTrueButSwapDataEmpty() public {
        // Set up bridge data with destination call flag true
        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        bridgeData.hasDestinationCall = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // Set up chainflip data but leave dstCallSwapData empty
        validChainflipData.dstToken = 7;
        validChainflipData.dstCallReceiver = address(0x123);
        validChainflipData.gasAmount = 100000;
        // Deliberately not setting dstCallSwapData

        vm.startPrank(USER_SENDER);

        // Approve spending
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect revert with InformationMismatch
        vm.expectRevert(InformationMismatch.selector);
        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }
}
