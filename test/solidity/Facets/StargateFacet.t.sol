// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.16;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

// Stub CBridgeFacet Contract
contract TestStargateFacet is StargateFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract StargateFacetTest is DSTest, DiamondTest {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_HOLDER = 0xee5B5B923fFcE93A870B3104b7CA09c3db80047A;
    address internal constant MAINNET_ROUTER = 0x8731d54E9D02c286767d56ac03e8037C07e01e98;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestStargateFacet internal stargate;
    ERC20 internal usdc;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        stargate = new TestStargateFacet();
        usdc = ERC20(USDC_ADDRESS);
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = stargate.startBridgeTokensViaStargate.selector;
        functionSelectors[1] = stargate.swapAndStartBridgeTokensViaStargate.selector;
        functionSelectors[2] = stargate.setLayerZeroChainId.selector;
        functionSelectors[3] = stargate.setStargatePoolId.selector;
        functionSelectors[4] = stargate.quoteLayerZeroFee.selector;

        addFacet(diamond, address(stargate), functionSelectors);

        stargate = TestStargateFacet(address(diamond));
        stargate.setLayerZeroChainId(1, 101);
        stargate.setLayerZeroChainId(137, 109);
        stargate.setStargatePoolId(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 1);
        stargate.setStargatePoolId(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174, 1);
    }

    function testCanGetFees() public {
        vm.startPrank(USDC_HOLDER);
        StargateFacet.StargateData memory stargateData = StargateFacet.StargateData(
            MAINNET_ROUTER,
            2,
            100,
            0,
            abi.encodePacked(USDC_HOLDER),
            ""
        );
        stargate.quoteLayerZeroFee(137, stargateData);
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(stargate), 10_000 * 10**usdc.decimals());
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "stargate",
            "",
            address(0),
            USDC_ADDRESS,
            USDC_HOLDER,
            10,
            137,
            false,
            false
        );
        StargateFacet.StargateData memory data = StargateFacet.StargateData(
            MAINNET_ROUTER,
            1,
            9,
            0,
            abi.encodePacked(address(0)),
            '0x'
        );
        stargate.startBridgeTokensViaStargate(bridgeData, data);
        vm.stopPrank();
    }
}
