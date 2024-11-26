// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20, LibAsset, LibSwap } from "../utils/TestBaseFacet.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";

contract Reverter {
    fallback() external {
        revert("I always revert");
    }
}

// Stub RelayFacet Contract
contract TestRelayFacet is RelayFacet {
    constructor(
        address _relayReceiver,
        address _relaySolver
    ) RelayFacet(_relayReceiver, _relaySolver) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }

    function getMappedChainId(
        uint256 chainId
    ) external pure returns (uint256) {
        return _getMappedChainId(chainId);
    }

    function setConsumedId(bytes32 id) external {
        consumedIds[id] = true;
    }
}

contract RelayFacetTest is TestBaseFacet {
    RelayFacet.RelayData internal validRelayData;
    TestRelayFacet internal relayFacet;
    address internal RELAY_RECEIVER =
        0xa5F565650890fBA1824Ee0F21EbBbF660a179934;
    uint256 internal PRIVATE_KEY = 0x1234567890;
    address RELAY_SOLVER = vm.addr(PRIVATE_KEY);

    error InvalidQuote();

    function setUp() public {
        customBlockNumberForForking = 19767662;
        initTestBase();
        relayFacet = new TestRelayFacet(RELAY_RECEIVER, RELAY_SOLVER);
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = relayFacet.startBridgeTokensViaRelay.selector;
        functionSelectors[1] = relayFacet
            .swapAndStartBridgeTokensViaRelay
            .selector;
        functionSelectors[2] = relayFacet.addDex.selector;
        functionSelectors[3] = relayFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = relayFacet.getMappedChainId.selector;
        functionSelectors[5] = relayFacet.setConsumedId.selector;

        addFacet(diamond, address(relayFacet), functionSelectors);
        relayFacet = TestRelayFacet(address(diamond));
        relayFacet.addDex(ADDRESS_UNISWAP);
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(relayFacet), "RelayFacet");

        // adjust bridgeData
        bridgeData.bridge = "relay";
        bridgeData.destinationChainId = 137;

        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: "",
            receivingAssetId: bytes32(
                uint256(uint160(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174))
            ), // Polygon USDC
            signature: ""
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        validRelayData.signature = signData(bridgeData, validRelayData);
        if (isNative) {
            relayFacet.startBridgeTokensViaRelay{
                value: bridgeData.minAmount
            }(bridgeData, validRelayData);
        } else {
            relayFacet.startBridgeTokensViaRelay(bridgeData, validRelayData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        validRelayData.signature = signData(bridgeData, validRelayData);
        if (isNative) {
            relayFacet.swapAndStartBridgeTokensViaRelay{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validRelayData);
        } else {
            relayFacet.swapAndStartBridgeTokensViaRelay(
                bridgeData,
                swapData,
                validRelayData
            );
        }
    }

    function testRevert_BridgeWithInvalidSignature() public virtual {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        PRIVATE_KEY = 0x0987654321;

        vm.expectRevert(InvalidQuote.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToSolana()
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
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked(
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                )
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenReplayingTransactionIds() public virtual {
        relayFacet.setConsumedId(validRelayData.requestId);
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked(
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                )
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidQuote.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensToSolana()
        public
        virtual
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked(
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                )
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensToSolana()
        public
        virtual
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked(
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                )
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
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

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function test_CanSwapAndBridgeNativeTokensToSolana()
        public
        virtual
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 1151111081099710;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked(
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                )
            ), // Solana USDC
            signature: ""
        });

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

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
    }

    function test_CanBridgeTokensToBitcoin()
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
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 20000000000001;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked("bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8")
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeNativeTokensToBitcoin()
        public
        virtual
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 20000000000001;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked("bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8")
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeTokensToBitcoin()
        public
        virtual
        assertBalanceChange(
            ADDRESS_DAI,
            USER_SENDER,
            -int256(swapData[0].fromAmount)
        )
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 20000000000001;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked("bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8")
            ), // Solana USDC
            signature: ""
        });

        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
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

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeNativeTokensToBitcoin()
        public
        virtual
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 20000000000001;
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: bytes32(
                abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
            ), // DEV Wallet
            receivingAssetId: bytes32(
                abi.encodePacked("bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8")
            ), // Solana USDC
            signature: ""
        });

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

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);

        // check balances after call
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialUSDCBalance - swapData[0].fromAmount
        );
        vm.stopPrank();
    }

    function testFail_RevertIsBubbledWhenBridgingTokensFails()
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
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.mockCallRevert(
            ADDRESS_USDC,
            abi.encodeWithSignature(
                "transfer(address,uint256)",
                RELAY_SOLVER,
                bridgeData.minAmount
            ),
            "I always revert"
        );

        vm.expectRevert("I always revert");
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testFail_RevertIsBubbledWhenBridgingNativeTokensFails()
        public
        virtual
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256((defaultNativeAmount + addToMessageValue))
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);

        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        _makeRevertable(RELAY_RECEIVER);

        vm.expectRevert("I always revert");
        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_mapsCorrectChainId(uint256 chainId) public {
        uint256 mapped = relayFacet.getMappedChainId(chainId);
        // Bitcoin
        if (chainId == 20000000000001) {
            assertEq(mapped, 8253038);
            return;
        }

        // Solana
        if (chainId == 1151111081099710) {
            assertEq(mapped, 792703809);
            return;
        }

        assertEq(mapped, chainId);
    }

    function signData(
        ILiFi.BridgeData memory _bridgeData,
        RelayFacet.RelayData memory _relayData
    ) internal view returns (bytes memory) {
        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(
                    abi.encodePacked(
                        _relayData.requestId,
                        block.chainid,
                        bytes32(uint256(uint160(address(relayFacet)))),
                        bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                        _getMappedChainId(_bridgeData.destinationChainId),
                        _bridgeData.receiver == LibAsset.NON_EVM_ADDRESS
                            ? _relayData.nonEVMReceiver
                            : bytes32(uint256(uint160(_bridgeData.receiver))),
                        _relayData.receivingAssetId
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRIVATE_KEY, message);
        bytes memory signature = abi.encodePacked(r, s, v);
        return signature;
    }

    function _getMappedChainId(
        uint256 chainId
    ) internal pure returns (uint256) {
        if (chainId == 20000000000001) {
            return 8253038;
        }

        if (chainId == 1151111081099710) {
            return 792703809;
        }

        return chainId;
    }

    function _makeRevertable(address target) internal {
        Reverter reverter = new Reverter();
        bytes memory code = address(reverter).code;
        vm.etch(target, code);
    }
}
