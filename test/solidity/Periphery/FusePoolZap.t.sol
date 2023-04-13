// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { IFusePool, IFToken, FusePoolZap } from "lifi/Periphery/FusePoolZap.sol";

contract FusePoolZapTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    FusePoolZap internal zap;

    address internal constant TRIBE_FUSE_POOL =
        0x07cd53380FE9B2a5E64099591b498c73F0EfaA66;
    address internal constant FRAX3CRV =
        0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B;
    address internal constant FTOKEN =
        0x2ec70d3Ff3FD7ac5c2a72AAA64A398b6CA7428A5;
    address internal constant FETHER =
        0xe92a3db67e4b6AC86114149F522644b34264f858;
    address internal constant DEPOSITOR =
        0x47Bc10781E8f71c0e7cf97B0a5a88F4CFfF21309;
    address internal constant FUSE_POOL_DIRECTORY =
        0x835482FE0532f169024d5E9410199369aAD5C77E;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 14847528;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        vm.rollFork(14533013);
        zap = new FusePoolZap(FUSE_POOL_DIRECTORY);
    }

    function testCanZapIn() public {
        vm.startPrank(DEPOSITOR);

        uint256 amount = 1000 * 10 ** ERC20(FRAX3CRV).decimals();

        ERC20(FRAX3CRV).approve(address(zap), amount);
        zap.zapIn(TRIBE_FUSE_POOL, FRAX3CRV, amount);

        // Should get 5000 fTokens back
        assertEq(
            ERC20(FTOKEN).balanceOf(DEPOSITOR),
            5000 * 10 ** ERC20(FTOKEN).decimals()
        );

        ERC20(FRAX3CRV).approve(address(zap), amount);
        vm.expectRevert(
            abi.encodeWithSelector(
                FusePoolZap.InvalidPoolAddress.selector,
                address(0xb33f)
            )
        );
        zap.zapIn(address(0xb33f), FRAX3CRV, amount);

        vm.stopPrank();
    }

    function testCanZapInWithEth() public {
        vm.startPrank(DEPOSITOR);

        uint256 amount = 0.01 ether;

        zap.zapIn{ value: amount }(TRIBE_FUSE_POOL);

        // Should get 0.05 fETHER back
        assertEq(ERC20(FETHER).balanceOf(DEPOSITOR), 0.05 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                FusePoolZap.InvalidPoolAddress.selector,
                address(0xb33f)
            )
        );
        zap.zapIn{ value: amount }(address(0xb33f));

        vm.stopPrank();
    }
}
