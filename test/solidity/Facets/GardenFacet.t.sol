// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "src/Libraries/LibAllowList.sol";
import { ILiFi } from "src/Interfaces/ILiFi.sol";
import { GardenFacet } from "src/Facets/GardenFacet.sol";
import { InvalidConfig, InvalidReceiver } from "src/Errors/GenericErrors.sol";

// Stub GardenFacet Contract
contract TestGardenFacet is GardenFacet {
    constructor(address _htlcRegistry) GardenFacet(_htlcRegistry) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GardenFacetTest is TestBaseFacet {
    // Custom errors from GardenFacet
    error InvalidGardenData();
    error AssetNotSupported();
    // These values are for Mainnet from config/garden.json
    address internal constant USDC_HTLC =
        0x5fA58e4E89c85B8d678Ade970bD6afD4311aF17E;
    address internal constant WBTC_HTLC =
        0xD781a2abB3FCB9fC0D1Dd85697c237d06b75fe95;
    address internal constant ETH_HTLC =
        0xE413743B51f3cC8b3ac24addf50D18fa138cB0Bb;
    address internal constant WBTC_ADDRESS =
        0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant HTLC_REGISTRY =
        0x57291A5Cc9e08f63C72e9F6044770C69E62d0366;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    TestGardenFacet internal gardenFacet;
    ILiFi.BridgeData internal validBridgeData;
    GardenFacet.GardenData internal validGardenData;

    function setUp() public {
        customBlockNumberForForking = 23346384;
        initTestBase();

        gardenFacet = new TestGardenFacet(HTLC_REGISTRY);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = gardenFacet.startBridgeTokensViaGarden.selector;
        functionSelectors[1] = gardenFacet
            .swapAndStartBridgeTokensViaGarden
            .selector;
        functionSelectors[2] = gardenFacet.addDex.selector;
        functionSelectors[3] = gardenFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(gardenFacet), functionSelectors);

        gardenFacet = TestGardenFacet(address(diamond));

        gardenFacet.addDex(address(uniswap));
        gardenFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gardenFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        gardenFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        setFacetAddressInTestBase(address(gardenFacet), "GardenFacet");

        vm.makePersistent(address(gardenFacet));

        // adjust bridgeData
        bridgeData.bridge = "garden";
        bridgeData.destinationChainId = DSTCHAIN_ID;

        // produce valid GardenData
        validGardenData = GardenFacet.GardenData({
            redeemer: 0x1234567890123456789012345678901234567890, // Random address for redeemer
            refundAddress: USER_SENDER, // Address that can claim refund on source chain
            timelock: 1000, // Number of blocks after which refund is possible
            secretHash: keccak256(abi.encodePacked("test_secret")),
            nonEvmReceiver: bytes32(0)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            gardenFacet.startBridgeTokensViaGarden{
                value: bridgeData.minAmount
            }(bridgeData, validGardenData);
        } else {
            gardenFacet.startBridgeTokensViaGarden(
                bridgeData,
                validGardenData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            gardenFacet.swapAndStartBridgeTokensViaGarden{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validGardenData);
        } else {
            gardenFacet.swapAndStartBridgeTokensViaGarden(
                bridgeData,
                swapData,
                validGardenData
            );
        }
    }

    /// Edge Case Tests ///

    function testRevert_ConstructorWithZeroRegistry() public {
        vm.expectRevert(InvalidConfig.selector);

        new GardenFacet(address(0));
    }

    function testRevert_InvalidGardenDataZeroRedeemer() public {
        // Setup invalid garden data with zero redeemer
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: address(0),
                refundAddress: USER_SENDER,
                timelock: 1000, // Number of blocks for refund
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        // Mint tokens to user
        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, invalidGardenData);

        vm.stopPrank();
    }

    function testRevert_InvalidGardenDataZeroTimelock() public {
        // Setup invalid garden data with zero timelock
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 0, // Zero timelock (invalid)
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        // Mint tokens to user
        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, invalidGardenData);

        vm.stopPrank();
    }

    function testRevert_InvalidGardenDataZeroSecretHash() public {
        // Setup invalid garden data with zero secret hash
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 1000, // Number of blocks for refund
                secretHash: bytes32(0), // Zero secret hash
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        // Mint tokens to user
        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, invalidGardenData);

        vm.stopPrank();
    }

    function testRevert_AssetNotSupported() public {
        // Use an unsupported asset that's not registered in the registry
        address unsupportedAsset = address(0xDEADBEEF);
        bridgeData.sendingAssetId = unsupportedAsset;
        bridgeData.minAmount = 100 * 10 ** 8; // WBTC has 8 decimals

        vm.startPrank(USER_SENDER);

        vm.expectRevert(AssetNotSupported.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, validGardenData);

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroRedeemer() public {
        // Setup swap data
        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with zero redeemer
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: address(0),
                refundAddress: USER_SENDER,
                timelock: 1000, // Number of blocks for refund
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_DAI, USER_SENDER, swapData[0].fromAmount);
        dai.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidGardenData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroTimelock() public {
        // Setup swap data
        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with zero timelock
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 0, // Zero timelock (invalid)
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_DAI, USER_SENDER, swapData[0].fromAmount);
        dai.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidGardenData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroSecretHash() public {
        // Setup swap data
        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with zero secret hash
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 1000, // Number of blocks for refund
                secretHash: bytes32(0), // Zero secret hash
                nonEvmReceiver: bytes32(0)
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_DAI, USER_SENDER, swapData[0].fromAmount);
        dai.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidGardenData
        );

        vm.stopPrank();
    }

    // Positive edge case: Valid data with minimum timelock (1 block)
    function test_ValidDataWithMinimumTimelock() public {
        // Setup valid garden data with minimum timelock for immediate withdrawal
        GardenFacet.GardenData memory minTimelockData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 1, // Minimum valid timelock (1 block)
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        // Should not revert - minimum timelock is 1 block
        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, minTimelockData);

        vm.stopPrank();
    }

    // Positive edge case: Valid data with larger timelock
    function test_ValidDataWithLargerTimelock() public {
        // Setup valid garden data with larger timelock
        GardenFacet.GardenData memory largerTimelockData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 10000, // Larger timelock value
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        // Should not revert
        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, largerTimelockData);

        vm.stopPrank();
    }

    // Test all invalid parameters together
    function testRevert_AllInvalidParameters() public {
        // Setup garden data with all invalid parameters
        GardenFacet.GardenData memory allInvalidData = GardenFacet.GardenData({
            redeemer: address(0), // Invalid
            refundAddress: USER_SENDER,
            timelock: 0, // Invalid (zero timelock)
            secretHash: bytes32(0), // Invalid
            nonEvmReceiver: bytes32(0)
        });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, allInvalidData);

        vm.stopPrank();
    }

    function testRevert_InvalidRefundAddress() public {
        // Setup garden data with zero refund address
        GardenFacet.GardenData memory invalidRefundData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: address(0), // Invalid refund address
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, invalidRefundData);

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithInvalidRefundAddress() public {
        // Setup swap data
        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        // Setup garden data with zero refund address
        GardenFacet.GardenData memory invalidRefundData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: address(0), // Invalid refund address
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_DAI, USER_SENDER, swapData[0].fromAmount);
        dai.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidReceiver.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidRefundData
        );

        vm.stopPrank();
    }

    // Test demonstrating the fix for the vulnerability where destination address
    // was incorrectly used for source chain refund rights
    function test_RefundAddressVulnerabilityFixed() public {
        // This test demonstrates that with the fix, the refundAddress parameter
        // controls who can claim refunds on the source chain, NOT the bridgeData.receiver
        // which is meant for the destination chain

        // Setup a scenario similar to the vulnerability:
        // - bridgeData.receiver is set to a Gnosis Safe address that exists on destination
        // - This Safe has different owners on source vs destination chains
        // - With the fix, refundAddress determines who can refund, not receiver
        address gnosisSafeWallet = address(
            0x5Ae1216887b0dAd5a82451EFC5a6EC0A91473cA8
        );

        // Set up bridge data with the Safe address as receiver (destination chain)
        bridgeData.receiver = gnosisSafeWallet;
        bridgeData.destinationChainId = 10; // OP mainnet
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        // Create garden data with USER_SENDER as the refund address
        // This ensures only USER_SENDER can claim refunds, not the Safe address
        GardenFacet.GardenData memory secureGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER, // USER_SENDER controls refunds, not the Safe
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        // User approves and initiates bridge
        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        // This should succeed - USER_SENDER will be able to refund if needed
        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, secureGardenData);

        vm.stopPrank();

        // The key difference: refundAddress (USER_SENDER) controls refunds on source chain,
        // while bridgeData.receiver (gnosisSafeWallet) only matters on destination chain.
        // This prevents the attack where someone controlling the same address on source
        // chain could steal the refund.
    }

    function test_RefundAddressMustNotBeZero() public {
        // Test that refund address validation prevents using address(0)
        GardenFacet.GardenData memory invalidData = GardenFacet.GardenData({
            redeemer: 0x1234567890123456789012345678901234567890,
            refundAddress: address(0), // This should be rejected
            timelock: 1000,
            secretHash: keccak256(abi.encodePacked("test_secret")),
            nonEvmReceiver: bytes32(0)
        });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        // Should revert with InvalidReceiver error
        vm.expectRevert(InvalidReceiver.selector);
        gardenFacet.startBridgeTokensViaGarden(bridgeData, invalidData);

        vm.stopPrank();
    }

    function test_RefundAddressCanBeDifferentFromSender() public {
        // Test that refund address can be set to a different address than msg.sender
        // This is useful for contract wallets or when user wants a different refund recipient
        address alternativeRefundAddress = address(
            0xabCDEF1234567890ABcDEF1234567890aBCDeF12
        );

        GardenFacet.GardenData memory customRefundData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: alternativeRefundAddress, // Different from msg.sender
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: bytes32(0)
            });

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        // Should succeed with alternative refund address
        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, customRefundData);

        vm.stopPrank();
    }

    function test_CanBridgeToNonEVMChain() public {
        bytes32 btcReceiver = bytes32(
            uint256(
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
            )
        );

        GardenFacet.GardenData memory nonEvmGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: btcReceiver
            });

        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        bridgeData.destinationChainId = 20000000000001;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            btcReceiver
        );

        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, nonEvmGardenData);

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeToNonEVMChain() public {
        bytes32 btcReceiver = bytes32(
            uint256(
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
            )
        );

        GardenFacet.GardenData memory nonEvmGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                refundAddress: USER_SENDER,
                timelock: 1000,
                secretHash: keccak256(abi.encodePacked("test_secret")),
                nonEvmReceiver: btcReceiver
            });

        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        bridgeData.destinationChainId = 20000000000001;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_DAI, USER_SENDER, swapData[0].fromAmount);
        dai.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            btcReceiver
        );

        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            nonEvmGardenData
        );

        vm.stopPrank();
    }

    function test_DoesNotEmitNonEVMEventForEVMChain() public {
        GardenFacet.GardenData memory evmGardenData = GardenFacet.GardenData({
            redeemer: 0x1234567890123456789012345678901234567890,
            refundAddress: USER_SENDER,
            timelock: 1000,
            secretHash: keccak256(abi.encodePacked("test_secret")),
            nonEvmReceiver: bytes32(0)
        });

        bridgeData.receiver = address(
            0x5555555555555555555555555555555555555555
        );
        bridgeData.destinationChainId = DSTCHAIN_ID;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** usdc.decimals();

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);
        usdc.approve(address(gardenFacet), bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(gardenFacet));
        emit LiFiTransferStarted(bridgeData);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, evmGardenData);

        vm.stopPrank();
    }
}
