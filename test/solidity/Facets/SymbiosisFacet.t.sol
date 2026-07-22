// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";
import { ISymbiosisMetaRouter } from "lifi/Interfaces/ISymbiosisMetaRouter.sol";
import { IOnchainSwapV3 } from "lifi/Interfaces/IOnchainSwapV3.sol";
import { InvalidConfig, InvalidReceiver, InvalidDestinationChain, InvalidNonEVMReceiver, InformationMismatch, NoSwapDataProvided, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Stub SymbiosisFacet Contract
contract TestSymbiosisFacet is SymbiosisFacet, TestWhitelistManagerBase {
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway,
        IOnchainSwapV3 _onchainSwapV3,
        address _onchainSwapV3Gateway,
        address _backendSigner
    )
        SymbiosisFacet(
            _symbiosisMetaRouter,
            _symbiosisGateway,
            _onchainSwapV3,
            _onchainSwapV3Gateway,
            _backendSigner
        )
    {}
}

/// @dev Builds the EIP-712 backend signature required on the OnchainSwapV3 path.
///      Kept in a library so both the standard and fork test contracts can reuse it.
library OnchainSwapV3Signing {
    // Must match SymbiosisFacet.SYMBIOSIS_PAYLOAD_TYPEHASH
    bytes32 internal constant SYMBIOSIS_PAYLOAD_TYPEHASH =
        keccak256(
            "SymbiosisPayload(bytes32 transactionId,uint256 minAmount,address sendingAssetId,uint256 destinationChainId,bytes32 nonEvmReceiver,address dex,address dexgateway,bytes32 onchainSwapDataHash,uint256 fee,uint256 deadline,address refundRecipient)"
        );

    function digest(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisFacet.SymbiosisData memory _symbiosisData,
        address _verifyingContract,
        uint256 _chainId
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SYMBIOSIS_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.minAmount,
                _bridgeData.sendingAssetId,
                _bridgeData.destinationChainId,
                _symbiosisData.nonEvmReceiver,
                _symbiosisData.dex,
                _symbiosisData.dexgateway,
                keccak256(_symbiosisData.onchainSwapData),
                _symbiosisData.fee,
                _symbiosisData.deadline,
                _symbiosisData.refundRecipient
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("LI.FI Symbiosis Facet")),
                keccak256(bytes("1")),
                _chainId,
                _verifyingContract
            )
        );

        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }
}

