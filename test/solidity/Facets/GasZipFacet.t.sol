// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;
import { GasZipFacet } from "lifi/Facets/GasZipFacet.sol";
import { IGasZip } from "lifi/Interfaces/IGasZip.sol";
import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { InvalidCallData, CannotBridgeToSameNetwork, InvalidAmount, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";

// Stub GenericSwapFacet Contract
contract TestGasZipFacet is GasZipFacet {
    constructor(address gasZipRouter) GasZipFacet(gasZipRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function removeDex(address _dex) external {
        LibAllowList.removeAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GasZipFacetTest is TestBaseFacet {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762;
    address public constant NON_EVM_RECEIVER_IDENTIFIER =
        0x11f111f111f111F111f111f111F111f111f111F1;

    TestGasZipFacet internal gasZipFacet;
    IGasZip.GasZipData internal gasZipData;

    uint256 public defaultDestinationChains = 96;
    uint256 internal defaultNativeDepositAmount = 1e16;
    uint256 internal defaultERC20DepositAmount = 1e8;
    address public defaultRecipientAddress = address(12345);
    address public defaultRefundAddress = address(56789);
    bytes32 internal defaultReceiverBytes32 =
        bytes32(uint256(uint160(USER_RECEIVER)));

    event Deposit(address from, uint256 chains, uint256 amount, bytes32 to);

    error OnlyNativeAllowed();
    error TooManyChainIds();

    function setUp() public {
        // set custom block no for mainnet forking
        customBlockNumberForForking = 20828620;

        initTestBase();

        // deploy contracts
        gasZipFacet = new TestGasZipFacet(GAS_ZIP_ROUTER_MAINNET);

        // add gasZipFacet to diamond
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = gasZipFacet.startBridgeTokensViaGasZip.selector;
        functionSelectors[1] = gasZipFacet
            .swapAndStartBridgeTokensViaGasZip
            .selector;
        functionSelectors[2] = gasZipFacet.getDestinationChainsValue.selector;

        functionSelectors[3] = gasZipFacet.addDex.selector;
        functionSelectors[4] = gasZipFacet.removeDex.selector;
        functionSelectors[5] = gasZipFacet
            .setFunctionApprovalBySignature
            .selector;
        addFacet(diamond, address(gasZipFacet), functionSelectors);

        gasZipFacet = TestGasZipFacet(payable(address(diamond)));

        // whitelist uniswap dex with function selectors
        gasZipFacet.addDex(address(uniswap));
        gasZipFacet.addDex(address(gasZipFacet));
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        gasZipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(gasZipFacet), "GasZipFacet");

        // produce valid GasZipData
        uint8[] memory chainIds = new uint8[](1);
        chainIds[0] = 17; // polygon
        gasZipData = IGasZip.GasZipData({
            destinationChains: defaultDestinationChains,
            receiver: bytes32(uint256(uint160(USER_RECEIVER)))
        });

        bridgeData.bridge = "GasZip";

        vm.label(address(gasZipFacet), "LiFiDiamond");
        vm.label(ADDRESS_WRAPPED_NATIVE, "WRAPPED_NATIVE_TOKEN");
        vm.label(ADDRESS_USDC, "USDC_TOKEN");
        vm.label(ADDRESS_UNISWAP, "UNISWAP_V2_ROUTER");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            gasZipFacet.startBridgeTokensViaGasZip{
                value: bridgeData.minAmount
            }(bridgeData, gasZipData);
        } else {
            gasZipFacet.startBridgeTokensViaGasZip(bridgeData, gasZipData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            gasZipFacet.swapAndStartBridgeTokensViaGasZip{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, gasZipData);
        } else {
            gasZipFacet.swapAndStartBridgeTokensViaGasZip(
                bridgeData,
                swapData,
                gasZipData
            );
        }
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // deactivated for this facet since we would have to update the calldata that swaps from ERC20 to native for every amount
    }

    function testBase_CanBridgeTokens() public override {
        // the startBridgeTokensViaGasZip can only be used for native tokens, therefore we need to adapt this test case
        vm.startPrank(USER_SENDER);

        // update bridgeData to use native
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultERC20DepositAmount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipFacet),
            defaultDestinationChains,
            defaultERC20DepositAmount,
            defaultReceiverBytes32
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {
        // defaultNativeAmount is too high, therefore we need to override this test
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeDepositAmount; // ~2 USD

        //prepare check for events
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipFacet),
            defaultDestinationChains,
            defaultNativeDepositAmount,
            defaultReceiverBytes32
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        // the startBridgeTokensViaGasZip can only be used for native tokens, therefore this test case is not applicable
    }

    function testRevert_WillFailWhenTryingToBridgeERC20() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // expect the call to revert
        vm.expectRevert(OnlyNativeAllowed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidSwapData()
        public
        override
    {
        // since the facets accesses the swapData parameter already before trying to execute the swap, we need to override the expected error message
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        delete swapData;

        vm.expectRevert();

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset create swapData (5 DAI to native)
        uint256 daiAmount = 5 * 10 ** dai.decimals();

        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, daiAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
        public
        override
    {
        // since the 'validateBridgeData' modifier is not used, a different error is thrown here

        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.receiver = address(0);
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidAmount() public override {
        // since the '' modifier is not used, a different error is thrown here

        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = 0;

        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeToSameChainId() public override {
        // we need to test this with native instead of ERC20 for this facet, therefore override

        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeDepositAmount; // ~2 USD
        bridgeData.destinationChainId = block.chainid;

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidAmount() public override {
        // we need to test this with native instead of ERC20 for this facet, therefore override

        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 0;

        // will fail when trying to send value that it doesnt have
        vm.expectRevert();

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress()
        public
        override
    {
        // we need to test this with native instead of ERC20 for this facet, therefore override

        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeDepositAmount; // ~2 USD
        gasZipData.receiver = bytes32(0);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeToSameChainId() public override {
        // we need to test this with native swap output instead of ERC20 for this facet, therefore override

        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = block.chainid;
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoETH(); // changed to native output calldata
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_getDestinationChainsValueReturnsCorrectValues() public {
        // case 1
        uint8[] memory chainIds = new uint8[](1);
        chainIds[0] = 17; // Polygon

        assertEq(gasZipFacet.getDestinationChainsValue(chainIds), 17);

        // case 2
        chainIds = new uint8[](2);
        chainIds[0] = 51;
        chainIds[1] = 52;

        assertEq(gasZipFacet.getDestinationChainsValue(chainIds), 13108);

        // case 3
        chainIds = new uint8[](5);
        chainIds[0] = 15; // Avalanche
        chainIds[1] = 54; // Base
        chainIds[2] = 96; // Blast
        chainIds[3] = 14; // BSC
        chainIds[4] = 59; // Linea

        assertEq(gasZipFacet.getDestinationChainsValue(chainIds), 65336774203);
    }

    function testRevert_WillFailIfMsgValueDoesNotMatchBridgeDataAmount()
        public
    {
        vm.startPrank(USER_SENDER);

        // update bridgeData to use native
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultERC20DepositAmount;

        vm.expectRevert(InvalidAmount.selector);

        gasZipFacet.startBridgeTokensViaGasZip{
            value: bridgeData.minAmount - 1
        }(bridgeData, gasZipData);
    }

    function testRevert_WillFailIfMoreThan32ChainIds() public {
        vm.startPrank(USER_SENDER);

        uint8[] memory chainIds = new uint8[](33);

        vm.expectRevert(TooManyChainIds.selector);

        gasZipFacet.getDestinationChainsValue(chainIds);
    }

    function testRevert_WillFailIfEVMReceiverAddressesDontMatch() public {
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeDepositAmount; // ~2 USD
        bridgeData.receiver = USER_PAUSER;

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_WillNotFailIfNonEVMReceiverAddressesDontMatch() public {
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeDepositAmount; // ~2 USD
        bridgeData.receiver = NON_EVM_RECEIVER_IDENTIFIER;

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }
}
