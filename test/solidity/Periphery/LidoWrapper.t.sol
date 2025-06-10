// solhint-disable
// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LidoWrapper, IStETH } from "lifi/Periphery/LidoWrapper.sol";
import { TestBase } from "../utils/TestBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";
import { TestRelayFacet } from "../Facets/RelayFacet.t.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { InvalidConfig, InvalidAmount } from "lifi/Errors/GenericErrors.sol";

// Custom errors from stETH contract
error ErrorZeroSharesWrap();
error ErrorZeroTokensUnwrap();
error ErrorZeroSharesUnwrap();
error ErrorNotEnoughBalance();
error ErrorNotEnoughAllowance();

contract LidoWrapperTest is TestBase {
    LidoWrapper private lidoWrapper;
    address private constant ST_ETH_ADDRESS_OPTIMISM =
        0x76A50b8c7349cCDDb7578c6627e79b5d99D24138;
    address private constant ST_ETH_ADDRESS_MAINNET =
        0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address private constant WST_ETH_ADDRESS_OPTIMISM =
        0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb;
    address private constant WST_ETH_ADDRESS_MAINNET =
        0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address private constant ST_ETH_WHALE =
        0xa243e782185D5E25dEB3829E98E3Ed9cCecc35B2;
    address internal constant RELAY_RECEIVER =
        0xa5F565650890fBA1824Ee0F21EbBbF660a179934;

    uint256 internal privateKey = 0x1234567890;
    address internal relaySolver = vm.addr(privateKey);
    TestRelayFacet internal relayFacet;
    RelayFacet.RelayData internal validRelayData;
    GenericSwapFacetV3 internal genericSwapFacetV3;

    error ContractNotYetReadyForMainnet();

    function setUp() public {
        vm.label(ST_ETH_ADDRESS_OPTIMISM, "stETH");
        vm.label(WST_ETH_ADDRESS_OPTIMISM, "wstETH");

        // fork Optimism
        customRpcUrlForForking = "ETH_NODE_URI_OPTIMISM";
        customBlockNumberForForking = 135840744;
        initTestBase();

        // deploy lido wrapper
        lidoWrapper = new LidoWrapper(
            ST_ETH_ADDRESS_OPTIMISM,
            WST_ETH_ADDRESS_OPTIMISM,
            USER_DIAMOND_OWNER
        );

        // transfer stETH from whale to USER_SENDER
        vm.startPrank(ST_ETH_WHALE);
        IERC20(ST_ETH_ADDRESS_OPTIMISM).transfer(USER_SENDER, 50 ether);
        vm.stopPrank();

        // set max approvals from USER_SENDER to this contract
        vm.startPrank(USER_SENDER);
        // set max approval to stETH contract so it can pull tokens from user
        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            ST_ETH_ADDRESS_OPTIMISM,
            type(uint256).max
        );

        // deal wstETH to USER_SENDER by wrapping stETH
        IStETH(ST_ETH_ADDRESS_OPTIMISM).unwrap(10 ether);

        // IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(address(this), type(uint256).max);
        IERC20(WST_ETH_ADDRESS_OPTIMISM).approve(
            address(lidoWrapper),
            type(uint256).max
        );

        // prepare diamond setup
        // add relay bridge
        // slither-disable-next-line reentrancy
        relayFacet = new TestRelayFacet(RELAY_RECEIVER, relaySolver);

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
        // slither-disable-next-line reentrancy-no-eth
        relayFacet = TestRelayFacet(address(diamond));

        // update bridgeData
        bridgeData.bridge = "symbiosis";
        bridgeData.destinationChainId = 1;
        bridgeData.minAmount = 0.1 ether;
        // bridgeData.minAmount = 83152588364537670;
        bridgeData.sendingAssetId = WST_ETH_ADDRESS_OPTIMISM;
        bridgeData.hasSourceSwaps = true;

        // prepare relayData
        // slither-disable-next-line reentrancy-no-eth
        validRelayData = RelayFacet.RelayData({
            requestId: bytes32("1234"),
            nonEVMReceiver: "",
            receivingAssetId: bytes32(
                uint256(uint160(WST_ETH_ADDRESS_MAINNET))
            ),
            signature: ""
        });

        // whitelist LidoWrapper as periphery
        relayFacet.addDex(address(lidoWrapper));
        relayFacet.setFunctionApprovalBySignature(
            lidoWrapper.wrapStETHToWstETH.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            lidoWrapper.unwrapWstETHToStETH.selector
        );

        vm.stopPrank();

        vm.label(address(lidoWrapper), "LidoWrapper");
    }

    // ######## Constructor Tests ########

    function test_WillStoreConstructorParametersCorrectly() public {
        customRpcUrlForForking = "ETH_NODE_URI_MAINNET";
        customBlockNumberForForking = 22574016;
        fork();

        vm.expectRevert(ContractNotYetReadyForMainnet.selector);

        lidoWrapper = new LidoWrapper(
            ST_ETH_ADDRESS_MAINNET,
            WST_ETH_ADDRESS_MAINNET,
            USER_DIAMOND_OWNER
        );
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new LidoWrapper(
            address(0),
            WST_ETH_ADDRESS_OPTIMISM,
            USER_DIAMOND_OWNER
        );

        vm.expectRevert(InvalidConfig.selector);

        new LidoWrapper(
            ST_ETH_ADDRESS_OPTIMISM,
            address(0),
            USER_DIAMOND_OWNER
        );

        vm.expectRevert(InvalidConfig.selector);

        new LidoWrapper(
            ST_ETH_ADDRESS_OPTIMISM,
            WST_ETH_ADDRESS_OPTIMISM,
            address(0)
        );
    }

    function test_CanBeDeployedToNonMainnet() public {
        lidoWrapper = new LidoWrapper(
            ST_ETH_ADDRESS_OPTIMISM,
            WST_ETH_ADDRESS_OPTIMISM,
            USER_DIAMOND_OWNER
        );

        assertEq(address(lidoWrapper.ST_ETH()), ST_ETH_ADDRESS_OPTIMISM);
        assertEq(
            address(lidoWrapper.WST_ETH_ADDRESS()),
            WST_ETH_ADDRESS_OPTIMISM
        );
        assertEq(address(lidoWrapper.owner()), USER_DIAMOND_OWNER);
    }

    // ######## Direct Interaction Tests ########

    function test_CanUnwrapWstEthToStEth() public {
        vm.startPrank(USER_SENDER);

        uint256 balanceStBefore = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );
        uint256 balanceWstBefore = IERC20(WST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        lidoWrapper.unwrapWstETHToStETH(balanceWstBefore);

        uint256 balanceStAfter = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );
        uint256 balanceWstAfter = IERC20(WST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        assertTrue(balanceStAfter > balanceStBefore);
        assertTrue(balanceWstAfter == 0);

        vm.stopPrank();
    }

    function test_CanWrapStEthToWstEth() public {
        vm.startPrank(USER_SENDER);

        uint256 stEthBalanceBefore = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );
        uint256 wstEthBalanceBefore = IERC20(WST_ETH_ADDRESS_OPTIMISM)
            .balanceOf(USER_SENDER);

        // Approve the LidoWrapper contract to spend stETH
        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            address(lidoWrapper),
            stEthBalanceBefore
        );

        // Wrap stETH to wstETH
        lidoWrapper.wrapStETHToWstETH(stEthBalanceBefore);

        uint256 stEthBalanceAfter = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );
        uint256 wstEthBalance = IERC20(WST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        assertTrue(stEthBalanceAfter <= 1);
        assertTrue(wstEthBalance > wstEthBalanceBefore);

        vm.stopPrank();
    }

    // ######## Error Case Tests ########

    function testRevert_WhenWrappingZeroAmount() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(ErrorZeroTokensUnwrap.selector);

        lidoWrapper.wrapStETHToWstETH(0);

        vm.stopPrank();
    }

    function testRevert_WhenUnwrappingZeroAmount() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(ErrorZeroSharesWrap.selector);

        lidoWrapper.unwrapWstETHToStETH(0);

        vm.stopPrank();
    }

    function testRevert_WhenWrappingMoreThanBalance() public {
        vm.startPrank(USER_SENDER);

        // Get user's stETH balance
        uint256 balance = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            address(lidoWrapper),
            balance + 2 // +1 still worked (probably because of rounding errors)
        );

        // Try to wrap more than balance
        vm.expectRevert(ErrorNotEnoughBalance.selector);

        lidoWrapper.wrapStETHToWstETH(balance + 2);

        vm.stopPrank();
    }

    function testRevert_WhenUnwrappingMoreThanBalance() public {
        vm.startPrank(USER_SENDER);

        // Get user's wstETH balance
        uint256 balance = IERC20(WST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            address(lidoWrapper),
            balance + 2 // +1 still worked (probably because of rounding errors)
        );

        IERC20(WST_ETH_ADDRESS_OPTIMISM).approve(
            address(lidoWrapper),
            balance + 2
        );

        // Try to unwrap more than balance
        vm.expectRevert(ErrorNotEnoughBalance.selector);

        lidoWrapper.unwrapWstETHToStETH(balance + 1);

        vm.stopPrank();
    }

    // ######## Diamond Integration Tests ########

    function test_CanWrapStEthToWstEthViaDiamondPreBridge() public {
        vm.startPrank(USER_SENDER);

        uint256 stEthBalanceBefore = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        // Set approval from user to diamond for stETH tokens
        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            address(diamond),
            stEthBalanceBefore
        );

        // Prepare swap data for wrapping stETH to wstETH
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(lidoWrapper),
            approveTo: address(lidoWrapper),
            sendingAssetId: ST_ETH_ADDRESS_OPTIMISM,
            receivingAssetId: WST_ETH_ADDRESS_OPTIMISM,
            fromAmount: stEthBalanceBefore,
            callData: abi.encodeWithSelector(
                lidoWrapper.wrapStETHToWstETH.selector,
                stEthBalanceBefore
            ),
            requiresDeposit: true
        });

        // Sign relay data
        validRelayData.signature = _signData(bridgeData, validRelayData);

        // Execute swap and bridge
        relayFacet.swapAndStartBridgeTokensViaRelay(
            bridgeData,
            swapData,
            validRelayData
        );

        // Verify balances
        uint256 stEthBalanceAfter = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );
        uint256 wstEthBalance = IERC20(WST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        assertTrue(stEthBalanceAfter <= 1);
        assertTrue(wstEthBalance > 0);

        vm.stopPrank();
    }

    function test_canWrapStEthTokensViaDiamondGenericSwap() public {
        _deployAndAddGenericSwapFacetV3ToDiamond();
        vm.startPrank(USER_SENDER);

        uint256 stEthBalanceBefore = IERC20(ST_ETH_ADDRESS_OPTIMISM).balanceOf(
            USER_SENDER
        );

        // set approval from user to diamond for stETH tokens
        IERC20(ST_ETH_ADDRESS_OPTIMISM).approve(
            address(diamond),
            stEthBalanceBefore
        );

        // prepare LidoWrapper swapData
        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(lidoWrapper),
                approveTo: address(lidoWrapper),
                sendingAssetId: ST_ETH_ADDRESS_OPTIMISM,
                receivingAssetId: WST_ETH_ADDRESS_OPTIMISM,
                fromAmount: stEthBalanceBefore,
                callData: abi.encodeWithSelector(
                    lidoWrapper.wrapStETHToWstETH.selector,
                    stEthBalanceBefore
                ),
                requiresDeposit: true
            })
        );

        // call GenericSwapFacetV3 via diamond
        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            "RandomId",
            "integrator",
            "referrer",
            payable(USER_RECEIVER),
            bridgeData.minAmount,
            swapData[0]
        );

        vm.stopPrank();
    }

    function test_canUnwrapWstEthTokensViaDiamondGenericSwap() public {
        _deployAndAddGenericSwapFacetV3ToDiamond();

        vm.startPrank(USER_SENDER);

        uint256 wstEthBalanceBefore = IERC20(WST_ETH_ADDRESS_OPTIMISM)
            .balanceOf(USER_SENDER);

        // set approval from user to diamond for wstETH tokens
        IERC20(WST_ETH_ADDRESS_OPTIMISM).approve(
            address(diamond),
            wstEthBalanceBefore
        );

        // update bridgeData
        bridgeData.minAmount = 0.1 ether;
        bridgeData.sendingAssetId = ST_ETH_ADDRESS_OPTIMISM;

        // prepare LidoWrapper swapData
        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(lidoWrapper),
                approveTo: address(lidoWrapper),
                sendingAssetId: WST_ETH_ADDRESS_OPTIMISM,
                receivingAssetId: ST_ETH_ADDRESS_OPTIMISM,
                fromAmount: wstEthBalanceBefore,
                callData: abi.encodeWithSelector(
                    lidoWrapper.unwrapWstETHToStETH.selector,
                    wstEthBalanceBefore
                ),
                requiresDeposit: true
            })
        );

        // call GenericSwapFacetV3 via diamond
        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            "RandomId",
            "integrator",
            "referrer",
            payable(USER_RECEIVER),
            bridgeData.minAmount,
            swapData[0]
        );

        vm.stopPrank();
    }

    function _signData(
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
                        _bridgeData.destinationChainId,
                        _bridgeData.receiver == LibAsset.NON_EVM_ADDRESS
                            ? _relayData.nonEVMReceiver
                            : bytes32(uint256(uint160(_bridgeData.receiver))),
                        _relayData.receivingAssetId
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, message);
        bytes memory signature = abi.encodePacked(r, s, v);
        return signature;
    }

    function _deployAndAddGenericSwapFacetV3ToDiamond() internal {
        // deploy GenericSwapFacet
        genericSwapFacetV3 = new GenericSwapFacetV3(address(0));

        // prepare function selectors
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = genericSwapFacetV3
            .swapTokensSingleV3ERC20ToERC20
            .selector;

        // add facet to diamond and  store diamond with facet interface in variable
        addFacet(diamond, address(genericSwapFacetV3), functionSelectors);
        genericSwapFacetV3 = GenericSwapFacetV3(address(diamond));
    }
}
