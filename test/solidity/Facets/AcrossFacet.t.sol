// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.16;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

// Stub CBridgeFacet Contract
contract TestAcrossFacet is AcrossFacet {
    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(IAcrossSpokePool _spokePool) AcrossFacet(_spokePool, WETH_ADDRESS) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AcrossFacetTest is DSTest, DiamondTest {
    // These values are for Optimism_Kovan
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant ETH_HOLDER = 0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER = 0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SPOKE_POOL = 0x4D9079Bb4165aeb4084c526a32695dCfd2F77381;
    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestAcrossFacet internal across;
    ERC20 internal usdc;
    ERC20 internal weth;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        across = new TestAcrossFacet(IAcrossSpokePool(SPOKE_POOL));
        usdc = ERC20(USDC_ADDRESS);
        weth = ERC20(WETH_ADDRESS);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = across.startBridgeTokensViaAcross.selector;

        addFacet(diamond, address(across), functionSelectors);

        across = TestAcrossFacet(address(diamond));
    }

    function testCanBridgeNativeTokens() public {
        vm.startPrank(ETH_HOLDER);
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "across",
            "",
            address(0),
            address(0),
            ETH_HOLDER,
            1000000000000000000,
            137,
            false,
            false
        );

        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            0, // Relayer fee
            uint32(block.timestamp)
        );
        across.startBridgeTokensViaAcross{ value: 1000000000000000000 }(bridgeData, data);
        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(WETH_HOLDER);
        weth.approve(address(across), 10_000 * 10**weth.decimals());
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "across",
            "",
            address(0),
            WETH_ADDRESS,
            WETH_HOLDER,
            100000,
            137,
            false,
            false
        );
        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            0, // Relayer fee
            uint32(block.timestamp)
        );
        across.startBridgeTokensViaAcross(bridgeData, data);
        vm.stopPrank();
    }
}
