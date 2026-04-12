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
        address _layerSwapTarget,
        address _backendSigner
    ) LayerSwapFacet(_layerSwapTarget, _backendSigner) {}

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

    uint256 internal constant BACKEND_SIGNER_PRIVATE_KEY =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress =
        vm.addr(BACKEND_SIGNER_PRIVATE_KEY);

    uint256 internal constant DEFAULT_SIGNATURE_EXPIRY = 1 hours;

    bytes32 internal constant LAYERSWAP_PAYLOAD_TYPEHASH =
        0x7dcf9c0f3f3a8c31e1a214f9f426f4f4b3eb6ea8e8d6043e44f6738f0c994106;

    error RequestAlreadyProcessed();
    error InvalidNonEVMReceiver();
    error SignatureExpired();
    error InvalidSignature();

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        layerSwapFacet = new TestLayerSwapFacet(
            LAYERSWAP_TARGET_ADDR,
            backendSignerAddress
        );
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

        setFacetAddressInTestBase(address(layerSwapFacet), "LayerSwapFacet");

        // adjust bridgeData
        bridgeData.bridge = "layerswap";
        bridgeData.destinationChainId = 137;

        // produce valid LayerSwapData with signature
        validLayerSwapData = _generateValidLayerSwapData(
            bridgeData,
            bytes32(keccak256("testRequestId"))
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        validLayerSwapData = _generateValidLayerSwapData(
            bridgeData,
            validLayerSwapData.requestId
        );
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
        validLayerSwapData = _generateValidLayerSwapData(
            bridgeData,
            validLayerSwapData.requestId
        );
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
        new LayerSwapFacet(address(0), backendSignerAddress);
    }

    function testRevert_WhenUsingZeroBackendSigner() public {
        vm.expectRevert(InvalidConfig.selector);
        new LayerSwapFacet(address(0xbeef), address(0));
    }

    function test_CanDeployFacet() public {
        new LayerSwapFacet(address(0xbeef), address(0xcafe));
    }

    // --- Signature Verification Tests ---

    function testRevert_InvalidSignature() public {
        uint256 wrongKey = 0xdead;
        validLayerSwapData = _generateValidLayerSwapDataWithKey(
            bridgeData,
            bytes32(keccak256("testRequestId")),
            bytes32(0),
            wrongKey
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    function testRevert_SignatureExpired() public {
        validLayerSwapData = _generateValidLayerSwapDataWithExpiry(
            bridgeData,
            bytes32(keccak256("testRequestId")),
            bytes32(0),
            block.timestamp - 1
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(SignatureExpired.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    function testRevert_SignatureExpiredAfterWarp() public {
        validLayerSwapData = _generateValidLayerSwapData(
            bridgeData,
            bytes32(keccak256("testRequestId"))
        );

        vm.warp(block.timestamp + DEFAULT_SIGNATURE_EXPIRY + 1);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(SignatureExpired.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    // --- Replay Protection Tests ---

    function testRevert_WhenReplayingRequestId() public {
        layerSwapFacet.setConsumedId(validLayerSwapData.requestId);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(RequestAlreadyProcessed.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    function testRevert_WhenReplayingRequestIdOnSwapAndBridge() public {
        layerSwapFacet.setConsumedId(validLayerSwapData.requestId);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(RequestAlreadyProcessed.selector);
        layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
            bridgeData,
            swapData,
            validLayerSwapData
        );
        vm.stopPrank();
    }

    function test_ConsumedIdsAreTracked() public {
        assertFalse(layerSwapFacet.consumedIds(validLayerSwapData.requestId));

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertTrue(layerSwapFacet.consumedIds(validLayerSwapData.requestId));
    }

    // --- Non-EVM Receiver Tests ---

    function testRevert_WhenUsingEmptyNonEVMReceiver() public {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData = _generateValidLayerSwapDataNonEVM(
            bridgeData,
            bytes32(keccak256("nonEvmRequest")),
            bytes32(0)
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);
        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
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
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validLayerSwapData = _generateValidLayerSwapDataNonEVM(
            bridgeData,
            bytes32(keccak256("solanaRequest")),
            nonEVMReceiver
        );

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

        layerSwapFacet.startBridgeTokensViaLayerSwap(
            bridgeData,
            validLayerSwapData
        );
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
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;
        validLayerSwapData = _generateValidLayerSwapDataNonEVM(
            bridgeData,
            bytes32(keccak256("solanaRequestNative")),
            nonEVMReceiver
        );

        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            validLayerSwapData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        layerSwapFacet.startBridgeTokensViaLayerSwap{
            value: bridgeData.minAmount
        }(bridgeData, validLayerSwapData);
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
        bytes32 nonEVMReceiver = bytes32(
            abi.encodePacked("EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb")
        );
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.hasSourceSwaps = true;
        validLayerSwapData = _generateValidLayerSwapDataNonEVM(
            bridgeData,
            bytes32(keccak256("solanaSwapRequest")),
            nonEVMReceiver
        );

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

        layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
            bridgeData,
            swapData,
            validLayerSwapData
        );
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

    // --- EIP-712 Signature Helpers ---

    function _generateValidLayerSwapData(
        ILiFi.BridgeData memory _bridgeData,
        bytes32 _requestId
    ) internal view returns (LayerSwapFacet.LayerSwapData memory) {
        return
            _generateValidLayerSwapDataWithKey(
                _bridgeData,
                _requestId,
                bytes32(0),
                BACKEND_SIGNER_PRIVATE_KEY
            );
    }

    function _generateValidLayerSwapDataNonEVM(
        ILiFi.BridgeData memory _bridgeData,
        bytes32 _requestId,
        bytes32 _nonEVMReceiver
    ) internal view returns (LayerSwapFacet.LayerSwapData memory) {
        return
            _generateValidLayerSwapDataWithKey(
                _bridgeData,
                _requestId,
                _nonEVMReceiver,
                BACKEND_SIGNER_PRIVATE_KEY
            );
    }

    function _generateValidLayerSwapDataWithExpiry(
        ILiFi.BridgeData memory _bridgeData,
        bytes32 _requestId,
        bytes32 _nonEVMReceiver,
        uint256 _signatureExpiry
    ) internal view returns (LayerSwapFacet.LayerSwapData memory) {
        bytes32 receiverBytes32 = _bridgeData.receiver == NON_EVM_ADDRESS
            ? _nonEVMReceiver
            : bytes32(uint256(uint160(_bridgeData.receiver)));

        bytes32 structHash = keccak256(
            abi.encode(
                LAYERSWAP_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _requestId,
                _bridgeData.minAmount,
                receiverBytes32,
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                _signatureExpiry
            )
        );

        bytes32 domainSeparator = _buildDomainSeparator();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            BACKEND_SIGNER_PRIVATE_KEY,
            digest
        );

        return
            LayerSwapFacet.LayerSwapData({
                requestId: _requestId,
                nonEVMReceiver: _nonEVMReceiver,
                signatureExpiry: _signatureExpiry,
                signature: abi.encodePacked(r, s, v)
            });
    }

    function _generateValidLayerSwapDataWithKey(
        ILiFi.BridgeData memory _bridgeData,
        bytes32 _requestId,
        bytes32 _nonEVMReceiver,
        uint256 _privateKey
    ) internal view returns (LayerSwapFacet.LayerSwapData memory) {
        uint256 signatureExpiry = block.timestamp + DEFAULT_SIGNATURE_EXPIRY;

        bytes32 receiverBytes32 = _bridgeData.receiver == NON_EVM_ADDRESS
            ? _nonEVMReceiver
            : bytes32(uint256(uint160(_bridgeData.receiver)));

        bytes32 structHash = keccak256(
            abi.encode(
                LAYERSWAP_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _requestId,
                _bridgeData.minAmount,
                receiverBytes32,
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                signatureExpiry
            )
        );

        bytes32 domainSeparator = _buildDomainSeparator();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_privateKey, digest);

        return
            LayerSwapFacet.LayerSwapData({
                requestId: _requestId,
                nonEVMReceiver: _nonEVMReceiver,
                signatureExpiry: signatureExpiry,
                signature: abi.encodePacked(r, s, v)
            });
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI LayerSwap Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(layerSwapFacet)
                )
            );
    }

    // --- Helpers ---

    function _makeRevertable(address target) internal {
        Reverter reverter = new Reverter();
        bytes memory code = address(reverter).code;
        vm.etch(target, code);
    }
}
