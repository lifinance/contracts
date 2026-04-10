// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

contract Reverter {
    error AlwaysReverts();

    fallback() external payable {
        revert AlwaysReverts();
    }
}

// Stub LayerSwapFacet Contract
contract TestLayerSwapFacet is LayerSwapFacet, TestWhitelistManagerBase {
    constructor(
        address _layerSwapTarget
    ) LayerSwapFacet(_layerSwapTarget) {}

    function setConsumedId(bytes32 id) external {
        _setConsumedId(id);
    }

    function _setConsumedId(bytes32 id) internal {
        bytes32 namespace = keccak256("com.lifi.facets.layerswap");
        // Write directly to diamond storage
        assembly {
            mstore(0x00, id)
            mstore(0x20, namespace)
            let slot := keccak256(0x00, 0x40)
            sstore(slot, 1)
        }
    }
}

contract LayerSwapFacetTest is TestBaseFacet {
    LayerSwapFacet.LayerSwapData internal validLayerSwapData;
    TestLayerSwapFacet internal layerSwapFacet;
    address internal LAYERSWAP_TARGET_ADDR = address(0xb33f);

    error RequestAlreadyProcessed();
    error InvalidNonEVMReceiver();

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        layerSwapFacet = new TestLayerSwapFacet(LAYERSWAP_TARGET_ADDR);
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = layerSwapFacet
            .startBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[1] = layerSwapFacet
            .swapAndStartBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[2] = layerSwapFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = layerSwapFacet
            .removeAllowedContractSelector
            .selector;
        functionSelectors[4] = layerSwapFacet.consumedIds.selector;
        functionSelectors[5] = layerSwapFacet.setConsumedId.selector;

        addFacet(diamond, address(layerSwapFacet), functionSelectors);
        layerSwapFacet = TestLayerSwapFacet(address(diamond));
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(layerSwapFacet),
            "LayerSwapFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "layerswap";
        bridgeData.destinationChainId = 137;

        // produce valid LayerSwapData
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("testRequestId")),
            nonEVMReceiver: bytes32(0)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            layerSwapFacet.startBridgeTokensViaLayerSwap{
                value: bridgeData.minAmount
            }(bridgeData, validLayerSwapData);
        } else {
            layerSwapFacet.startBridgeTokensViaLayerSwap(
                bridgeData,
                validLayerSwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validLayerSwapData);
        } else {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
                bridgeData,
                swapData,
                validLayerSwapData
            );
        }
    }

    // --- Constructor Tests ---

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new LayerSwapFacet(address(0));
    }

    function test_CanDeployFacet() public {
        new LayerSwapFacet(address(0xbeef));
    }

    // --- Replay Protection Tests ---

    function testRevert_WhenReplayingRequestId() public {
        layerSwapFacet.setConsumedId(validLayerSwapData.requestId);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(RequestAlreadyProcessed.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenReplayingRequestIdOnSwapAndBridge()
        public
    {
        layerSwapFacet.setConsumedId(validLayerSwapData.requestId);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(RequestAlreadyProcessed.selector);
        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_ConsumedIdsAreTracked() public {
        assertFalse(
            layerSwapFacet.consumedIds(validLayerSwapData.requestId)
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertTrue(
            layerSwapFacet.consumedIds(validLayerSwapData.requestId)
        );
    }

    // --- Non-EVM Receiver Tests ---

    function testRevert_WhenUsingEmptyNonEVMReceiver() public {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("nonEvmRequest")),
            nonEVMReceiver: bytes32(0)
        });

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToNonEVM()
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
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("solanaRequest")),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            )
        });

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            validLayerSwapData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensToNonEVM()
        public
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("solanaRequestNative")),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            )
        });

        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            validLayerSwapData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensToNonEVM()
        public
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.hasSourceSwaps = true;
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("solanaSwapRequest")),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            )
        });

        vm.startPrank(USER_SENDER);
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

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

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Revert Propagation Tests ---

    function testRevert_WhenERC20TransferFails()
        public
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.mockCallRevert(
            ADDRESS_USDC,
            abi.encodeWithSignature(
                "transfer(address,uint256)",
                LAYERSWAP_TARGET_ADDR,
                bridgeData.minAmount
            ),
            "I always revert"
        );

        vm.expectRevert();
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNativeTransferFails()
        public
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        _makeRevertable(LAYERSWAP_TARGET_ADDR);

        vm.expectRevert();
        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    // --- Helpers ---

    function _makeRevertable(address target) internal {
        Reverter reverter = new Reverter();
        bytes memory code = address(reverter).code;
        vm.etch(target, code);
    }
}
