// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Test, console } from "forge-std/Test.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "lifi/Interfaces/ISignatureTransfer.sol";
import "forge-std/console.sol";

contract Permit2ProxyTest is Test {
    Permit2Proxy public permit2proxy;

    function setUp() public {
        permit2proxy = new Permit2Proxy();
        vm.createSelectFork(vm.envString("ETH_NODE_URI_MAINNET"), 20261175);
        console.logAddress(address(permit2proxy));
    }

    function test_hardcoded_sig() public {
        uint256 amount = 10 ** 18;
        address token = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        address owner = vm.addr(
            0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
        );

        ISignatureTransfer.PermitTransferFrom
            memory transfer = ISignatureTransfer.PermitTransferFrom(
                ISignatureTransfer.TokenPermissions(token, amount),
                0,
                type(uint256).max
            );

        bytes
            memory sig = hex"496bd11f1de6e3824f1d8032977c10f752ceb1bda1aec025b5b5a7956ffb0e182a0ae2d49de265ff334b47f7adf6233f5455b1d6d3a921ccdfcfbd4c2cab218e1b";
        console.logBytes(sig);
        permit2proxy.diamondCallSingle(
            address(0),
            address(0),
            keccak256(hex"deadbeef"),
            hex"deadbeef",
            owner,
            transfer,
            sig
        );
    }
}