/// @dev Minimal stand-in for a contract that calls the diamond on a user's
///      behalf (e.g. LI.FI's Permit2Proxy, which invokes the diamond via
///      `LIFI_DIAMOND.call{value: msg.value}(...)`). Used to prove refunds go
///      to `refundRecipient` and are never stranded at the calling contract
///      (`msg.sender`).
contract RelayerProxy {
    function approveToken(
        address token,
        address spender,
        uint256 amount
    ) external {
        IERC20(token).approve(spender, amount);
    }

    function callDiamond(
        address diamond,
        uint256 value,
        bytes calldata data
    ) external payable {
        (bool success, bytes memory ret) = diamond.call{ value: value }(data);
        if (!success) {
            // bubble up the original revert reason
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    receive() external payable {}
}

contract SymbiosisFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant SYMBIOSIS_METAROUTER =
        0xf621Fb08BBE51aF70e7E0F4EA63496894166Ff7F;
    address internal constant SYMBIOSIS_GATEWAY =
        0xfCEF2Fe72413b65d3F393d278A714caD87512bcd;
    address internal constant RELAY_RECIPIENT =
        0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8;

    // Mainnet OnchainSwapV3 router + its gateway (verified on-chain, fee()==0).
    // The router has no code at the metaRoute fork block (19317492); the tests that
    // actually execute it live in the fork contracts below, pinned to blocks where
    // it is deployed. Here it is only used for construction and the revert guards
    // (which revert before onswap is ever called).
    address internal constant ONCHAIN_SWAP_V3 =
        0x92114294E42A96C9eF3163DA18Ee7eFdbA6cc661;
    address internal constant ONCHAIN_SWAP_V3_GATEWAY =
        0xdAcb78cB349bAD001117C90861b32d40972A30a6;

    uint256 internal constant BACKEND_SIGNER_PK = 0xB4C;

    error OnchainSwapV3NotSupported();
    error InvalidSignature();
    error SignatureExpired();
    error TransactionAlreadyProcessed();

    TestSymbiosisFacet internal symbiosisFacet;
    SymbiosisFacet.SymbiosisData internal symbiosisData;
    bytes32 internal constant BTC_RECEIVER =
        bytes32(
            uint256(
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
            )
        );

    function setUp() public {
        customBlockNumberForForking = 19317492;
        initTestBase();

        symbiosisFacet = new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(ONCHAIN_SWAP_V3),
            ONCHAIN_SWAP_V3_GATEWAY,
            vm.addr(BACKEND_SIGNER_PK)
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = symbiosisFacet
            .startBridgeTokensViaSymbiosis
            .selector;
        functionSelectors[1] = symbiosisFacet
            .swapAndStartBridgeTokensViaSymbiosis
            .selector;
        functionSelectors[2] = symbiosisFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(symbiosisFacet), functionSelectors);

        symbiosisFacet = TestSymbiosisFacet(address(diamond));

        symbiosisFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapExactTokensForTokens.selector
        );
        symbiosisFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapExactTokensForETH.selector
        );
        symbiosisFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapETHForExactTokens.selector
        );
        symbiosisFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(symbiosisFacet), "SymbiosisFacet");

        bridgeData.bridge = "symbiosis";
        bridgeData.minAmount = defaultUSDCAmount;

        bytes memory _otherSideCalldata = abi.encodeWithSignature(
            "synthesize(uint256,address,uint256,address,address,address,address,uint256,bytes32)",
            1000000, //    bridging fee
            ADDRESS_USDC, //    token address
            100000000, //   amount
            0x0f590DA07186328fCf0Ea79c73bD9b81d3263C2f, //   to,
            0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8, //    synthesis,
            0x5523985926Aa12BA58DC5Ad00DDca99678D7227E, //    oppositeBridge,
            0x0f590DA07186328fCf0Ea79c73bD9b81d3263C2f, //    revertableAddress,
            56288, //    chainID,
            "" //    clientID
        );

        address[] memory _approvedTokens = new address[](1);
        _approvedTokens[0] = ADDRESS_USDC;

        symbiosisData = SymbiosisFacet.SymbiosisData({
            refundRecipient: USER_SENDER,
            firstSwapCalldata: "",
            secondSwapCalldata: "",
            firstDexRouter: address(0),
            secondDexRouter: address(0),
            approvedTokens: _approvedTokens,
            callTo: RELAY_RECIPIENT,
            callData: _otherSideCalldata,
            viaOnchainSwapV3: false,
            dex: address(0),
            dexgateway: address(0),
            onchainSwapData: "",
            nonEvmReceiver: bytes32(0),
            fee: 0,
            deadline: 0,
            signature: ""
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            symbiosisData.firstSwapCalldata = _getFirstDexCallData();
            symbiosisData
                .firstDexRouter = 0x1111111254EEB25477B68fb85Ed929f73A960582; // One Inch
            symbiosisData.approvedTokens = new address[](2);
            symbiosisData.approvedTokens[0] = address(0);
            symbiosisData.approvedTokens[1] = ADDRESS_USDC;
            symbiosisData.callData = _getRelayCallData();
            symbiosisFacet.startBridgeTokensViaSymbiosis{
                value: bridgeData.minAmount
            }(bridgeData, symbiosisData);
        } else {
            symbiosisFacet.startBridgeTokensViaSymbiosis(
                bridgeData,
                symbiosisData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis{
            value: addToMessageValue
        }(bridgeData, swapData, symbiosisData);
    }

    /// OnchainSwapV3 path ///

    /// @dev Sets bridgeData for a Bitcoin (non-EVM) destination and enables the
    ///      OnchainSwapV3 path on symbiosisData.
    function _prepareOnchainSwapV3Data() internal {
        // NON_EVM_ADDRESS sentinel + LI.FI custom chain id for Bitcoin
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;
        bridgeData.destinationChainId = 20000000000001;

        symbiosisData.viaOnchainSwapV3 = true;
        symbiosisData.dex = address(0xDE1);
        symbiosisData.dexgateway = address(0xDE2);
        symbiosisData.onchainSwapData = hex"abcdef";
        symbiosisData.nonEvmReceiver = BTC_RECEIVER;
        symbiosisData.deadline = block.timestamp + 1 hours;
    }

    /// @dev Signs the current bridgeData/symbiosisData for the OnchainSwapV3 path
    ///      against the diamond (verifyingContract) with the given key.
    function _signOnchainSwapV3(
        uint256 _pk
    ) internal view returns (bytes memory) {
        bytes32 digest = OnchainSwapV3Signing.digest(
            bridgeData,
            symbiosisData,
            _facetTestContractAddress,
            block.chainid
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pk, digest);

        return abi.encodePacked(r, s, v);
    }

    function testRevert_OnchainSwapV3InvalidSignature() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        // signed by a key that is NOT the configured backend signer
        symbiosisData.signature = _signOnchainSwapV3(BACKEND_SIGNER_PK + 1);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3ExpiredSignature() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        symbiosisData.deadline = block.timestamp - 1;
        symbiosisData.signature = _signOnchainSwapV3(BACKEND_SIGNER_PK);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(SignatureExpired.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3TamperedCalldata() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        // sign the honest calldata, then tamper with it after signing
        symbiosisData.signature = _signOnchainSwapV3(BACKEND_SIGNER_PK);
        symbiosisData.onchainSwapData = hex"deadbeef";

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_ConstructorWithZeroBackendSigner() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(ONCHAIN_SWAP_V3),
            ONCHAIN_SWAP_V3_GATEWAY,
            address(0)
        );
    }

    // NOTE: OnchainSwapV3 happy-path execution is covered by the mainnet-fork
    // contracts at the bottom of this file (real router, replayed on-chain onswap
    // calldata). The tests here only cover the pre-onswap revert guards, which are
    // block-agnostic.

    function testRevert_OnchainSwapV3WrongDestinationChain() public {
        _prepareOnchainSwapV3Data();
        bridgeData.destinationChainId = 137; // not Bitcoin
        bridgeData.sendingAssetId = ADDRESS_USDC;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidDestinationChain.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3NonNonEvmReceiver() public {
        _prepareOnchainSwapV3Data();
        bridgeData.receiver = USER_RECEIVER; // not the non-EVM sentinel
        bridgeData.sendingAssetId = ADDRESS_USDC;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3EmptyNonEvmReceiver() public {
        _prepareOnchainSwapV3Data();
        symbiosisData.nonEvmReceiver = bytes32(0);
        bridgeData.sendingAssetId = ADDRESS_USDC;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3NotConfigured() public {
        // Facet deployed without an OnchainSwapV3 router (address(0))
        TestSymbiosisFacet unsupportedFacet = new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(0)),
            address(0),
            vm.addr(BACKEND_SIGNER_PK)
        );

        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.deal(USER_SENDER, 1 ether);
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnchainSwapV3NotSupported.selector);

        unsupportedFacet.startBridgeTokensViaSymbiosis{
            value: bridgeData.minAmount
        }(bridgeData, symbiosisData);
        vm.stopPrank();
    }

    /// @dev Audit finding #6: the swap entrypoint must reject destination calls
    ///      exactly like the non-swap entrypoint. Replays the audit's attack shape
    ///      (source swaps + destination call + non-EVM BTC receiver + OnchainSwapV3)
    ///      and asserts the guard reverts in the modifier, before _depositAndSwap
    ///      moves any tokens.
    function testRevert_SwapAndBridgeWithDestinationCall() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.hasSourceSwaps = true;
        bridgeData.hasDestinationCall = true;
        symbiosisData.signature = _signOnchainSwapV3(BACKEND_SIGNER_PK);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis(
            bridgeData,
            swapData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_ConstructorWithZeroMetaRouter() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(address(0)),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(ONCHAIN_SWAP_V3),
            ONCHAIN_SWAP_V3_GATEWAY,
            vm.addr(BACKEND_SIGNER_PK)
        );
    }

    function testRevert_ConstructorWithRouterButNoGateway() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(ONCHAIN_SWAP_V3),
            address(0),
            vm.addr(BACKEND_SIGNER_PK)
        );
    }

    function testRevert_ConstructorWithGatewayButNoRouter() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(0)),
            ONCHAIN_SWAP_V3_GATEWAY,
            vm.addr(BACKEND_SIGNER_PK)
        );
    }

    /// MetaRouter approvedTokens validation (finding #7) ///

    /// @dev finding #7: the MetaRouter pulls approvedTokens[0] from the diamond
    ///      via the standing gateway allowance, so it must equal the deposited
    ///      sendingAssetId; a mismatch would let a caller drain a residual balance
    ///      of another token.
    function testRevert_MetaRouterApprovedTokenMismatch() public {
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // approvedTokens[0] points at a different token than sendingAssetId
        symbiosisData.approvedTokens = new address[](1);
        symbiosisData.approvedTokens[0] = ADDRESS_DAI;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    /// @dev finding #7: an empty approvedTokens array must revert cleanly rather
    ///      than panic on the out-of-bounds approvedTokens[0] read.
    function testRevert_MetaRouterEmptyApprovedTokens() public {
        bridgeData.sendingAssetId = ADDRESS_USDC;
        symbiosisData.approvedTokens = new address[](0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    /// @dev finding #7 happy path: approvedTokens[0] == sendingAssetId bridges
    ///      normally and emits LiFiTransferStarted.
    function test_MetaRouterMatchingApprovedTokenSucceeds() public {
        bridgeData.sendingAssetId = ADDRESS_USDC;

        symbiosisData.approvedTokens = new address[](1);
        symbiosisData.approvedTokens[0] = ADDRESS_USDC;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    /// refundRecipient (audit finding #1) ///

    /// @dev Excess native sent through a proxy caller must be refunded to
    ///      `refundRecipient`, not stranded at the proxy (`msg.sender`).
    function test_ExcessNativeRefundedToRefundRecipientNotProxyCaller()
        public
    {
        RelayerProxy proxy = new RelayerProxy();
        address refundRecipient = makeAddr("symbiosisRefundRecipient");

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        symbiosisData.refundRecipient = refundRecipient;

        uint256 excessNative = 1 ether;

        deal(ADDRESS_USDC, address(proxy), bridgeData.minAmount);
        vm.deal(address(this), excessNative);
        proxy.approveToken(
            ADDRESS_USDC,
            _facetTestContractAddress,
            bridgeData.minAmount
        );

        bytes memory callData = abi.encodeWithSelector(
            symbiosisFacet.startBridgeTokensViaSymbiosis.selector,
            bridgeData,
            symbiosisData
        );

        proxy.callDiamond{ value: excessNative }(
            _facetTestContractAddress,
            excessNative,
            callData
        );

        // the ERC20 MetaRouter path forwards no native, so the whole attached
        // value is excess and must land at refundRecipient, not the proxy
        assertEq(refundRecipient.balance, excessNative);
        assertEq(address(proxy).balance, 0);
    }

    /// @dev Same property for the swap-and-bridge entrypoint: refunds follow
    ///      `refundRecipient`, never the calling proxy.
    function test_SwapAndBridge_RefundGoesToRefundRecipientNotProxyCaller()
        public
    {
        RelayerProxy proxy = new RelayerProxy();
        address refundRecipient = makeAddr("symbiosisSwapRefundRecipient");

        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        symbiosisData.refundRecipient = refundRecipient;

        // DAI -> USDC (exact-input, no DAI leftover), then bridge USDC
        setDefaultSwapDataSingleDAItoUSDC();

        uint256 excessNative = 1 ether;

        deal(ADDRESS_DAI, address(proxy), swapData[0].fromAmount);
        vm.deal(address(this), excessNative);
        proxy.approveToken(
            ADDRESS_DAI,
            _facetTestContractAddress,
            swapData[0].fromAmount
        );

        bytes memory callData = abi.encodeWithSelector(
            symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis.selector,
            bridgeData,
            swapData,
            symbiosisData
        );

        proxy.callDiamond{ value: excessNative }(
            _facetTestContractAddress,
            excessNative,
            callData
        );

        assertEq(refundRecipient.balance, excessNative);
        assertEq(address(proxy).balance, 0);
    }

    function testRevert_StartBridgeWithZeroRefundRecipient() public {
        bridgeData.sendingAssetId = ADDRESS_USDC;
        symbiosisData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );
        vm.stopPrank();
    }

    function testRevert_SwapAndStartBridgeWithZeroRefundRecipient() public {
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        symbiosisData.refundRecipient = address(0);
        setDefaultSwapDataSingleDAItoUSDC();

        vm.startPrank(USER_SENDER);
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis(
            bridgeData,
            swapData,
            symbiosisData
        );
        vm.stopPrank();
    }

    /// MetaRouter path (unchanged) ///

    function testBase_CanSwapAndBridgeNativeTokens()
        public
        override
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialUSDCBalance = usdc.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        usdc.approve(_facetTestContractAddress, amountIn);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        symbiosisData.firstSwapCalldata = _getFirstDexCallData();
        symbiosisData
            .firstDexRouter = 0x1111111254EEB25477B68fb85Ed929f73A960582; // One Inch
        symbiosisData.approvedTokens = new address[](2);
        symbiosisData.approvedTokens[0] = address(0);
        symbiosisData.approvedTokens[1] = ADDRESS_USDC;
        symbiosisData.callData = _getRelayCallData();

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount >= 10 && amount < 100_000); // Symbiosis threshold is around 10
        amount = amount * 10 ** usdc.decimals();

        logFilePath = "./test/logs/"; // works but is not really a proper file
        // logFilePath = "./test/logs/fuzz_test.txt"; // throws error "failed to write to "....../test/logs/fuzz_test.txt": No such file or directory"

        vm.writeLine(logFilePath, vm.toString(amount));
        // approval
        usdc.approve(_facetTestContractAddress, amount);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @notice The source-swap output asset must equal bridgeData.sendingAssetId:
    ///         _depositAndSwap measures minAmount in the last swap's receivingAssetId
    ///         while _startBridge forwards bridgeData.sendingAssetId.
    function testRevert_SwapOutputAssetMismatch() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        // last swap outputs DAI while bridgeData.sendingAssetId stays USDC
        swapData[swapData.length - 1].receivingAssetId = ADDRESS_DAI;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);
        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis(
            bridgeData,
            swapData,
            symbiosisData
        );

        vm.stopPrank();
    }

    /// @notice The empty-swap case is left to _depositAndSwap so its
    ///         NoSwapDataProvided error is preserved (not shadowed by the mismatch guard).
    function testRevert_SwapAndBridgeWithEmptySwapData() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        delete swapData;

        vm.expectRevert(NoSwapDataProvided.selector);
        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis(
            bridgeData,
            swapData,
            symbiosisData
        );

        vm.stopPrank();
    }

    // These values are normally returned from the API. They are hardcoded for testing.
    function _getFirstDexCallData() internal pure returns (bytes memory) {
        return
            hex"e449022e0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000bde5814b00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000088e6a0c2ddd26feeb64f039a2c41296fcb3f5640ea698b47";
    }

    function _getRelayCallData() internal pure returns (bytes memory) {
        return
            hex"ce654c17000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000aae6000000000000000000000000000000000000000000000000000000000c04cddaa000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a80000000000000000000000005523985926aa12ba58dc5ad00ddca99678d7227e000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000000000000000000000000000000000000000dbe00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000cb28fbe3e9c0fea62e0e63ff3f232cecfe555ad40000000000000000000000000000000000000000000000000000000000000260000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a800000000000000000000000000000000000000000000000000000000000005800000000000000000000000000000000000000000000000000000000000000064000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd73796d62696f7369732d6170690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000007d6ec42b5d9566931560411a8652cea00b90d9820000000000000000000000005e19efc6ac9c80bfaa755259c9fab2398a8e87eb00000000000000000000000000000000000000000000000000000000000002e41e859a0500000000000000000000000000000000000000000000000000000000c04cddaa00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000002cbabd7329b84e2c0a317702410e7c73d0e0246d0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c48f6bdeaa0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000c0422f4a0000000000000000000000000000000000000000000000abc2fad74a2adb215c000000000000000000000000cb28fbe3e9c0fea62e0e63ff3f232cecfe555ad40000000000000000000000000000000000000000000000000000000065e6d4f90000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000006148fd6c649866596c3d8a971fc313e5ece8488200000000000000000000000000000000000000000000000000000000000000020000000000000000000000007d6ec42b5d9566931560411a8652cea00b90d9820000000000000000000000005e19efc6ac9c80bfaa755259c9fab2398a8e87eb00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000544e66bb55000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000c7d713b49da00000000000000000000000000000000000000000000000000aecf70aac3e4c1f30300000000000000000000000000000000000000000000000000000000000000000000000000000000000000002cbabd7329b84e2c0a317702410e7c73d0e0246d0000000000000000000000001111111254eeb25477b68fb85ed929f73a9605820000000000000000000000005e19efc6ac9c80bfaa755259c9fab2398a8e87eb00000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000000c4000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd0000000000000000000000005aa5f7f84ed0e5db0a4a85c3947ea16b53352fd4000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a8000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000000000000000000000000000000000000000003873796d62696f7369732d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000032812aa3caf000000000000000000000000e37e799d5077682fa0a244d46e5649f71457bd090000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000d5f05644ef5d0a36ca8c8b5177ffbd09ec63f92f000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd0000000000000000000000000000000000000000000000aec2f339889ae7f3030000000000000000000000000000000000000000000000006d28db4537cfadb30000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018100000000000000000000000000000000000000016300014d00010300001a0020d6bdbf788ac76a51cc950d9822d68b83fe1ad97b32cd580d00a007e5c0d20000000000000000000000000000000000000000000000c500008900003a4020d5f05644ef5d0a36ca8c8b5177ffbd09ec63f92fdd93f59a000000000000000000000000e37e799d5077682fa0a244d46e5649f71457bd0902a00000000000000000000000000000000000000000000000000000000000000001ee63c1e501172fcd41e0913e95784454622d1c3724f546f84955d398326f99059ff775485246999027b31979554101bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00042e1a7d4d000000000000000000000000000000000000000000000000000000000000000000a0f2fa6b66eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000000000000000000000000000007089216463c3a0990000000000000000002cab6cb4577c5dc0611111111254eeb25477b68fb85ed929f73a96058200000000000000000000000000000000000000000000000000000000000000ea698b4700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    }
}

