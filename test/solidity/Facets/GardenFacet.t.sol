// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { GardenFacet } from "lifi/Facets/GardenFacet.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Mock Garden Registry Contract
contract MockGardenRegistry {
    mapping(address => address) private _htlcs;

    function setHtlc(address assetId, address htlcAddress) external {
        _htlcs[assetId] = htlcAddress;
    }

    function htlcs(address assetId) external view returns (address) {
        return _htlcs[assetId];
    }
}

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
    error InvalidRegistry();
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
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    MockGardenRegistry internal mockRegistry;
    TestGardenFacet internal gardenFacet;
    ILiFi.BridgeData internal validBridgeData;
    GardenFacet.GardenData internal validGardenData;

    function setUp() public {
        customBlockNumberForForking = 23238500;
        initTestBase();

        // Setup mock registry
        mockRegistry = new MockGardenRegistry();
        mockRegistry.setHtlc(ADDRESS_USDC, USDC_HTLC);
        mockRegistry.setHtlc(WBTC_ADDRESS, WBTC_HTLC);
        mockRegistry.setHtlc(address(0), ETH_HTLC); // For native ETH
        mockRegistry.setHtlc(ADDRESS_DAI, USDC_HTLC); // Use USDC HTLC for DAI in tests

        gardenFacet = new TestGardenFacet(address(mockRegistry));
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
            timelock: block.number + 1000,
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
        vm.expectRevert(InvalidRegistry.selector);

        new GardenFacet(address(0));
    }

    function testRevert_InvalidGardenDataZeroRedeemer() public {
        // Setup invalid garden data with zero redeemer
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: address(0),
                timelock: block.number + 1000,
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

    function testRevert_InvalidGardenDataPastTimelock() public {
        // Setup invalid garden data with past timelock
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                timelock: block.number - 1, // Past timelock
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

    function testRevert_InvalidGardenDataCurrentBlockTimelock() public {
        // Setup invalid garden data with current block as timelock
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                timelock: block.number, // Current block (should be future)
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
                timelock: block.number + 1000,
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
        // Use WBTC which is set in the registry but we'll use a different token address
        // that's not registered
        address unsupportedAsset = address(0xDEADBEEF);
        bridgeData.sendingAssetId = unsupportedAsset;
        bridgeData.minAmount = 100 * 10 ** 8; // WBTC has 8 decimals

        vm.startPrank(USER_SENDER);

        // Mock the token balance and approval since it's not a real token
        vm.mockCall(
            unsupportedAsset,
            abi.encodeWithSelector(IERC20.balanceOf.selector, USER_SENDER),
            abi.encode(bridgeData.minAmount)
        );

        vm.mockCall(
            unsupportedAsset,
            abi.encodeWithSelector(
                IERC20.allowance.selector,
                USER_SENDER,
                address(gardenFacet)
            ),
            abi.encode(0)
        );

        vm.mockCall(
            unsupportedAsset,
            abi.encodeWithSelector(
                IERC20.approve.selector,
                address(gardenFacet),
                type(uint256).max
            ),
            abi.encode(true)
        );

        vm.mockCall(
            unsupportedAsset,
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                USER_SENDER,
                address(gardenFacet),
                bridgeData.minAmount
            ),
            abi.encode(true)
        );

        vm.expectRevert(AssetNotSupported.selector);

        gardenFacet.startBridgeTokensViaGarden(bridgeData, validGardenData);

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroRedeemer() public {
        // Setup swap data
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = 100 * 10 ** dai.decimals();

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: ADDRESS_DAI,
                fromAmount: 110 * 10 ** usdc.decimals(), // Approximate amount
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    110 * 10 ** usdc.decimals(),
                    amountOut,
                    path,
                    address(gardenFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = amountOut;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with zero redeemer
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: address(0),
                timelock: block.number + 1000,
                secretHash: keccak256(abi.encodePacked("test_secret"))
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, swapData[0].fromAmount);
        usdc.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidGardenData
        );

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithPastTimelock() public {
        // Setup swap data
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = 100 * 10 ** dai.decimals();

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: ADDRESS_DAI,
                fromAmount: 110 * 10 ** usdc.decimals(),
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    110 * 10 ** usdc.decimals(),
                    amountOut,
                    path,
                    address(gardenFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = amountOut;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with past timelock
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                timelock: block.number - 100, // Past timelock
                secretHash: keccak256(abi.encodePacked("test_secret"))
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, swapData[0].fromAmount);
        usdc.approve(address(gardenFacet), swapData[0].fromAmount);

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
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = 100 * 10 ** dai.decimals();

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: ADDRESS_DAI,
                fromAmount: 110 * 10 ** usdc.decimals(),
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    110 * 10 ** usdc.decimals(),
                    amountOut,
                    path,
                    address(gardenFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = amountOut;
        bridgeData.hasSourceSwaps = true;

        // Setup invalid garden data with zero secret hash
        GardenFacet.GardenData memory invalidGardenData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                timelock: block.number + 1000,
                secretHash: bytes32(0) // Zero secret hash
            });

        vm.startPrank(USER_SENDER);

        deal(ADDRESS_USDC, USER_SENDER, swapData[0].fromAmount);
        usdc.approve(address(gardenFacet), swapData[0].fromAmount);

        vm.expectRevert(InvalidGardenData.selector);

        gardenFacet.swapAndStartBridgeTokensViaGarden(
            bridgeData,
            swapData,
            invalidGardenData
        );

        vm.stopPrank();
    }

    function testRevert_NativeAssetNotSupported() public {
        // Remove native ETH support from registry
        mockRegistry.setHtlc(address(0), address(0));

        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.startPrank(USER_SENDER);

        vm.deal(USER_SENDER, bridgeData.minAmount);

        vm.expectRevert(AssetNotSupported.selector);

        gardenFacet.startBridgeTokensViaGarden{ value: bridgeData.minAmount }(
            bridgeData,
            validGardenData
        );

        vm.stopPrank();
    }

    // Positive edge case: Valid data with minimum future timelock
    function test_ValidDataWithMinimumFutureTimelock() public {
        // Setup valid garden data with minimum future timelock (next block)
        GardenFacet.GardenData memory minTimelockData = GardenFacet
            .GardenData({
                redeemer: 0x1234567890123456789012345678901234567890,
                timelock: block.number + 1, // Minimum valid future timelock
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

        gardenFacet.startBridgeTokensViaGarden(bridgeData, minTimelockData);

        vm.stopPrank();
    }

    // Test all invalid parameters together
    function testRevert_AllInvalidParameters() public {
        // Setup garden data with all invalid parameters
        GardenFacet.GardenData memory allInvalidData = GardenFacet.GardenData({
            redeemer: address(0), // Invalid
            timelock: block.number - 1, // Invalid
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
