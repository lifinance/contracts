// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { Test } from "forge-std/Test.sol";
import { OpBNBBridgeFacet } from "lifi/Facets/OpBNBBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { IL1StandardBridge } from "lifi/Interfaces/IL1StandardBridge.sol";
import "lifi/Errors/GenericErrors.sol";

// Stub OpBNBBridgeFacet Contract
contract TestOpBNBBridgeFacet is OpBNBBridgeFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract FooSwap is Test {
    function swap(
        ERC20 inToken,
        ERC20 outToken,
        uint256 inAmount,
        uint256 outAmount
    ) external {
        inToken.transferFrom(msg.sender, address(this), inAmount);
        deal(address(outToken), msg.sender, outAmount);
    }
}

contract OpBNBBridgeFacetTest is DSTest, DiamondTest {
    // These values are for BSC Testnet
    address internal constant USDC_ADDRESS =
        0x64544969ed7EBf5f083679233325356EbE738930;
    address internal constant USDC_HOLDER =
        0x082A2027DC16F42d6e69bE8FA13C94C17c910EbE;
    address internal constant DAI_L1_ADDRESS =
        0xEC5dCb5Dbf4B114C9d0F65BcCAb49EC54F6A0867;
    address internal constant DAI_L1_HOLDER =
        0x082A2027DC16F42d6e69bE8FA13C94C17c910EbE;
    address internal constant DAI_L2_ADDRESS =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant STANDARD_BRIDGE =
        0x677311Fd2cCc511Bbc0f581E8d9a07B033D5E840;
    address internal constant DAI_BRIDGE =
        0x10E6593CDda8c58a1d0f14C5164B376352a55f2F;
    uint256 internal constant DSTCHAIN_ID = 5116;
    uint32 internal constant L2_GAS = 200000;

    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestOpBNBBridgeFacet internal opBNBBridgeFacet;
    ERC20 internal usdc;
    ERC20 internal dai;
    ILiFi.BridgeData internal validBridgeData;
    OpBNBBridgeFacet.OpBNBData internal validOpBNBData;
    FooSwap internal fooSwap;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_BSC_TESTNET");
        uint256 blockNumber = 33259557;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        opBNBBridgeFacet = new TestOpBNBBridgeFacet();
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_L1_ADDRESS);
        fooSwap = new FooSwap();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = opBNBBridgeFacet
            .startBridgeTokensViaOpBNBBridge
            .selector;
        functionSelectors[1] = opBNBBridgeFacet
            .swapAndStartBridgeTokensViaOpBNBBridge
            .selector;
        functionSelectors[2] = opBNBBridgeFacet.initOpBNB.selector;
        functionSelectors[3] = opBNBBridgeFacet.addDex.selector;
        functionSelectors[4] = opBNBBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(opBNBBridgeFacet), functionSelectors);

        OpBNBBridgeFacet.Config[]
            memory configs = new OpBNBBridgeFacet.Config[](0);

        opBNBBridgeFacet = TestOpBNBBridgeFacet(address(diamond));
        opBNBBridgeFacet.initOpBNB(
            configs,
            IL1StandardBridge(STANDARD_BRIDGE)
        );

        opBNBBridgeFacet.addDex(address(fooSwap));
        opBNBBridgeFacet.setFunctionApprovalBySignature(fooSwap.swap.selector);

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "opbnb",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_L1_ADDRESS,
            receiver: DAI_L1_HOLDER,
            minAmount: 10 * 10 ** dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        validOpBNBData = OpBNBBridgeFacet.OpBNBData(
            DAI_L2_ADDRESS,
            L2_GAS,
            false
        );
    }

    function testRevertToBridgeTokensWhenSendingAmountIsZero() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenReceiverIsZeroAddress() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testRevertToBridgeTokensWhenInformationMismatch() public {
        vm.startPrank(DAI_L1_HOLDER);

        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);
        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            bridgeData,
            validOpBNBData
        );

        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(DAI_L1_HOLDER);
        dai.approve(address(opBNBBridgeFacet), 10_000 * 10 ** dai.decimals());

        opBNBBridgeFacet.startBridgeTokensViaOpBNBBridge(
            validBridgeData,
            validOpBNBData
        );
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USDC_HOLDER);

        usdc.approve(
            address(opBNBBridgeFacet),
            10_000 * 10 ** usdc.decimals()
        );

        uint256 inAmount = 10_000 * 10 ** usdc.decimals();
        uint256 outAmount = 10_000 * 10 ** dai.decimals();

        // Calculate DAI amount
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(fooSwap),
            address(fooSwap),
            USDC_ADDRESS,
            DAI_L1_ADDRESS,
            inAmount,
            abi.encodeWithSelector(
                fooSwap.swap.selector,
                ERC20(USDC_ADDRESS),
                ERC20(DAI_L1_ADDRESS),
                inAmount,
                outAmount
            ),
            true
        );

        ILiFi.BridgeData memory bridgeData = validBridgeData;
        bridgeData.hasSourceSwaps = true;

        opBNBBridgeFacet.swapAndStartBridgeTokensViaOpBNBBridge(
            bridgeData,
            swapData,
            validOpBNBData
        );

        vm.stopPrank();
    }
}
