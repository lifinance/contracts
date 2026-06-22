// SPDX-License-Identifier: Unlicensed
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { DeployPeripheryHelpers } from "../utils/DeployPeripheryHelpers.sol";

contract ERC20ProxyTest is Test {
    ERC20Proxy public erc20Proxy;
    address public proxyOwner;
    address public executorAddress;

    function setUp() public {
        proxyOwner = address(123456);
        executorAddress = address(789012);
        erc20Proxy = new ERC20Proxy(proxyOwner, executorAddress);
    }

    function test_DeploysWithoutErrors() public {
        erc20Proxy = new ERC20Proxy(proxyOwner, address(0));

        assertEq(erc20Proxy.owner(), proxyOwner);
    }

    function testRevert_CannotDeployWithZeroOwner() public {
        vm.expectRevert(InvalidConfig.selector);
        new ERC20Proxy(address(0), executorAddress);
    }

    function test_ExecutorAddressIsAuthorizedAtDeploy() public {
        assertTrue(
            erc20Proxy.authorizedCallers(executorAddress),
            "Executor address should be authorized at deploy time"
        );
    }

    function test_DeployPeripheryHelperMatchesProductionPattern() public {
        (ERC20Proxy proxy, Executor executor) = DeployPeripheryHelpers
            .deployERC20ProxyAndExecutor(address(this), proxyOwner);

        assertTrue(proxy.authorizedCallers(address(executor)));
        assertEq(proxy.owner(), proxyOwner);
    }

    function test_CannotReceiveETH() public {
        (bool success, ) = address(erc20Proxy).call{ value: 1 ether }("");

        assertTrue(
            success == false,
            "Contract can receive ETH but should not be able to"
        );
    }
}
