// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "src/Libraries/LibAllowList.sol";
import { ILiFi } from "src/Interfaces/ILiFi.sol";
import { GardenFacet } from "src/Facets/GardenFacet.sol";
import { InvalidConfig } from "src/Errors/GenericErrors.sol";

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
            timelock: 1000, // Number of blocks after which refund is possible
            secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 1000, // Number of blocks for refund
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 0, // Zero timelock (invalid)
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 1000, // Number of blocks for refund
                secretHash: bytes32(0) // Zero secret hash
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
                timelock: 1000, // Number of blocks for refund
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 0, // Zero timelock (invalid)
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 1000, // Number of blocks for refund
                secretHash: bytes32(0) // Zero secret hash
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
                timelock: 1, // Minimum valid timelock (1 block)
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
                timelock: 10000, // Larger timelock value
                secretHash: keccak256(abi.encodePacked("test_secret"))
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
            timelock: 0, // Invalid (zero timelock)
            secretHash: bytes32(0) // Invalid
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
}
