// SPDX-License-Identifier: Unlicensed
pragma solidity ^0.8.17;

import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { DSTest } from "ds-test/test.sol";

contract ERC20ProxyTest is DSTest {
    ERC20Proxy public erc20Proxy;
    address public proxyOwner;

    function setUp() public {
        proxyOwner = address(123456);
        erc20Proxy = new ERC20Proxy(proxyOwner);
    }

    function test_DeploysWithoutErrors() public {
        erc20Proxy = new ERC20Proxy(proxyOwner);

        assertEq(erc20Proxy.owner(), proxyOwner);
    }

    function test_CannotReceiveETH() public {
        (bool success, ) = address(erc20Proxy).call{ value: 1 ether }("");

        assertTrue(
            success == false,
            "Contract can receive ETH but should not be able to"
        );
    }
}
