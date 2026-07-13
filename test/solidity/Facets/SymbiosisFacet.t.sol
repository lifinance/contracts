// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";
import { ISymbiosisMetaRouter } from "lifi/Interfaces/ISymbiosisMetaRouter.sol";
import { IOnchainSwapV3 } from "lifi/Interfaces/IOnchainSwapV3.sol";
import { InvalidConfig, InvalidReceiver, InvalidDestinationChain, InvalidNonEVMReceiver } from "lifi/Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal stand-in for the Symbiosis OnchainSwapV3 router. Pulls the
///         input token from the caller (the facet approves this contract as the
///         gateway) and records the call so tests can assert on it.
contract MockOnchainSwapV3 {
    event OnswapCalled(address token, uint256 amount, uint256 value);

    function onswap(
        address token,
        uint256 amount,
        address,
        address,
        bytes calldata
    ) external payable {
        if (token != address(0)) {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        emit OnswapCalled(token, amount, msg.value);
    }
}

// Stub SymbiosisFacet Contract
contract TestSymbiosisFacet is SymbiosisFacet, TestWhitelistManagerBase {
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway,
        IOnchainSwapV3 _onchainSwapV3,
        address _onchainSwapV3Gateway
    )
        SymbiosisFacet(
            _symbiosisMetaRouter,
            _symbiosisGateway,
            _onchainSwapV3,
            _onchainSwapV3Gateway
        )
    {}
}

contract SymbiosisFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant SYMBIOSIS_METAROUTER =
        0xf621Fb08BBE51aF70e7E0F4EA63496894166Ff7F;
    address internal constant SYMBIOSIS_GATEWAY =
        0xfCEF2Fe72413b65d3F393d278A714caD87512bcd;
    address internal constant RELAY_RECIPIENT =
        0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8;

    event OnswapCalled(address token, uint256 amount, uint256 value);

    TestSymbiosisFacet internal symbiosisFacet;
    SymbiosisFacet.SymbiosisData internal symbiosisData;
    MockOnchainSwapV3 internal onchainSwapV3;
    bytes32 internal constant BTC_RECEIVER =
        bytes32(
            uint256(
                0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
            )
        );

    function setUp() public {
        customBlockNumberForForking = 19317492;
        initTestBase();

        onchainSwapV3 = new MockOnchainSwapV3();

        symbiosisFacet = new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(onchainSwapV3)),
            address(onchainSwapV3) // mock acts as its own gateway
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
            firstSwapCalldata: "",
            secondSwapCalldata: "",
            intermediateToken: address(0),
            firstDexRouter: address(0),
            secondDexRouter: address(0),
            approvedTokens: _approvedTokens,
            callTo: RELAY_RECIPIENT,
            callData: _otherSideCalldata,
            viaOnchainSwapV3: false,
            dex: address(0),
            dexgateway: address(0),
            onchainSwapData: "",
            nonEvmReceiver: bytes32(0)
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
    }

    function test_CanBridgeERC20TokensViaOnchainSwapV3() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, false, true, address(onchainSwapV3));
        emit OnswapCalled(ADDRESS_USDC, bridgeData.minAmount, 0);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            BTC_RECEIVER
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        symbiosisFacet.startBridgeTokensViaSymbiosis(
            bridgeData,
            symbiosisData
        );

        assertEq(usdc.balanceOf(address(onchainSwapV3)), bridgeData.minAmount);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensViaOnchainSwapV3() public {
        _prepareOnchainSwapV3Data();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, false, true, address(onchainSwapV3));
        emit OnswapCalled(
            address(0),
            bridgeData.minAmount,
            bridgeData.minAmount
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            BTC_RECEIVER
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        symbiosisFacet.startBridgeTokensViaSymbiosis{
            value: bridgeData.minAmount
        }(bridgeData, symbiosisData);

        assertEq(address(onchainSwapV3).balance, bridgeData.minAmount);
        vm.stopPrank();
    }

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

    function testRevert_ConstructorWithZeroMetaRouter() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(address(0)),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(onchainSwapV3)),
            address(onchainSwapV3)
        );
    }

    function testRevert_ConstructorWithZeroGateway() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            address(0),
            IOnchainSwapV3(address(onchainSwapV3)),
            address(onchainSwapV3)
        );
    }

    function testRevert_ConstructorWithZeroOnchainSwapV3() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(0)),
            address(onchainSwapV3)
        );
    }

    function testRevert_ConstructorWithZeroOnchainSwapV3Gateway() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY,
            IOnchainSwapV3(address(onchainSwapV3)),
            address(0)
        );
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
