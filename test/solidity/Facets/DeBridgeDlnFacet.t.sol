// solhint-disable max-line-length
// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";
import { IDlnSource } from "lifi/Interfaces/IDlnSource.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { NotInitialized, OnlyContractOwner, InvalidConfig } from "src/Errors/GenericErrors.sol";

// Stub DeBridgeDlnFacet Contract
contract TestDeBridgeDlnFacet is DeBridgeDlnFacet {
    constructor(IDlnSource _dlnSource) DeBridgeDlnFacet(_dlnSource) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract DeBridgeDlnFacetTest is TestBaseFacet {
    using stdJson for string;

    DeBridgeDlnFacet.DeBridgeDlnData internal validDeBridgeDlnData;
    TestDeBridgeDlnFacet internal deBridgeDlnFacet;
    IDlnSource internal constant DLN_SOURCE =
        IDlnSource(0xeF4fB24aD0916217251F553c0596F8Edc630EB66);
    uint256 internal fixedFee;

    // Errors
    error EmptyNonEVMAddress();
    error UnknownDeBridgeChain();

    // Events
    event DeBridgeInitialized(DeBridgeDlnFacet.ChainIdConfig[] chainIdConfigs);
    event DeBridgeChainIdSet(uint256 indexed chainId, uint256 deBridgeChainId);
    event DlnOrderCreated(bytes32 indexed orderId);

    bytes32 internal namespace = keccak256("com.lifi.facets.debridgedln");

    function setUp() public {
        customBlockNumberForForking = 19279222;
        initTestBase();

        deBridgeDlnFacet = new TestDeBridgeDlnFacet(DLN_SOURCE);
        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = deBridgeDlnFacet
            .startBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[1] = deBridgeDlnFacet
            .swapAndStartBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[2] = deBridgeDlnFacet.addDex.selector;
        functionSelectors[3] = deBridgeDlnFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = deBridgeDlnFacet.setDeBridgeChainId.selector;
        functionSelectors[5] = deBridgeDlnFacet.getDeBridgeChainId.selector;
        functionSelectors[6] = DeBridgeDlnFacet.initDeBridgeDln.selector;

        addFacet(address(diamond), address(deBridgeDlnFacet), functionSelectors);
        deBridgeDlnFacet = TestDeBridgeDlnFacet(address(diamond));
        deBridgeDlnFacet.addDex(ADDRESS_UNISWAP);
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        // Initialize
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/debridgedln.json"
        );
        string memory json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".mappings");
        DeBridgeDlnFacet.ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (DeBridgeDlnFacet.ChainIdConfig[])
        );

        deBridgeDlnFacet.initDeBridgeDln(cidCfg);

        setFacetAddressInTestBase(
            address(deBridgeDlnFacet),
            "DeBridgeDlnFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "deBridgeDln";
        bridgeData.destinationChainId = 137;

        // produce valid DeBridgeDlnData
        validDeBridgeDlnData = DeBridgeDlnFacet.DeBridgeDlnData({
            receivingAssetId: abi.encodePacked(
                0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
            ), // Polygon USDC
            receiver: abi.encodePacked(USER_RECEIVER),
            orderAuthorityDst: abi.encodePacked(USER_RECEIVER),
            minAmountOut: (defaultUSDCAmount * 95) / 100
        });

        vm.label(address(DLN_SOURCE), "DLN_SOURCE");
        fixedFee = DLN_SOURCE.globalFixedNativeFee();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{
                value: bridgeData.minAmount + fixedFee
            }(bridgeData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{
                value: fixedFee
            }(bridgeData, validDeBridgeDlnData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln{
                value: defaultNativeAmount + fixedFee
            }(bridgeData, swapData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln{
                value: fixedFee
            }(bridgeData, swapData, validDeBridgeDlnData);
        }
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new DeBridgeDlnFacet(IDlnSource(address(0)));
    }

    function test_Initialize() public {
        vm.store(
            address(deBridgeDlnFacet),
            bytes32(uint256(namespace) + 1),
            bytes32(uint256(0))
        ); // setting initialize var in storage

        vm.startPrank(USER_DIAMOND_OWNER);

        // Initialize
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/debridgedln.json"
        );
        string memory json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".mappings");
        DeBridgeDlnFacet.ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (DeBridgeDlnFacet.ChainIdConfig[])
        );

        vm.expectEmit(true, true, true, true);
        emit DeBridgeInitialized(cidCfg);
        deBridgeDlnFacet.initDeBridgeDln(cidCfg);

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensFromNative()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false); // we don't care about orderId
        emit DlnOrderCreated(
            0x0000000000000000000000000000000000000000000000000000000000000123
        );
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount - fixedFee
        );
    }

    function test_CanBridgeToNonEVMAddress()
        public
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        uint256 initialETHBalance = USER_SENDER.balance;

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        // This is just a random Solana Address for testing
        validDeBridgeDlnData
            .receiver = hex"e275bc4764effea023f35f3c60b2260c93248b74ec8d63ee215d40317e98b014"; // [pre-commit-checker: not a secret]
        validDeBridgeDlnData
            .orderAuthorityDst = hex"e275bc4764effea023f35f3c60b2260c93248b74ec8d63ee215d40317e98b014"; // [pre-commit-checker: not a secret]
        // SOL Token
        validDeBridgeDlnData
            .receivingAssetId = hex"0000000000000000000000000000000000000000000000000000000000000000"; // [pre-commit-checker: not a secret]

        // Setup to bridge to Solana
        bridgeData.destinationChainId = 1151111081099710;
        bridgeData.receiver = 0x11f111f111f111F111f111f111F111f111f111F1;

        //@dev the bridged amount will be higher than bridgeData.minAmount since the code will
        //     deposit all remaining ETH to the bridge. We cannot access that value (minAmount + remaining gas)
        //     therefore the test is designed to only check if an event was emitted but not match the parameters
        vm.expectEmit(false, false, false, false);
        emit BridgeToNonEVMChain(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            validDeBridgeDlnData.receiver
        );
        vm.expectEmit(false, false, false, false, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        assertEq(
            USER_SENDER.balance,
            initialETHBalance - swapData[0].fromAmount - fixedFee
        );
    }

    function testRevert_WhenBridgingToEmptyReceiverAddress() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        address[] memory path = new address[](2);

        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // This is just a random Solana Address for testing
        validDeBridgeDlnData.receiver = ""; // [pre-commit-checker: not a secret]
        // SOL Token
        validDeBridgeDlnData
            .receivingAssetId = hex"0000000000000000000000000000000000000000000000000000000000000000"; // [pre-commit-checker: not a secret]

        // Setup to bridge to Solana
        bridgeData.destinationChainId = 137;

        vm.expectRevert(EmptyNonEVMAddress.selector);
        initiateSwapAndBridgeTxWithFacet(true);
    }

    function test_CanSetDeBridgeChainIdFromOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        uint256 chainId = 137; // example chain ID
        uint256 deBridgeChainId = 1234; // mapped chain ID

        vm.expectEmit(true, true, true, true);

        emit DeBridgeChainIdSet(chainId, deBridgeChainId);

        deBridgeDlnFacet.setDeBridgeChainId(chainId, deBridgeChainId);

        assertEq(
            deBridgeDlnFacet.getDeBridgeChainId(chainId),
            deBridgeChainId
        );

        vm.stopPrank();
    }

    function testRevert_FailToSetDeBridgeChainIdFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        uint256 chainId = 137;
        uint256 deBridgeChainId = 1234;

        vm.expectRevert(OnlyContractOwner.selector);

        deBridgeDlnFacet.setDeBridgeChainId(chainId, deBridgeChainId);

        vm.stopPrank();
    }

    function testRevert_FailsToSetDeBridgeChainIdIfNotInitialized() public {
        vm.startPrank(address(0)); // address zero because facet is not set in the diamond so current contract owner is address zero

        TestDeBridgeDlnFacet uninitializedFacet = new TestDeBridgeDlnFacet(
            DLN_SOURCE
        );

        vm.expectRevert(NotInitialized.selector);

        uninitializedFacet.setDeBridgeChainId(137, 1001);

        vm.stopPrank();
    }

    function test_CanGetDeBridgeChainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        uint256 chainId = 137;
        uint256 deBridgeChainId = 1234;

        deBridgeDlnFacet.setDeBridgeChainId(chainId, deBridgeChainId);

        vm.stopPrank();

        uint256 returnedChainId = deBridgeDlnFacet.getDeBridgeChainId(chainId);

        assertEq(returnedChainId, deBridgeChainId);
    }

    function testRevert_FailsIfAttemptingToGetUnknownDeBridgeChainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        uint256 unknownChainId = 999999;

        vm.expectRevert(UnknownDeBridgeChain.selector);

        deBridgeDlnFacet.getDeBridgeChainId(unknownChainId);

        vm.stopPrank();
    }

    function testRevert_FailsIfAttemptingToStartBridgingWithEmptyReceiverAddress()
        public
    {
        vm.startPrank(USER_SENDER);

        validDeBridgeDlnData.receiver = ""; // empty receiver

        vm.expectRevert(EmptyNonEVMAddress.selector);

        deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{ value: fixedFee }(
            bridgeData,
            validDeBridgeDlnData
        );

        vm.stopPrank();
    }

    function test_CanGetStorage() public {
        uint256 chainIdKey = 1;
        uint256 expectedValue = 42;

        // compute the correct storage slot for `deBridgeChainId[chainIdKey]`
        bytes32 storageSlot = keccak256(abi.encode(chainIdKey, namespace));

        // store the test value in the computed slot
        vm.store(
            address(deBridgeDlnFacet),
            storageSlot,
            bytes32(expectedValue)
        );

        uint256 storedValue = deBridgeDlnFacet.getDeBridgeChainId(chainIdKey);

        assertEq(storedValue, expectedValue);
    }
}
