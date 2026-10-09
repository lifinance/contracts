// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "lib/solmate/src/tokens/ERC20.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { LibSwap } from "../../../src/Libraries/LibSwap.sol";
import { EcoFacet } from "../../../src/Facets/EcoFacet.sol";
import { IEcoPortal } from "../../../src/Interfaces/IEcoPortal.sol";
import { ITokenMessenger } from "../../../src/Interfaces/ITokenMessenger.sol";
import { ILiFi } from "../../../src/Interfaces/ILiFi.sol";
import { InvalidConfig, InvalidReceiver, InvalidNonEVMReceiver, InvalidSignature, NativeAssetNotSupported } from "../../../src/Errors/GenericErrors.sol";
import { LibBytes } from "../../../src/Libraries/LibBytes.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { TestEcoBackendSig } from "../utils/TestEcoBackendSig.sol";

contract TestEcoFacet is EcoFacet, TestWhitelistManagerBase {
    constructor(
        IEcoPortal _portal,
        address _backendSigner,
        ITokenMessenger _tokenMessenger
    ) EcoFacet(_portal, _backendSigner, _tokenMessenger) {}
}

contract EcoFacetTest is TestBaseFacet, TestEcoBackendSig {
    TestEcoFacet internal ecoFacet;
    address internal constant PORTAL =
        0xB5e58A8206473Df3Ab9b8DDd3B0F84c0ba68F8b5;
    uint256 internal constant TOKEN_SOLVER_REWARD = 10 * 10 ** 6; // 10 USDC (6 decimals)
    address internal constant TOKEN_MESSENGER =
        0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;
    uint32 internal constant ARBITRUM_CCTP_DOMAIN = 3;
    uint32 internal constant CCTP_FAST_FINALITY_THRESHOLD = 1000;
    /// @dev maxFee = amount / 1000 (10 bps), above Circle's fast-transfer minimum
    uint256 internal constant CCTP_MAX_FEE_DIVISOR = 1000;
    uint256 internal constant HYPEREVM_CHAIN_ID = 999;
    address internal constant HYPEREVM_USDC =
        0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address internal constant HYPERCORE_DEPOSITOR =
        0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    address internal constant HYPERCORE_ROUTE_RECEIVER =
        0x86DBd094BC7436BD106C53a6a137Ab0Ab810A6A9;
    /// @dev encodedRoute of Arbitrum tx 0x7d7a7e2e6866ee087f26005dcb9715818df23bfc983789bd6f841091e4adbef4
    ///      (Eco quote to HyperCore): approve + CoreDepositWallet.depositFor.
    bytes internal constant HYPERCORE_PRODUCTION_ROUTE =
        hex"0000000000000000000000000000000000000000000000000000000000000020"
        hex"ec00ec00ec00ec00ec00ec00ec00ec00aaaf8940ec75ab10853ffaf8da8624ab"
        hex"000000000000000000000000000000000000000000000000000000006ab275de"
        hex"000000000000000000000000ec000064576f9c95a8623bc0eff3db6d296ea6df"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"00000000000000000000000000000000000000000000000000000000000000c0"
        hex"0000000000000000000000000000000000000000000000000000000000000120"
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f"
        hex"00000000000000000000000000000000000000000000000000000000002c1d3e"
        hex"0000000000000000000000000000000000000000000000000000000000000002"
        hex"0000000000000000000000000000000000000000000000000000000000000040"
        hex"0000000000000000000000000000000000000000000000000000000000000120"
        hex"000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f"
        hex"0000000000000000000000000000000000000000000000000000000000000060"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000044"
        hex"095ea7b30000000000000000000000006b9e773128f453f5c2c60935ee2de2cb"
        hex"c5390a2400000000000000000000000000000000000000000000000000000000"
        hex"002c1d3e00000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000006b9e773128f453f5c2c60935ee2de2cbc5390a24"
        hex"0000000000000000000000000000000000000000000000000000000000000060"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000064"
        hex"c23c545a00000000000000000000000086dbd094bc7436bd106c53a6a137ab0a"
        hex"b810a6a900000000000000000000000000000000000000000000000000000000"
        hex"002c1d3e00000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000000";

    function setUp() public {
        customBlockNumberForForking = 35717845;
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        initTestBase();
        addLiquidity(
            ADDRESS_USDC,
            ADDRESS_DAI,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals(),
            1000000 * 10 ** ERC20(ADDRESS_DAI).decimals()
        );
        addLiquidity(
            ADDRESS_WRAPPED_NATIVE,
            ADDRESS_USDC,
            100 ether,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals()
        );

        backendSignerPrivateKey = 0xB0B;
        backendSignerAddress = vm.addr(backendSignerPrivateKey);

        ecoFacet = new TestEcoFacet(
            IEcoPortal(PORTAL),
            backendSignerAddress,
            ITokenMessenger(TOKEN_MESSENGER)
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = ecoFacet.startBridgeTokensViaEco.selector;
        functionSelectors[1] = ecoFacet
            .swapAndStartBridgeTokensViaEco
            .selector;
        functionSelectors[2] = ecoFacet.addAllowedContractSelector.selector;

        addFacet(diamond, address(ecoFacet), functionSelectors);
        ecoFacet = TestEcoFacet(address(diamond));
        ecoVerifyingContract = address(diamond);
        ecoFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        ecoFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        ecoFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(ecoFacet), "EcoFacet");

        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 10;

        addToMessageValue = 0;
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        _startEco(bridgeData, ecoData);
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        _swapAndStartEco(bridgeData, swapData, ecoData);
    }

    /// @dev Signs the eco data with the backend key and calls the bridge
    ///      entrypoint. Signing is a cheatcode call, so it does not interfere
    ///      with a preceding `vm.expectRevert`/`vm.expectEmit`.
    function _startEco(
        ILiFi.BridgeData memory _bridgeData,
        EcoFacet.EcoData memory _ecoData
    ) internal {
        _ecoData.signature = _signEcoData(_bridgeData, _ecoData);
        ecoFacet.startBridgeTokensViaEco(_bridgeData, _ecoData);
    }

    function _swapAndStartEco(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] memory _swapData,
        EcoFacet.EcoData memory _ecoData
    ) internal {
        _ecoData.signature = _signEcoData(_bridgeData, _ecoData);
        ecoFacet.swapAndStartBridgeTokensViaEco(
            _bridgeData,
            _swapData,
            _ecoData
        );
    }

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(
            IEcoPortal(address(0)),
            backendSignerAddress,
            ITokenMessenger(TOKEN_MESSENGER)
        );
    }

    function testRevert_WhenBackendSignerIsZero() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(
            IEcoPortal(PORTAL),
            address(0),
            ITokenMessenger(TOKEN_MESSENGER)
        );
    }

    function testRevert_NativeTokenNotSupported() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data with native token
        bridgeData.sendingAssetId = address(0); // Native token
        bridgeData.minAmount = 0.1 ether;

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC, // Route can use any token
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        // Should revert when trying to bridge native tokens
        vm.expectRevert(NativeAssetNotSupported.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_NativeTokenNotSupportedInSwap() public {
        vm.startPrank(USER_SENDER);

        // Set up swap to native token
        bridgeData.sendingAssetId = address(0); // Native token
        bridgeData.minAmount = 0.1 ether;
        bridgeData.hasSourceSwaps = true;

        // Swap DAI to native
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0), // Swapping to native
                fromAmount: 1000 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    bridgeData.minAmount,
                    1000 * 10 ** 18,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // Should revert when trying to swap and bridge native tokens
        vm.expectRevert(NativeAssetNotSupported.selector);
        ecoFacet.swapAndStartBridgeTokensViaEco{ value: 0.0001 ether }(
            bridgeData,
            swapData,
            ecoData
        );

        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {}

    function testBase_CanSwapAndBridgeNativeTokens() public override {}

    // Override the base test to handle ERC20 token rewards properly
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount + TOKEN_SOLVER_REWARD)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override fuzzed test to handle token rewards properly
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        // Get user's USDC balance
        uint256 userBalance = usdc.balanceOf(USER_SENDER);

        // Ensure amount is within valid range
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        // Ensure we have enough balance for total amount
        vm.assume(amount + TOKEN_SOLVER_REWARD <= userBalance);

        // Set up bridge data - minAmount is now the total (fee-inclusive)
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount + TOKEN_SOLVER_REWARD;

        vm.writeLine(logFilePath, vm.toString(amount));

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override swap and bridge test to handle token rewards properly
    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 totalAmountNeeded = defaultUSDCAmount + TOKEN_SOLVER_REWARD;

        // Calculate DAI amount needed to get totalAmountNeeded USDC
        uint256[] memory amounts = uniswap.getAmountsIn(
            totalAmountNeeded,
            path
        );
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    totalAmountNeeded,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        bridgeData.minAmount = totalAmountNeeded;
        bridgeData.hasSourceSwaps = true;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            totalAmountNeeded,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        uint256 daiBalanceBefore = dai.balanceOf(USER_SENDER);
        uint256 usdcBalanceBefore = usdc.balanceOf(USER_SENDER);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            dai.balanceOf(USER_SENDER),
            daiBalanceBefore - swapData[0].fromAmount
        );
        assertEq(usdc.balanceOf(USER_SENDER), usdcBalanceBefore);
        assertEq(dai.balanceOf(USER_RECEIVER), 0);
        assertEq(usdc.balanceOf(USER_RECEIVER), 0);
    }

    function test_BridgeToSolanaWithEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: solanaAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaEncodedRoute,
            solanaATA: 0x8f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2,
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            solanaAddress
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // Execute bridge
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_BridgeToTron() public {
        vm.startPrank(USER_SENDER);

        // Tron follows the non-EVM convention: sentinel receiver + the real
        // recipient carried in nonEVMReceiver and cross-checked against the route
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Tron uses the same Route struct encoding as EVM chains
        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(USER_RECEIVER),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            bytes32(uint256(uint160(USER_RECEIVER)))
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Route pays USER_RECEIVER but nonEVMReceiver points at a different address
        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(address(0x9999)),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithInvalidNonEVMReceiverLength() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encodePacked(USER_RECEIVER), // 20 bytes, not 32
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithNonLeftPaddedNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Route pays USER_RECEIVER; nonEVMReceiver carries the same address in its
        // low 20 bytes but with dirty high bytes. The receiver emitted on-chain
        // must equal the validated one, so a non-left-padded value is rejected.
        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        bytes32 dirtyReceiver = bytes32(
            (uint256(1) << 160) | uint256(uint160(USER_RECEIVER))
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encodePacked(dirtyReceiver),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibBytes.NotAnAddress.selector,
                dirtyReceiver
            )
        );
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithZeroReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // A zero non-EVM receiver must be rejected, mirroring the EVM path where
        // validateBridgeData already rejects a zero bridgeData.receiver.
        bytes memory tronEncodedRoute = _createEncodedRoute(
            address(0),
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(address(0)),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithNonTransferFinalCall() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Route whose final call is not a transfer(address,uint256); the receiver
        // decode must reject it instead of reading a bogus address.
        IEcoPortal.TokenAmount[] memory tokens = new IEcoPortal.TokenAmount[](
            1
        );
        tokens[0] = IEcoPortal.TokenAmount({
            token: bridgeData.sendingAssetId,
            amount: bridgeData.minAmount
        });

        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: bridgeData.sendingAssetId,
            data: abi.encodeWithSelector(
                IERC20.approve.selector,
                USER_RECEIVER,
                bridgeData.minAmount
            ),
            value: 0
        });

        EcoFacet.Route memory route = EcoFacet.Route({
            salt: keccak256("eco.route.badselector"),
            deadline: uint64(block.timestamp + 1 days),
            portal: PORTAL,
            nativeAmount: 0,
            tokens: tokens,
            calls: calls
        });

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(USER_RECEIVER),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: abi.encode(route),
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithShortFinalCallData() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Final call carries the transfer selector but only 36 bytes of calldata
        // (selector + recipient word, missing the amount word); the receiver
        // decode must reject it via the length guard before reading the address.
        IEcoPortal.TokenAmount[] memory tokens = new IEcoPortal.TokenAmount[](
            1
        );
        tokens[0] = IEcoPortal.TokenAmount({
            token: bridgeData.sendingAssetId,
            amount: bridgeData.minAmount
        });

        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: bridgeData.sendingAssetId,
            data: abi.encodeWithSelector(
                IERC20.transfer.selector,
                USER_RECEIVER
            ),
            value: 0
        });

        EcoFacet.Route memory route = EcoFacet.Route({
            salt: keccak256("eco.route.shortcalldata"),
            deadline: uint64(block.timestamp + 1 days),
            portal: PORTAL,
            nativeAmount: 0,
            tokens: tokens,
            calls: calls
        });

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(USER_RECEIVER),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: abi.encode(route),
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithEmptyRouteCalls() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Route decodes successfully but has no calls; the receiver decode must
        // reject it with InvalidReceiver rather than underflowing calls.length.
        IEcoPortal.TokenAmount[] memory tokens = new IEcoPortal.TokenAmount[](
            1
        );
        tokens[0] = IEcoPortal.TokenAmount({
            token: bridgeData.sendingAssetId,
            amount: bridgeData.minAmount
        });

        EcoFacet.Call[] memory calls = new EcoFacet.Call[](0);

        EcoFacet.Route memory route = EcoFacet.Route({
            salt: keccak256("eco.route.empty"),
            deadline: uint64(block.timestamp + 1 days),
            portal: PORTAL,
            nativeAmount: 0,
            tokens: tokens,
            calls: calls
        });

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(USER_RECEIVER),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: abi.encode(route),
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        // A concrete receiver is not allowed for Tron; it must use the sentinel
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = USER_RECEIVER;

        bytes memory tronEncodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tronEncodedRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_WithoutEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Test with any destination chain
        bridgeData.destinationChainId = 10; // Optimism

        // Create EcoData without encodedRoute
        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: "", // Missing encodedRoute (now required for all chains)
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_NonEVMAddressWithoutNonEVMReceiver() public {
        // Test for InvalidReceiver error when NON_EVM_ADDRESS is set but nonEVMReceiver is empty
        vm.startPrank(USER_SENDER);

        // Set receiver to NON_EVM_ADDRESS
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;

        // Create EcoData with empty nonEVMReceiver
        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "", // Empty nonEVMReceiver should trigger InvalidReceiver
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: hex"0102030405060708090a0b0c0d0e0f10",
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect InvalidReceiver revert
        vm.expectRevert(InvalidReceiver.selector);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_RouteReceiverMismatch() public {
        // Test for InvalidReceiver error when the receiver in the route doesn't match bridgeData.receiver
        // This triggers line 291 in EcoFacet.sol
        vm.startPrank(USER_SENDER);

        // Set up bridge data for an EVM chain
        bridgeData.destinationChainId = 10; // Optimism
        bridgeData.receiver = USER_RECEIVER; // Set to USER_RECEIVER

        // Create a route with a DIFFERENT receiver address to trigger the mismatch
        address wrongReceiver = address(0x9999);
        bytes memory routeWithWrongReceiver = _createEncodedRoute(
            wrongReceiver, // Different receiver than bridgeData.receiver
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: routeWithWrongReceiver, // Route has different receiver
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect InvalidReceiver revert from line 291
        vm.expectRevert(InvalidReceiver.selector);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_ChainIdExceedsUint64Max() public {
        vm.startPrank(USER_SENDER);

        ILiFi.BridgeData memory overflowBridgeData = bridgeData;
        overflowBridgeData.destinationChainId = uint256(type(uint64).max) + 1;

        // Use the helper to create a properly encoded route
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            overflowBridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        overflowBridgeData.minAmount =
            overflowBridgeData.minAmount +
            TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, overflowBridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(overflowBridgeData, ecoData);

        vm.stopPrank();
    }

    function test_ChainIdAtUint64Boundary() public {
        vm.startPrank(USER_SENDER);

        ILiFi.BridgeData memory boundaryBridgeData = bridgeData;
        boundaryBridgeData.destinationChainId = type(uint64).max;
        boundaryBridgeData.sendingAssetId = ADDRESS_USDC;
        boundaryBridgeData.minAmount = 100 * 10 ** 6;

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            boundaryBridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        boundaryBridgeData.minAmount =
            boundaryBridgeData.minAmount +
            TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, boundaryBridgeData.minAmount);

        _startEco(boundaryBridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_InvalidABIEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        // Set up for an EVM chain
        bridgeData.destinationChainId = 10; // Optimism

        // Create data that cannot be ABI decoded as a Route struct
        bytes
            memory invalidRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: invalidRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Will revert during ABI decode attempt
        vm.expectRevert();
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_RouteTooShortForABIDecode() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Create data that's too short to be a valid ABI-encoded Route
        bytes memory tooShortRoute = hex"a9059cbb"; // Only 4 bytes

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: bytes(""),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Will revert during ABI decode attempt
        vm.expectRevert();
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_TronWithInvalidRoute() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        bridgeData.receiver = NON_EVM_ADDRESS;

        // Create data that cannot be ABI decoded as a Route struct
        bytes
            memory invalidTronRoute = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: abi.encode(USER_RECEIVER),
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: invalidTronRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Will revert during ABI decode attempt
        vm.expectRevert();
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_ValidEVMRouteWithCorrectTransfer() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 10; // Optimism

        // Use the helper to create a properly encoded Route
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SignatureFromUnauthorizedSigner() public {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        uint256 unauthorizedKey = 0xBAD5169;
        ecoData.signature = _signEcoDataWith(
            unauthorizedKey,
            bridgeData,
            ecoData
        );

        vm.expectRevert(InvalidSignature.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SignatureExpired() public {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        ecoData.deadline = block.timestamp - 1;
        ecoData.signature = _signEcoData(bridgeData, ecoData);

        vm.expectRevert(EcoFacet.SignatureExpired.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    // The signature commits to keccak256(encodedRoute), so a caller cannot swap
    // in a different route after signing - even one that still pays the correct
    // receiver and would pass the on-chain receiver cross-check (audit finding:
    // unverified route contents).
    function testRevert_TamperedEncodedRoute() public {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        ecoData.signature = _signEcoData(bridgeData, ecoData);

        ecoData.encodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount + 1
        );

        vm.expectRevert(InvalidSignature.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    // The signature commits to the prover, so a caller cannot swap in a
    // malicious prover after signing (audit finding: caller-supplied prover).
    function testRevert_TamperedProver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.minAmount = defaultUSDCAmount + TOKEN_SOLVER_REWARD;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        EcoFacet.EcoData memory ecoData = _getValidEcoData();
        ecoData.signature = _signEcoData(bridgeData, ecoData);

        ecoData.prover = address(0xDEAD);

        vm.expectRevert(InvalidSignature.selector);
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_IsEVMChainCalledWithSolanaChainId() public {
        vm.startPrank(USER_SENDER);

        // Set destination to Solana but use EVM receiver (invalid config, but covers the branch)
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = USER_RECEIVER; // EVM address, not NON_EVM_ADDRESS

        // Create a valid Route struct encoding
        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaEmptyNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes
            memory solanaRoute = hex"9e6c10e6d964ed8b7015b410e7049dc1450b4bdcda6976d16b98dab756c33c2fa54fc9680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1)),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaNonEVMReceiverTooLong() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes
            memory solanaRoute = hex"fefd31b99638603f4dbb9bc6d42d223ec4b4d4ab5509910efa68063ba9f4fac57e0ed4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        bytes memory tooLongAddress = new bytes(45);
        for (uint256 i = 0; i < 45; i++) {
            tooLongAddress[i] = bytes1(uint8(65 + (i % 26)));
        }

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaRoute,
            solanaATA: bytes32(uint256(1)),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaRouteTooShort() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes memory tooShortRoute = hex"9e6c10e6d964ed8b7015b410e7049dc1"; // [pre-commit-checker: not a secret]

        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a"; // [pre-commit-checker: not a secret]

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: solanaAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: tooShortRoute,
            solanaATA: bytes32(uint256(1)),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_BridgeToSolanaWithSolanaATAZero() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(0), // Set to zero - should revert
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect InvalidConfig revert due to solanaATA being zero
        vm.expectRevert(InvalidConfig.selector);

        // Execute bridge
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaATADoesNotMatch() public {
        vm.startPrank(USER_SENDER);

        // Set up bridge data for Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS; // Must use NON_EVM_ADDRESS for Solana

        // Solana uses CalldataWithAccounts encoding
        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000"; // [pre-commit-checker: not a secret]

        // Dev Solana address (base58 encoded address in bytes)
        bytes
            memory solanaAddress = hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: solanaAddress, // Required for NON_EVM_ADDRESS
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaEncodedRoute,
            solanaATA: bytes32(uint256(0x123456789abcdef)), // Different ATA that doesn't match the route
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Expect revert due to ATA mismatch
        vm.expectRevert(InvalidReceiver.selector);

        // Execute bridge
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_RefundRecipientZeroAddress() public {
        vm.startPrank(USER_SENDER);

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: address(0),
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_RefundRecipientIsUsedInReward() public {
        vm.startPrank(USER_SENDER);

        address customRefundRecipient = address(0xABCD);

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: customRefundRecipient,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        IEcoPortal.TokenAmount[]
            memory rewardTokens = new IEcoPortal.TokenAmount[](1);
        rewardTokens[0] = IEcoPortal.TokenAmount({
            token: bridgeData.sendingAssetId,
            amount: bridgeData.minAmount
        });

        IEcoPortal.Reward memory expectedReward = IEcoPortal.Reward({
            creator: customRefundRecipient,
            prover: address(0x1234),
            deadline: uint64(block.timestamp + 2 days),
            nativeAmount: 0,
            tokens: rewardTokens
        });

        vm.expectCall(
            PORTAL,
            abi.encodeWithSelector(
                IEcoPortal.publishAndFund.selector,
                uint64(bridgeData.destinationChainId),
                validRoute,
                expectedReward,
                false
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_BridgeToHyperCoreWithProductionRoute() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = HYPEREVM_CHAIN_ID;
        bridgeData.receiver = HYPERCORE_ROUTE_RECEIVER;
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            HYPERCORE_PRODUCTION_ROUTE
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectCall(
            PORTAL,
            abi.encodeWithSelector(
                IEcoPortal.publishAndFund.selector,
                uint64(HYPEREVM_CHAIN_ID),
                HYPERCORE_PRODUCTION_ROUTE,
                _expectedReward(ecoData),
                false
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    /// @dev Pins the facet's Route/Call mirror to Eco's real encoding: a
    ///      field-order or arity drift would decode the production route wrong.
    function test_ProductionRouteDecodesWithEcoCallLayout() public pure {
        EcoFacet.Route memory route = abi.decode(
            HYPERCORE_PRODUCTION_ROUTE,
            (EcoFacet.Route)
        );

        assertEq(route.portal, 0xEC000064576f9C95a8623Bc0eff3db6d296ea6df);
        assertEq(route.tokens.length, 1);
        assertEq(route.tokens[0].token, HYPEREVM_USDC);
        assertEq(route.calls.length, 2);
        assertEq(route.calls[0].target, HYPEREVM_USDC);
        assertEq(route.calls[1].target, HYPERCORE_DEPOSITOR);
        assertEq(route.calls[1].value, 0);
        assertEq(
            route.calls[1].data,
            abi.encodeWithSignature(
                "depositFor(address,uint256,uint32)",
                HYPERCORE_ROUTE_RECEIVER,
                route.tokens[0].amount,
                uint32(0)
            )
        );
    }

    function testRevert_HyperCoreDepositForReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = HYPEREVM_CHAIN_ID;
        bridgeData.receiver = USER_RECEIVER;
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            HYPERCORE_PRODUCTION_ROUTE
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_HyperCoreDepositForMissingArguments() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = HYPEREVM_CHAIN_ID;
        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: HYPERCORE_DEPOSITOR,
            data: abi.encodeWithSignature(
                "depositFor(address,uint256)",
                USER_RECEIVER,
                bridgeData.minAmount
            ),
            value: 0
        });
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            _encodeRoute(calls, HYPEREVM_USDC, bridgeData.minAmount)
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_UnsupportedFinalCall() public {
        vm.startPrank(USER_SENDER);

        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: bridgeData.sendingAssetId,
            data: abi.encodeWithSelector(
                IERC20.approve.selector,
                USER_RECEIVER,
                bridgeData.minAmount
            ),
            value: 0
        });
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            _encodeRoute(
                calls,
                bridgeData.sendingAssetId,
                bridgeData.minAmount
            )
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_BridgeViaCCTPPublishesIntentOnSourceChain() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = ARBITRUM_CHAIN_ID;
        bytes memory route = _createCCTPRoute(
            _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bytes32(0)
            )
        );
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(route);
        IEcoPortal.Reward memory reward = _expectedReward(ecoData);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectCall(
            PORTAL,
            abi.encodeWithSelector(
                IEcoPortal.publishAndFund.selector,
                uint64(block.chainid),
                route,
                reward,
                false
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();

        bytes32 intentHash = keccak256(
            abi.encodePacked(
                uint64(block.chainid),
                keccak256(route),
                keccak256(abi.encode(reward))
            )
        );
        assertEq(
            uint8(IEcoPortal(PORTAL).getRewardStatus(intentHash)),
            uint8(IEcoPortal.Status.Funded)
        );
    }

    function test_SwapAndBridgeViaCCTPPublishesIntentOnSourceChain() public {
        vm.startPrank(USER_SENDER);

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;
        uint256 amountIn = uniswap.getAmountsIn(bridgeData.minAmount, path)[0];

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    bridgeData.minAmount,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
        bridgeData.hasSourceSwaps = true;
        bridgeData.destinationChainId = ARBITRUM_CHAIN_ID;
        bytes memory route = _createCCTPRoute(
            _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bytes32(0)
            )
        );
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(route);

        dai.approve(_facetTestContractAddress, amountIn);

        vm.expectCall(
            PORTAL,
            abi.encodeWithSelector(
                IEcoPortal.publishAndFund.selector,
                uint64(block.chainid),
                route,
                _expectedReward(ecoData),
                false
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        _swapAndStartEco(bridgeData, swapData, ecoData);

        vm.stopPrank();
    }

    /// @dev Runs the CCTP route's calls the way Eco's Executor would, against
    ///      the real TokenMessengerV2, so the fixture the facet accepts is one
    ///      Circle accepts too.
    function test_CCTPRouteBurnsOnTokenMessenger() public {
        address executor = address(0xE8EC);
        EcoFacet.Route memory route = abi.decode(
            _createCCTPRoute(
                _depositForBurnData(
                    bridgeData.minAmount,
                    USER_RECEIVER,
                    ADDRESS_USDC,
                    bytes32(0)
                )
            ),
            (EcoFacet.Route)
        );
        deal(ADDRESS_USDC, executor, bridgeData.minAmount);
        uint256 supplyBefore = usdc.totalSupply();

        vm.startPrank(executor);

        for (uint256 i = 0; i < route.calls.length; i++) {
            (bool success, ) = route.calls[i].target.call{
                value: route.calls[i].value
            }(route.calls[i].data);
            assertTrue(success);
        }

        vm.stopPrank();

        assertEq(usdc.balanceOf(executor), 0);
        assertEq(usdc.totalSupply(), supplyBefore - bridgeData.minAmount);
    }

    function testRevert_CCTPMintRecipientMismatch() public {
        _expectCCTPRouteRevert(
            _depositForBurnData(
                bridgeData.minAmount,
                address(0x9999),
                bridgeData.sendingAssetId,
                bytes32(0)
            ),
            TOKEN_MESSENGER,
            InvalidReceiver.selector
        );
    }

    function testRevert_CCTPBurnAmountBelowBridgedAmount() public {
        _expectCCTPRouteRevert(
            _depositForBurnData(
                bridgeData.minAmount - 1,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bytes32(0)
            ),
            TOKEN_MESSENGER,
            EcoFacet.InvalidCCTPBurn.selector
        );
    }

    function testRevert_CCTPBurnTokenMismatch() public {
        _expectCCTPRouteRevert(
            _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                ADDRESS_DAI,
                bytes32(0)
            ),
            TOKEN_MESSENGER,
            EcoFacet.InvalidCCTPBurn.selector
        );
    }

    function testRevert_CCTPDestinationCallerRestricted() public {
        _expectCCTPRouteRevert(
            _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                LibBytes.toBytes32(address(0xEC0))
            ),
            TOKEN_MESSENGER,
            EcoFacet.InvalidCCTPBurn.selector
        );
    }

    function testRevert_CCTPBurnOnUnknownTokenMessenger() public {
        _expectCCTPRouteRevert(
            _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bytes32(0)
            ),
            address(0xBAD),
            EcoFacet.InvalidCCTPBurn.selector
        );
    }

    function testRevert_CCTPBurnMissingArguments() public {
        _expectCCTPRouteRevert(
            abi.encodeWithSelector(
                ITokenMessenger.depositForBurn.selector,
                bridgeData.minAmount,
                ARBITRUM_CCTP_DOMAIN,
                LibBytes.toBytes32(USER_RECEIVER)
            ),
            TOKEN_MESSENGER,
            InvalidReceiver.selector
        );
    }

    function testRevert_CCTPRouteOnChainWithoutTokenMessenger() public {
        TestEcoFacet facetWithoutCCTP = new TestEcoFacet(
            IEcoPortal(PORTAL),
            backendSignerAddress,
            ITokenMessenger(address(0))
        );
        ecoVerifyingContract = address(facetWithoutCCTP);
        bridgeData.destinationChainId = ARBITRUM_CHAIN_ID;
        EcoFacet.Call memory burn = EcoFacet.Call({
            target: address(0),
            data: _depositForBurnData(
                bridgeData.minAmount,
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bytes32(0)
            ),
            value: 0
        });
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            _createCCTPRoute(burn)
        );
        ecoData.signature = _signEcoData(bridgeData, ecoData);

        vm.expectRevert(EcoFacet.InvalidCCTPBurn.selector);

        facetWithoutCCTP.startBridgeTokensViaEco(bridgeData, ecoData);
    }

    function _expectCCTPRouteRevert(
        bytes memory _burnData,
        address _tokenMessenger,
        bytes4 _expectedError
    ) internal {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = ARBITRUM_CHAIN_ID;
        EcoFacet.EcoData memory ecoData = _ecoDataWithRoute(
            _createCCTPRoute(
                EcoFacet.Call({
                    target: _tokenMessenger,
                    data: _burnData,
                    value: 0
                })
            )
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(_expectedError);

        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    /// @dev Eco's CCTP fulfillment route: approve TokenMessengerV2, then burn.
    function _createCCTPRoute(
        bytes memory _burnData
    ) internal view returns (bytes memory) {
        return
            _createCCTPRoute(
                EcoFacet.Call({
                    target: TOKEN_MESSENGER,
                    data: _burnData,
                    value: 0
                })
            );
    }

    function _createCCTPRoute(
        EcoFacet.Call memory _burn
    ) internal view returns (bytes memory) {
        EcoFacet.Call[] memory calls = new EcoFacet.Call[](2);
        calls[0] = EcoFacet.Call({
            target: bridgeData.sendingAssetId,
            data: abi.encodeWithSelector(
                IERC20.approve.selector,
                TOKEN_MESSENGER,
                bridgeData.minAmount
            ),
            value: 0
        });
        calls[1] = _burn;
        return
            _encodeRoute(
                calls,
                bridgeData.sendingAssetId,
                bridgeData.minAmount
            );
    }

    function _depositForBurnData(
        uint256 _amount,
        address _mintRecipient,
        address _burnToken,
        bytes32 _destinationCaller
    ) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                ITokenMessenger.depositForBurn.selector,
                _amount,
                ARBITRUM_CCTP_DOMAIN,
                LibBytes.toBytes32(_mintRecipient),
                _burnToken,
                _destinationCaller,
                _amount / CCTP_MAX_FEE_DIVISOR,
                CCTP_FAST_FINALITY_THRESHOLD
            );
    }

    function _ecoDataWithRoute(
        bytes memory _encodedRoute
    ) internal view returns (EcoFacet.EcoData memory ecoData) {
        ecoData = _getValidEcoData();
        ecoData.encodedRoute = _encodedRoute;
    }

    function _expectedReward(
        EcoFacet.EcoData memory _ecoData
    ) internal view returns (IEcoPortal.Reward memory) {
        IEcoPortal.TokenAmount[]
            memory rewardTokens = new IEcoPortal.TokenAmount[](1);
        rewardTokens[0] = IEcoPortal.TokenAmount({
            token: bridgeData.sendingAssetId,
            amount: bridgeData.minAmount
        });
        return
            IEcoPortal.Reward({
                creator: _ecoData.refundRecipient,
                prover: _ecoData.prover,
                deadline: _ecoData.rewardDeadline,
                nativeAmount: 0,
                tokens: rewardTokens
            });
    }

    function _createEncodedRoute(
        address receiver,
        address token,
        uint256 amount
    ) internal view returns (bytes memory) {
        EcoFacet.Call[] memory calls = new EcoFacet.Call[](1);
        calls[0] = EcoFacet.Call({
            target: token,
            data: abi.encodeWithSelector(
                IERC20.transfer.selector,
                receiver,
                amount
            ),
            value: 0
        });

        return _encodeRoute(calls, token, amount);
    }

    function _encodeRoute(
        EcoFacet.Call[] memory _calls,
        address _token,
        uint256 _amount
    ) internal view returns (bytes memory) {
        IEcoPortal.TokenAmount[] memory tokens = new IEcoPortal.TokenAmount[](
            1
        );
        tokens[0] = IEcoPortal.TokenAmount({ token: _token, amount: _amount });

        EcoFacet.Route memory route = EcoFacet.Route({
            salt: keccak256("eco.route.test"),
            deadline: uint64(block.timestamp + 1 days),
            portal: PORTAL,
            nativeAmount: 0,
            tokens: tokens,
            calls: _calls
        });

        return abi.encode(route);
    }

    function _getValidEcoData()
        internal
        view
        returns (EcoFacet.EcoData memory)
    {
        bytes memory encodedRoute = _createEncodedRoute(
            USER_RECEIVER,
            bridgeData.sendingAssetId,
            bridgeData.minAmount
        );

        return
            EcoFacet.EcoData({
                nonEVMReceiver: "",
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                encodedRoute: encodedRoute,
                solanaATA: bytes32(0),
                refundRecipient: USER_SENDER,
                deadline: block.timestamp + 1 hours,
                signature: ""
            });
    }

    function testRevert_DuplicateBridgeCallIntentAlreadyFunded() public {
        vm.startPrank(USER_SENDER);

        uint256 amountToBridge = defaultUSDCAmount + TOKEN_SOLVER_REWARD;
        bridgeData.minAmount = amountToBridge;

        deal(ADDRESS_USDC, USER_SENDER, amountToBridge * 2);
        usdc.approve(_facetTestContractAddress, amountToBridge * 2);

        initiateBridgeTxWithFacet(false);

        vm.expectRevert(EcoFacet.IntentAlreadyFunded.selector);
        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_PositiveSlippageRefundedToRefundRecipient() public {
        vm.startPrank(USER_SENDER);

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 totalAmountNeeded = defaultUSDCAmount + TOKEN_SOLVER_REWARD;

        uint256[] memory amounts = uniswap.getAmountsIn(
            totalAmountNeeded,
            path
        );
        uint256 amountIn = amounts[0];

        uint256 amountInWithSlippage = (amountIn * 110) / 100;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountInWithSlippage,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountInWithSlippage,
                    totalAmountNeeded,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        bridgeData.minAmount = totalAmountNeeded;
        bridgeData.hasSourceSwaps = true;

        address refundRecipient = address(0xBEEF);

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 refundRecipientBalanceBefore = usdc.balanceOf(refundRecipient);

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: _createEncodedRoute(
                USER_RECEIVER,
                bridgeData.sendingAssetId,
                bridgeData.minAmount
            ),
            solanaATA: bytes32(0),
            refundRecipient: refundRecipient,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        _swapAndStartEco(bridgeData, swapData, ecoData);

        uint256 refundRecipientBalanceAfter = usdc.balanceOf(refundRecipient);

        assertGt(
            refundRecipientBalanceAfter,
            refundRecipientBalanceBefore,
            "Refund recipient should receive positive slippage"
        );

        vm.stopPrank();
    }

    function testRevert_ProverZeroAddress() public {
        vm.startPrank(USER_SENDER);

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_RewardDeadlineExpired() public {
        vm.startPrank(USER_SENDER);

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: "",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp - 1),
            encodedRoute: validRoute,
            solanaATA: bytes32(0),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_NonEVMAddressForNonSolanaChain() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 10;

        bytes memory validRoute = _createEncodedRoute(
            USER_RECEIVER,
            ADDRESS_USDC,
            100 * 10 ** 6
        );

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: hex"32576271585272443245527261533541747453486e5345646d7242657532546e39344471554872436d576b7a",
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: validRoute,
            solanaATA: bytes32(uint256(1)),
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function testRevert_SolanaAddressTooShort() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = NON_EVM_ADDRESS;

        bytes
            memory solanaEncodedRoute = hex"52a01d29f1d91ab0b57761768e39b85275adf37a9da16dd3640f0f461d2b34e18b15d4680000000065cbce824f4b3a8beb4f9dd87eab57c8cc24eee9bbb886ee4d3206cdb9628ad7000000000000000001000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6164454c00000000000100000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a99b0000000a0000000c64454c0000000000060404000000dadaffa20d79347c07967829bb1a2fb4527985bb805d6e4e1bdaa132452b31630001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6100008f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2000148c1d430876bafc918c7395041939a101ea72fead56b9ec8c4b8e5c7f76d363b0000";

        bytes memory tooShortAddress = hex"32576271585272443245527261533541";

        EcoFacet.EcoData memory ecoData = EcoFacet.EcoData({
            nonEVMReceiver: tooShortAddress,
            prover: address(0x1234),
            rewardDeadline: uint64(block.timestamp + 2 days),
            encodedRoute: solanaEncodedRoute,
            solanaATA: 0x8f37c499ccbb92cefe5acc2f7aa22edf71d4237d4817e55671c7962b449e79f2,
            refundRecipient: USER_SENDER,
            deadline: block.timestamp + 1 hours,
            signature: ""
        });

        bridgeData.minAmount = bridgeData.minAmount + TOKEN_SOLVER_REWARD;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        _startEco(bridgeData, ecoData);

        vm.stopPrank();
    }
}
