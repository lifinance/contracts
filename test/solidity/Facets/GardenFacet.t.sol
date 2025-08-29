// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { GardenFacet } from "lifi/Facets/GardenFacet.sol";

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
}
