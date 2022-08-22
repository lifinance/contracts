// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

// Stub CBridgeFacet Contract
contract TestAcrossFacet is AcrossFacet {
    function addDex(address _dex) external {
        mapping(address => bool) storage dexAllowlist = appStorage.dexAllowlist;

        if (dexAllowlist[_dex]) {
            return;
        }

        dexAllowlist[_dex] = true;
        appStorage.dexs.push(_dex);
    }

    function setFunctionApprovalBySignature(bytes32 signature) external {
        mapping(bytes32 => bool) storage dexFuncSignatureAllowList = appStorage.dexFuncSignatureAllowList;
        if (dexFuncSignatureAllowList[signature]) return;
        dexFuncSignatureAllowList[signature] = true;
    }
}

contract AcrossFacetTest is DSTest, DiamondTest {
    // These values are for Optimism_Kovan
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant ETH_HOLDER = 0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal WETH_HOLDER = 0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal SPOKE_POOL = 0x4D9079Bb4165aeb4084c526a32695dCfd2F77381;
    // -----
    ILiFi.LiFiData internal lifiData = ILiFi.LiFiData("", "", address(0), address(0), address(0), address(0), 0, 0);

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestAcrossFacet internal across;
    ERC20 internal usdc;
    ERC20 internal weth;

    function setUp() public {
        diamond = createDiamond();
        across = new TestAcrossFacet();
        usdc = ERC20(USDC_ADDRESS);
        weth = ERC20(WETH_ADDRESS);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = across.startBridgeTokensViaAcross.selector;

        addFacet(diamond, address(across), functionSelectors);

        across = TestAcrossFacet(address(diamond));
    }

    function testCanBridgeNativeTokens() public {
        vm.startPrank(ETH_HOLDER);
        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            WETH_ADDRESS,
            SPOKE_POOL,
            ETH_HOLDER,
            0x0000000000000000000000000000000000000000, // token
            1000000000000000000, // amt
            137, // Polygon chain id
            0, // Relayer fee
            uint32(block.timestamp)
        );
        across.startBridgeTokensViaAcross{ value: 1000000000000000000 }(lifiData, data);
        vm.stopPrank();
    }

    function testCanBridgeERC20Tokens() public {
        vm.startPrank(WETH_HOLDER);
        weth.approve(address(across), 10_000 * 10**weth.decimals());
        AcrossFacet.AcrossData memory data = AcrossFacet.AcrossData(
            WETH_ADDRESS,
            SPOKE_POOL,
            WETH_HOLDER,
            WETH_ADDRESS, // token
            100000, // amt
            137, // Polygon chain id
            0, // Relayer fee
            uint32(block.timestamp)
        );
        across.startBridgeTokensViaAcross(lifiData, data);
        vm.stopPrank();
    }
}
