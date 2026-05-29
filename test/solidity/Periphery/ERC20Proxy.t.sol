// SPDX-License-Identifier: Unlicensed
pragma solidity ^0.8.17;

import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { DSTest } from "ds-test/test.sol";

contract ERC20ProxyTest is DSTest {
    ERC20Proxy public erc20Proxy;
    address public proxyOwner;
    address public initialAuthorizedCaller;

    function setUp() public {
        proxyOwner = address(123456);
        initialAuthorizedCaller = address(789012);
        erc20Proxy = new ERC20Proxy(proxyOwner, initialAuthorizedCaller);
    }

    function test_DeploysWithoutErrors() public {
        erc20Proxy = new ERC20Proxy(proxyOwner, address(0));

        assertEq(erc20Proxy.owner(), proxyOwner);
    }

    function test_InitialAuthorizedCallerIsSetAtDeploy() public {
        assertTrue(
            erc20Proxy.authorizedCallers(initialAuthorizedCaller),
            "Initial authorized caller should be set at deploy time"
        );
    }

    function test_CannotReceiveETH() public {
        (bool success, ) = address(erc20Proxy).call{ value: 1 ether }("");

        assertTrue(
            success == false,
            "Contract can receive ETH but should not be able to"
        );
    }
}
