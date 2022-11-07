pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";

contract CBridgeGasTest is DSTest, DiamondTest {
    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    ICBridge internal immutable cBridgeRouter = ICBridge(CBRIDGE_ROUTER);
    LiFiDiamond internal diamond;
    CBridgeFacet internal cBridge;
    ERC20 internal usdc;
    ERC20 internal dai;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        cBridge = new CBridgeFacet(cBridgeRouter);
        usdc = ERC20(USDC_ADDRESS);

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = CBridgeFacet(address(diamond));
    }

    function testDirectBridge() public {
        uint256 amount = 100 * 10**usdc.decimals();

        vm.startPrank(WHALE);
        usdc.approve(address(cBridgeRouter), amount);
        cBridgeRouter.send(WHALE, USDC_ADDRESS, amount, 137, 1, 5000);
        vm.stopPrank();
    }

    function testLifiBridge() public {
        uint256 amount = 100 * 10**usdc.decimals();

        vm.startPrank(WHALE);
        usdc.approve(address(cBridge), amount);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            USDC_ADDRESS,
            WHALE,
            amount,
            100,
            false,
            false
        );

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, 1);

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }
}