/// @notice Shared base for OnchainSwapV3 mainnet-fork tests. Each concrete contract
///         pins the fork to the block of the real onswap tx it replays.
abstract contract SymbiosisOnchainSwapV3ForkTestBase is TestBase {
    address internal constant SYMBIOSIS_METAROUTER =
        0xf621Fb08BBE51aF70e7E0F4EA63496894166Ff7F;
    address internal constant SYMBIOSIS_GATEWAY =
        0xfCEF2Fe72413b65d3F393d278A714caD87512bcd;
    address internal constant ONCHAIN_SWAP_V3 =
        0x92114294E42A96C9eF3163DA18Ee7eFdbA6cc661;
    address internal constant ONCHAIN_SWAP_V3_GATEWAY =
        0xdAcb78cB349bAD001117C90861b32d40972A30a6;
    // dex == dexgateway in both replayed onswap txs
    address internal constant ONSWAP_DEX =
        0x09D479E04D2dd46AaD77618435e5c639EA769264;
    bytes32 internal constant BTC_RECEIVER =
        bytes32(
            uint256(
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
            )
        );
    uint256 internal constant BACKEND_SIGNER_PK = 0xB4C;
    // OnchainSwapV3.fee is the 2nd storage slot (slot 0 == Ownable._owner).
    // Verified on-chain: owner @slot0, fee @slot1, onchainGateway @slot2.
    bytes32 internal constant ONCHAIN_SWAP_V3_FEE_SLOT = bytes32(uint256(1));

    error TransactionAlreadyProcessed();
    error OnchainSwapV3FeeMismatch();

    TestSymbiosisFacet internal symbiosisFacet;

    /// @dev Overrides the router's live `fee()` (default 0 on-chain) so the
    ///      nonzero-fee finding-#8 paths can be exercised deterministically.
    function _setRouterFee(uint256 feeValue) internal {
        vm.store(ONCHAIN_SWAP_V3, ONCHAIN_SWAP_V3_FEE_SLOT, bytes32(feeValue));
        assertEq(IOnchainSwapV3(ONCHAIN_SWAP_V3).fee(), feeValue);
    }

    function _forkBlock() internal pure virtual returns (uint256);

    function setUp() public {
        customBlockNumberForForking = _forkBlock();
        initTestBase();

        symbiosisFacet = new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(ONCHAIN_SWAP_V3),
            ONCHAIN_SWAP_V3_GATEWAY,
            vm.addr(BACKEND_SIGNER_PK)
        );

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = symbiosisFacet.startBridgeTokensViaSymbiosis.selector;
        selectors[1] = symbiosisFacet
            .swapAndStartBridgeTokensViaSymbiosis
            .selector;
        selectors[2] = symbiosisFacet.addAllowedContractSelector.selector;
        addFacet(diamond, address(symbiosisFacet), selectors);
        symbiosisFacet = TestSymbiosisFacet(address(diamond));

        // whitelist the source-swap DEX call used by the swap-entrypoint fork test
        symbiosisFacet.addAllowedContractSelector(
            address(uniswap),
            uniswap.swapTokensForExactTokens.selector
        );
    }

    /// @dev Builds a backend-signed BridgeData/SymbiosisData pair for the
    ///      OnchainSwapV3 path, replaying real on-chain onswap calldata.
    function _buildOnchainSwapV3(
        address sendingAssetId,
        uint256 amount,
        bytes memory onchainSwapData
    )
        internal
        view
        returns (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        )
    {
        return _buildOnchainSwapV3(sendingAssetId, amount, onchainSwapData, 0);
    }

    /// @dev Same as above but binds a specific router `fee` into the signed
    ///      payload (finding #8: the backend commits to the fee it quoted against).
    function _buildOnchainSwapV3(
        address sendingAssetId,
        uint256 amount,
        bytes memory onchainSwapData,
        uint256 feeValue
    )
        internal
        view
        returns (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        )
    {
        bd = ILiFi.BridgeData({
            transactionId: keccak256("exsc-267"),
            bridge: "symbiosis",
            integrator: "lifi",
            referrer: address(0),
            sendingAssetId: sendingAssetId,
            receiver: NON_EVM_ADDRESS,
            minAmount: amount,
            destinationChainId: LIFI_CHAIN_ID_BTC,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        sd.refundRecipient = USER_SENDER;
        sd.viaOnchainSwapV3 = true;
        sd.dex = ONSWAP_DEX;
        sd.dexgateway = ONSWAP_DEX;
        sd.onchainSwapData = onchainSwapData;
        sd.nonEvmReceiver = BTC_RECEIVER;
        sd.fee = feeValue;
        sd.deadline = block.timestamp + 1 hours;

        bytes32 digest = OnchainSwapV3Signing.digest(
            bd,
            sd,
            address(symbiosisFacet),
            block.chainid
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BACKEND_SIGNER_PK, digest);
        sd.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Replays a real on-chain onswap route (syBTC -> Bitcoin) through the
    ///      diamond and asserts the LI.FI events. `onchainSwapData` is the exact
    ///      `calldata_` arg of a real onswap tx mined at this fork block.
    function _bridgeViaOnchainSwapV3(
        address sendingAssetId,
        uint256 amount,
        bytes memory onchainSwapData
    ) internal {
        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(sendingAssetId, amount, onchainSwapData);

        uint256 value;
        vm.startPrank(USER_SENDER);
        if (sendingAssetId == address(0)) {
            value = amount;
        } else {
            deal(sendingAssetId, USER_SENDER, amount);
            IERC20(sendingAssetId).approve(address(symbiosisFacet), amount);
        }

        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit BridgeToNonEVMChainBytes32(
            bd.transactionId,
            bd.destinationChainId,
            BTC_RECEIVER
        );

        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit LiFiTransferStarted(bd);

        symbiosisFacet.startBridgeTokensViaSymbiosis{ value: value }(bd, sd);
        vm.stopPrank();
    }
}

// NOTE: no native-input fork test. On-chain native onswap routes go through
// aggregator/RFQ swaps (1inch, FermiSwapper) whose calldata is quote/signature/
// deadline-bound and does not replay deterministically on a fork. The facet's
// native branch differs from the ERC-20 branch only in forwarding msg.value
// instead of approving the gateway - the same value-forwarding pattern the
// metaRoute path fork-tests via testBase_CanBridgeNativeTokens.

/// @notice USDC -> Bitcoin, replaying onswap tx
///         0x7db43c8ef6f2d34a1b9c5e7bfc466d251137f3664e0a7223bb5146ab21a99679
contract SymbiosisFacetOnchainSwapV3ERC20ForkTest is
    SymbiosisOnchainSwapV3ForkTestBase
{
    uint256 internal constant ONSWAP_AMOUNT = 10000000000;

    function _forkBlock() internal pure override returns (uint256) {
        return 25457168;
    }

    function test_CanBridgeERC20TokensViaOnchainSwapV3() public {
        _bridgeViaOnchainSwapV3(
            ADDRESS_USDC,
            ONSWAP_AMOUNT,
            _onswapCalldata()
        );
    }

    /// Finding #8: nonzero OnchainSwapV3 router fee ///

    uint256 internal constant NONZERO_FEE = 0.01 ether;

    /// @dev With a nonzero router fee, an ERC-20 route still succeeds: the facet
    ///      forwards the fee as native on top (msg.value == fee), so the router's
    ///      `require(msg.value >= fee)` passes and `msg.value - fee == 0` reaches
    ///      the inner ERC-20 swap exactly as in the fee==0 case.
    function test_ERC20ViaOnchainSwapV3_withNonZeroFee_succeeds() public {
        _setRouterFee(NONZERO_FEE);

        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(
                ADDRESS_USDC,
                ONSWAP_AMOUNT,
                _onswapCalldata(),
                NONZERO_FEE
            );

        vm.deal(USER_SENDER, NONZERO_FEE);
        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, ONSWAP_AMOUNT);
        IERC20(ADDRESS_USDC).approve(address(symbiosisFacet), ONSWAP_AMOUNT);

        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit BridgeToNonEVMChainBytes32(
            bd.transactionId,
            bd.destinationChainId,
            BTC_RECEIVER
        );

        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit LiFiTransferStarted(bd);

        symbiosisFacet.startBridgeTokensViaSymbiosis{ value: NONZERO_FEE }(
            bd,
            sd
        );
        vm.stopPrank();
    }

    /// @dev For a native input the fee is added ON TOP of the bridged amount:
    ///      the router is called with value == minAmount + fee, so the full
    ///      minAmount still reaches the inner swap (the fee no longer silently
    ///      eats into the signed amount). onswap is mocked because on-chain
    ///      native routes do not replay deterministically (see NOTE above).
    function test_NativeViaOnchainSwapV3_forwardsFeeOnTop() public {
        _setRouterFee(NONZERO_FEE);

        uint256 amount = 1 ether;
        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(address(0), amount, hex"abcdef", NONZERO_FEE);

        vm.mockCall(
            ONCHAIN_SWAP_V3,
            abi.encodeWithSelector(IOnchainSwapV3.onswap.selector),
            ""
        );

        vm.expectCall(
            ONCHAIN_SWAP_V3,
            amount + NONZERO_FEE,
            abi.encodeCall(
                IOnchainSwapV3.onswap,
                (address(0), amount, sd.dex, sd.dexgateway, sd.onchainSwapData)
            )
        );

        vm.deal(USER_SENDER, amount + NONZERO_FEE);
        vm.startPrank(USER_SENDER);

        symbiosisFacet.startBridgeTokensViaSymbiosis{
            value: amount + NONZERO_FEE
        }(bd, sd);
        vm.stopPrank();
    }

    /// @dev A quote signed against one fee is rejected once the router owner has
    ///      changed the live fee (stale quote): live fee != signed fee.
    function testRevert_OnchainSwapV3FeeMismatch() public {
        _setRouterFee(NONZERO_FEE);

        // signed against fee == 0 while the router now charges NONZERO_FEE
        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(
                ADDRESS_USDC,
                ONSWAP_AMOUNT,
                _onswapCalldata()
            );

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, ONSWAP_AMOUNT);
        IERC20(ADDRESS_USDC).approve(address(symbiosisFacet), ONSWAP_AMOUNT);

        vm.expectRevert(OnchainSwapV3FeeMismatch.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(bd, sd);
        vm.stopPrank();
    }

    /// @dev ERC-20 input: the fee must be funded by msg.value, never skimmed
    ///      from stray diamond balance. Too little msg.value reverts.
    function testRevert_ERC20ViaOnchainSwapV3_insufficientMsgValueForFee()
        public
    {
        _setRouterFee(NONZERO_FEE);

        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(
                ADDRESS_USDC,
                ONSWAP_AMOUNT,
                _onswapCalldata(),
                NONZERO_FEE
            );

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, ONSWAP_AMOUNT);
        IERC20(ADDRESS_USDC).approve(address(symbiosisFacet), ONSWAP_AMOUNT);

        vm.expectRevert(InvalidCallData.selector);

        // no native sent for the fee
        symbiosisFacet.startBridgeTokensViaSymbiosis(bd, sd);
        vm.stopPrank();
    }

    /// @dev Native input: msg.value must cover minAmount + fee. Sending only
    ///      minAmount (enough for depositAsset) still reverts on the fee guard.
    function testRevert_NativeViaOnchainSwapV3_insufficientMsgValueForFee()
        public
    {
        _setRouterFee(NONZERO_FEE);

        uint256 amount = 1 ether;
        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(address(0), amount, hex"abcdef", NONZERO_FEE);

        vm.deal(USER_SENDER, amount);
        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidCallData.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis{ value: amount }(bd, sd);
        vm.stopPrank();
    }

    function testRevert_OnchainSwapV3ReplayProtection() public {
        (
            ILiFi.BridgeData memory bd,
            SymbiosisFacet.SymbiosisData memory sd
        ) = _buildOnchainSwapV3(
                ADDRESS_USDC,
                ONSWAP_AMOUNT,
                _onswapCalldata()
            );

        vm.startPrank(USER_SENDER);
        deal(ADDRESS_USDC, USER_SENDER, ONSWAP_AMOUNT * 2);
        IERC20(ADDRESS_USDC).approve(
            address(symbiosisFacet),
            ONSWAP_AMOUNT * 2
        );

        // first use of the backend-signed quote succeeds
        symbiosisFacet.startBridgeTokensViaSymbiosis(bd, sd);

        // replaying the same signed transactionId reverts
        vm.expectRevert(TransactionAlreadyProcessed.selector);

        symbiosisFacet.startBridgeTokensViaSymbiosis(bd, sd);
        vm.stopPrank();
    }

    /// @notice Audit finding #3: on the swap entrypoint the backend quote must be
    ///         verified against the SIGNED (pre-swap) amount, exactly that amount is
    ///         handed to onswap, and the realized surplus is refunded. Proves the
    ///         common case - a swap that returns more than the signed floor -
    ///         succeeds end-to-end; before the fix it reverted InvalidSignature
    ///         because the post-swap (inflated) amount was hashed. Uses fee == 0
    ///         (router default) to stay orthogonal to finding #8's fee handling.
    function test_SwapAndBridgeViaOnchainSwapV3VerifiesSignedAmountAndRefundsSurplus()
        public
    {
        address refundRecipient = makeAddr("onchainSwapV3SwapRefund");
        uint256 surplus = 500 * 1e6; // realized swap output exceeds the signed floor

        (
            LibSwap.SwapData[] memory swaps,
            uint256 amountInMax
        ) = _wethToUsdcExactOut(ONSWAP_AMOUNT + surplus);
        // minAmount is the signed floor (ONSWAP_AMOUNT), NOT the realized output
        ILiFi.BridgeData memory bd = _btcSwapBridgeData(ONSWAP_AMOUNT);
        SymbiosisFacet.SymbiosisData memory sd = _signedSwapData(
            refundRecipient,
            bd
        );

        deal(ADDRESS_WRAPPED_NATIVE, USER_SENDER, amountInMax);
        vm.startPrank(USER_SENDER);
        IERC20(ADDRESS_WRAPPED_NATIVE).approve(
            address(symbiosisFacet),
            amountInMax
        );

        // onswap executes with exactly the signed amount (BTC bridge event fires),
        // rather than reverting InvalidSignature on the inflated post-swap amount.
        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit BridgeToNonEVMChainBytes32(
            bd.transactionId,
            bd.destinationChainId,
            BTC_RECEIVER
        );
        vm.expectEmit(true, true, true, true, address(symbiosisFacet));
        emit LiFiTransferStarted(bd);

        symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis(bd, swaps, sd);
        vm.stopPrank();

        // the realized surplus over the signed amount is refunded to refundRecipient
        assertEq(IERC20(ADDRESS_USDC).balanceOf(refundRecipient), surplus);
        // onswap pulled exactly the signed amount: no USDC dust left in the diamond
        assertEq(IERC20(ADDRESS_USDC).balanceOf(address(symbiosisFacet)), 0);
    }

    /// @dev WETH -> USDC exact-output source swap into the diamond (leftover WETH
    ///      is refunded by the facet). Kept out of the test body to bound stack depth.
    function _wethToUsdcExactOut(
        uint256 targetOut
    )
        internal
        view
        returns (LibSwap.SwapData[] memory swaps, uint256 amountInMax)
    {
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;
        uint256[] memory amountsIn = uniswap.getAmountsIn(targetOut, path);
        amountInMax = amountsIn[0] * 2;

        swaps = new LibSwap.SwapData[](1);
        swaps[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: ADDRESS_WRAPPED_NATIVE,
            receivingAssetId: ADDRESS_USDC,
            fromAmount: amountInMax,
            callData: abi.encodeWithSelector(
                uniswap.swapTokensForExactTokens.selector,
                targetOut,
                amountInMax,
                path,
                address(symbiosisFacet),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });
    }

    /// @dev BTC-destination bridgeData for the OnchainSwapV3 swap entrypoint, with
    ///      minAmount pinned to the backend-signed floor.
    function _btcSwapBridgeData(
        uint256 signedAmount
    ) internal view returns (ILiFi.BridgeData memory bd) {
        bd = ILiFi.BridgeData({
            transactionId: keccak256("exsc-267-swap-surplus"),
            bridge: "symbiosis",
            integrator: "lifi",
            referrer: address(0),
            sendingAssetId: ADDRESS_USDC,
            receiver: NON_EVM_ADDRESS,
            minAmount: signedAmount,
            destinationChainId: LIFI_CHAIN_ID_BTC,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });
    }

    /// @dev Backend-signed SymbiosisData for the OnchainSwapV3 swap entrypoint
    ///      (fee == 0, matching the router's default live fee).
    function _signedSwapData(
        address refundRecipient,
        ILiFi.BridgeData memory bd
    ) internal view returns (SymbiosisFacet.SymbiosisData memory sd) {
        sd.refundRecipient = refundRecipient;
        sd.viaOnchainSwapV3 = true;
        sd.dex = ONSWAP_DEX;
        sd.dexgateway = ONSWAP_DEX;
        sd.onchainSwapData = _onswapCalldata();
        sd.nonEvmReceiver = BTC_RECEIVER;
        sd.deadline = block.timestamp + 1 hours;

        bytes32 digest = OnchainSwapV3Signing.digest(
            bd,
            sd,
            address(symbiosisFacet),
            block.chainid
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BACKEND_SIGNER_PK, digest);
        sd.signature = abi.encodePacked(r, s, v);
    }

    function _onswapCalldata() internal pure returns (bytes memory) {
        return
            hex"bc982fc400000000000000000000000000000000000000000000000000000002540be40000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000236000000000000000000000000000000000000000000000000000000000000023e0000000000000000000000000000000000000000000000000000000000000246000000000000000000000000000000000000000000000000000000000000024e0000000000000000000000000e350879fec09cc2d551289ce559e795746a83dc50000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000020c00000000000000000000000000000000000000000000000000000000000002140000000000000000000000000000000000000000000000000000000000000202490411a32000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b00000000000000000000000009d479e04d2dd46aad77618435e5c639ea76926400000000000000000000000000000000000000000000000000000002540be4000000000000000000000000000000000000000000000000000000000000f2df590000000000000000000000000000000000000000000000000000000000f417ca00000000000000000000000000000000000000000000000000000000000000020000000000000000000000003254ae00947e44b7fd03f50b93b9acfed59f962000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000ac00000000000000000000000000000000000000000000000000000000000000dc000000000000000000000000000000000000000000000000000000000000010c00000000000000000000000000000000000000000000000000000000000001ac00000000000000000000000000000000000000000000000000000000000001be00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000094451a74316000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000100000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000008c000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064eb5625d9000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000008487517c45000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000004a424856bc300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003070b0e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000060000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000026400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000002449f865422000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000000000010000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000104e5b07cdb00000000000000000000000040ab23e8f571bf19a85605b9638e50cc25a256ec00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002edac17f958d2ee523a2206206994597c13d831ec70000002260fac5e5542a773aa44fbcfedf7c193bc2c5990000640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000002449f865422000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000104e5b07cdb00000000000000000000000056534741cd8b152df6d48adf7ac51f75169a83b200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002edac17f958d2ee523a2206206994597c13d831ec70001f42260fac5e5542a773aa44fbcfedf7c193bc2c59900000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000094451a743160000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c5990000000000000000000000000000000100000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000008c000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064eb5625d90000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000008487517c450000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c59900000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000004a424856bc300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003070b0e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c5990000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad00000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c59900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad000000000000000000000000a8f8296f4053fd65e89b245d6c7f983a70234c8b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000044000000000000000000000000000000000000000000000000000000000000026400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000648a6a1e8500000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad000000000000000000000000922164bbbd36acf9e854acbbf32facc949fcaeef0000000000000000000000000000000000000000000000000000000000f417ca00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001a49f86542200000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad00000000000000000000000000000001000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000064d1660f9900000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad00000000000000000000000009d479e04d2dd46aad77618435e5c639ea769264000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000447ff7b0d20000000000000000000000000000000000000000000000000000000000f417ca00000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e4a0d9557000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad73796d62696f7369732d61707000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001600144ad6df059d1fe5c78e5893057ebe61f6c4c6c8d7000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000006352a56caadc4f1e25cd6c75970fa768a3304e640000000000000000000000002559441724e04f7855e2b6422979a3a6cbaccb96000000000000000000000000d7c3df25683871d18bc838e4f619126442dd38b30000000000000000000000000000000000000000000000000000000000000003000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad00000000000000000000000001a8b61e7b03891a736b5df865e0ef9c511850ad00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    }
}
