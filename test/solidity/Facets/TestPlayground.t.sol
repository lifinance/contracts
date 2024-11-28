// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { console, ERC20 } from "../utils/TestBaseFacet.sol";
import { Test } from "forge-std/Test.sol";

interface Pac {
    function withdrawERC20(
        address asset,
        uint256 amount,
        address wallet
    ) external;

    function withdrawETH(uint256 amount, address wallet) external;
}

contract TestPlayground is Test {
    address public constant WALLET =
        0x021b8D868A589Aad0Dd1297Dce136D31b23BdFE7;

    uint256 testAmount = 168729168935;
    uint256 depositAmount = 249871101462317036585;
    address public constant O_ETHER =
        0x0872b71EFC37CB8DdE22B2118De3d800427fdba0;
    address public constant AO_ETHER =
        0x68915399201380f392019555947491e5b3eDFa0e;
    address public constant PAC_FINANCE =
        0xfDe98aB7a6602ad55462297D952CE25b58743140;

    // -----

    function setUp() public {
        vm.createSelectFork(vm.envString("ETH_NODE_URI_BLAST"), 11972309);

        vm.label(WALLET, "WALLET");
        vm.label(AO_ETHER, "AO_ETHER");
        vm.label(PAC_FINANCE, "PAC_FINANCE");
    }

    function test_Ali() public {
        vm.startPrank(WALLET);
        ERC20 token = ERC20(AO_ETHER);

        uint256 balanceAO = token.balanceOf(WALLET);
        console.log("balance wallet: ", balanceAO);

        token.approve(PAC_FINANCE, type(uint256).max);

        // Pac(PAC_FINANCE).withdrawERC20(O_ETHER, type(uint256).max, WALLET);
        Pac(PAC_FINANCE).withdrawERC20(O_ETHER, testAmount, WALLET);

        // Pac(PAC_FINANCE).withdrawETH(testAmount, WALLET);
    }
}
