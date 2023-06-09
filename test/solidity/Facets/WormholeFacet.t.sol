// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner } from "src/Errors/GenericErrors.sol";
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
    event WormholeChainIdMapped(
        uint256 indexed lifiChainId,
        uint256 indexed wormholeChainId
    );
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed wormholeChainId,
        bytes32 receiver
    );

    // These values are for Mainnet
    address internal constant MAINNET_ROUTER =
        0x3ee18B2214AFF97000D974cf647E7C347E8fa585;
    // -----

    TestWormholeFacet internal wormholeFacet;
    WormholeFacet.WormholeData internal wormholeData;
    uint32 internal nonce;

    function setUp() public {
        initTestBase();

        wormholeFacet = new TestWormholeFacet(IWormholeRouter(MAINNET_ROUTER));

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = wormholeFacet
            .startBridgeTokensViaWormhole
            .selector;
        functionSelectors[1] = wormholeFacet
            .swapAndStartBridgeTokensViaWormhole
            .selector;
        functionSelectors[2] = wormholeFacet.setWormholeChainId.selector;
        functionSelectors[3] = wormholeFacet.addDex.selector;
        functionSelectors[4] = wormholeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(wormholeFacet), functionSelectors);

        wormholeFacet = TestWormholeFacet(address(diamond));

        wormholeFacet.addDex(address(uniswap));
        wormholeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        wormholeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        wormholeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(wormholeFacet), "WormholeFacet");

        vm.startPrank(USER_DIAMOND_OWNER);
        wormholeFacet.setWormholeChainId(1, 2); // for Mainnet
        wormholeFacet.setWormholeChainId(137, 5); // for Polygon
        wormholeFacet.setWormholeChainId(1000000001, 1); // for Solana
        vm.stopPrank();

        bridgeData.bridge = "wormhole";

        wormholeData = WormholeFacet.WormholeData({
            arbiterFee: 0,
            nonce: nonce++,
            receiver: bytes32(uint256(uint160(bridgeData.receiver)))
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            wormholeFacet.startBridgeTokensViaWormhole{
                value: bridgeData.minAmount
            }(bridgeData, wormholeData);
        } else {
            wormholeFacet.startBridgeTokensViaWormhole(
                bridgeData,
                wormholeData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            wormholeFacet.swapAndStartBridgeTokensViaWormhole{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, wormholeData);
        } else {
            wormholeFacet.swapAndStartBridgeTokensViaWormhole(
                bridgeData,
                swapData,
                wormholeData
            );
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

    function test_CanBridgeTokensToNonEVMChain()
        public
        virtual
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        bridgeData.destinationChainId = 1000000001; // Solana
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        wormholeData
            .receiver = 0x06a81d66f356889562097bf36b786f2e8deaa6f50175fc6cf12f6891820f96a1;

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            1,
            wormholeData.receiver
        );

        wormholeFacet.startBridgeTokensViaWormhole(bridgeData, wormholeData);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensToNonEVMChain()
        public
        virtual
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((1 ether + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        bridgeData.destinationChainId = 1000000001; // Solana
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        wormholeData
            .receiver = 0x06a81d66f356889562097bf36b786f2e8deaa6f50175fc6cf12f6891820f96a1;

        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            1,
            wormholeData.receiver
        );

        wormholeFacet.startBridgeTokensViaWormhole{
            value: bridgeData.minAmount
        }(bridgeData, wormholeData);
        vm.stopPrank();
    }
}
