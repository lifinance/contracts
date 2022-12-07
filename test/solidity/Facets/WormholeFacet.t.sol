// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20, LiFiDiamond } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InsufficientBalance, InvalidDestinationChain, NoSwapDataProvided, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";
import { IWormholeRouter } from "lifi/Interfaces/IWormholeRouter.sol";

// Stub WormholeFacet Contract
contract TestWormholeFacet is WormholeFacet {
    /// @notice Initialize the contract.
    /// @param _router The contract address of the Wormhole router on the source chain.
    constructor(IWormholeRouter _router) WormholeFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract WormholeFacetTest is TestBaseFacet {
    // EVENTS
    event WormholeChainIdMapped(uint256 indexed lifiChainId, uint256 indexed wormholeChainId);

    // These values are for Mainnet
    address internal constant MAINNET_ROUTER = 0x3ee18B2214AFF97000D974cf647E7C347E8fa585;
    // -----

    TestWormholeFacet internal wormholeFacet;
    WormholeFacet.WormholeData internal wormholeData;
    uint32 internal nonce;

    function setUp() public {
        initTestBase();

        wormholeFacet = new TestWormholeFacet(IWormholeRouter(MAINNET_ROUTER));

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = wormholeFacet.startBridgeTokensViaWormhole.selector;
        functionSelectors[1] = wormholeFacet.swapAndStartBridgeTokensViaWormhole.selector;
        functionSelectors[2] = wormholeFacet.setWormholeChainId.selector;
        functionSelectors[3] = wormholeFacet.addDex.selector;
        functionSelectors[4] = wormholeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(wormholeFacet), functionSelectors);

        wormholeFacet = TestWormholeFacet(address(diamond));

        wormholeFacet.addDex(address(uniswap));
        wormholeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        wormholeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        wormholeFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        setFacetAddressInTestBase(address(wormholeFacet), "WormholeFacet");

        vm.startPrank(USER_DIAMOND_OWNER);
        wormholeFacet.setWormholeChainId(1, 2); // for Mainnet
        wormholeFacet.setWormholeChainId(137, 5); // for Polygon
        vm.stopPrank();

        bridgeData.bridge = "wormhole";

        wormholeData = WormholeFacet.WormholeData({ arbiterFee: 0, nonce: nonce++ });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            wormholeFacet.startBridgeTokensViaWormhole{ value: bridgeData.minAmount }(bridgeData, wormholeData);
        } else {
            wormholeFacet.startBridgeTokensViaWormhole(bridgeData, wormholeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            wormholeFacet.swapAndStartBridgeTokensViaWormhole{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                wormholeData
            );
        } else {
            wormholeFacet.swapAndStartBridgeTokensViaWormhole(bridgeData, swapData, wormholeData);
        }
    }

    function test_revert_SetWormholeChainIdAsNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        wormholeFacet.setWormholeChainId(123, 456);
    }

    function test_SetWormholeChainIdAsOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectEmit(true, true, true, true, address(wormholeFacet));
        emit WormholeChainIdMapped(123, 456);
        wormholeFacet.setWormholeChainId(123, 456);
    }
}
