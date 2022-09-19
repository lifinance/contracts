// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.16;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { SwapperV2, LibSwap } from "lifi/Helpers/SwapperV2.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { TestAMM } from "../utils/TestAMM.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

// Stub SwapperV2 Contract
contract TestSwapperV2 is SwapperV2 {
    function doSwaps(LibSwap.SwapData calldata _swapData) public {

        LibAsset.depositAssets(_swapData.swaps);
        _executeAndCheckSwaps(
            LiFiData("", "", address(0), address(0), address(0), address(0), 0, 0),
            _swapData,
            payable(address(0xb33f))
        );

        // Fake send to bridge
        ERC20 finalAsset = ERC20(_swapData.swaps[_swapData.swaps.length - 1].receivingAssetId);
        finalAsset.transfer(address(1337), finalAsset.balanceOf(address(this)));
    }

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract SwapperV2Test is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestAMM internal amm;
    TestSwapperV2 internal swapper;

    function setUp() public {
        diamond = createDiamond();
        amm = new TestAMM();
        swapper = new TestSwapperV2();

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = TestSwapperV2.doSwaps.selector;
        functionSelectors[1] = TestSwapperV2.addDex.selector;
        functionSelectors[2] = TestSwapperV2.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(swapper), functionSelectors);

        swapper = TestSwapperV2(address(diamond));
        swapper.addDex(address(amm));
        swapper.setFunctionApprovalBySignature(bytes4(amm.swap.selector));
    }

    function testSwapCleanup() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);
        ERC20 token3 = new ERC20("Token 3", "T3", 18);

        LibSwap.Swap[] memory swaps = new LibSwap.Swap[](2);

        swaps[0] = LibSwap.Swap(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(amm.swap.selector, token1, 10_000 ether, token2, 10_100 ether),
            true
        );

        swaps[1] = LibSwap.Swap(
            address(amm),
            address(amm),
            address(token2),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(amm.swap.selector, token2, 10_000 ether, token3, 10_200 ether),
            false
        );
        
        // 95%
        LibSwap.SwapData memory swapData = LibSwap.SwapData(swaps, 10_000 ether * 95 / 100);
        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token1.balanceOf(address(amm)), 0);
        assertEq(token2.balanceOf(address(0xb33f)), 100 ether);
        assertEq(token3.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(1337)), 10_200 ether);
    }

    function testSwapMultiInOne() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);
        ERC20 token3 = new ERC20("Token 3", "T3", 18);

        LibSwap.Swap[] memory swaps = new LibSwap.Swap[](2);

        swaps[0] = LibSwap.Swap(
            address(amm),
            address(amm),
            address(token1),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(amm.swap.selector, token1, 10_000 ether, token3, 10_100 ether),
            true
        );

        swaps[1] = LibSwap.Swap(
            address(amm),
            address(amm),
            address(token2),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(amm.swap.selector, token2, 10_000 ether, token3, 10_200 ether),
            true
        );
        LibSwap.SwapData memory swapData = LibSwap.SwapData(swaps, 10_000 ether * 95 / 100);

        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        token2.mint(address(this), 10_000 ether);
        token2.approve(address(swapper), 10_000 ether);

        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token2.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(1337)), 20_300 ether);
    }

    function testSingleSwap() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);

        LibSwap.Swap[] memory swaps = new LibSwap.Swap[](1);

        swaps[0] = LibSwap.Swap(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(amm.swap.selector, token1, 10_000 ether, token2, 10_100 ether),
            true
        );
        LibSwap.SwapData memory swapData = LibSwap.SwapData(swaps, 10_000 ether * 95 / 100);
        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);
        
        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token1.balanceOf(address(amm)), 0);
        assertEq(token2.balanceOf(address(1337)), 10_100 ether);
    }
}
