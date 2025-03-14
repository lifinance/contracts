// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";
import { Safe } from "@safe-smart-account/contracts/Safe.sol";
import { SafeProxyFactory } from "@safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import { CompatibilityFallbackHandler } from "@safe-smart-account/contracts/handler/CompatibilityFallbackHandler.sol";
import { CreateCall } from "@safe-smart-account/contracts/libraries/CreateCall.sol";
import { MultiSend } from "@safe-smart-account/contracts/libraries/MultiSend.sol";
import { MultiSendCallOnly } from "@safe-smart-account/contracts/libraries/MultiSendCallOnly.sol";
import { SignMessageLib } from "@safe-smart-account/contracts/libraries/SignMessageLib.sol";
import { SafeL2 } from "@safe-smart-account/contracts/SafeL2.sol";

contract DeploySafeSingletonFactory is Script, DSTest {
    function run() external {
        vm.startBroadcast();

        Safe safe = new Safe();
        emit log_named_address("Safe deployed at:", address(safe));

        SafeProxyFactory proxyFactory = new SafeProxyFactory();
        emit log_named_address(
            "Proxy Factory deployed at:",
            address(proxyFactory)
        );

        CompatibilityFallbackHandler fallbackHandler = new CompatibilityFallbackHandler();
        emit log_named_address(
            "CompatibilityFallbackHandler deployed at:",
            address(fallbackHandler)
        );

        CreateCall createCall = new CreateCall();
        emit log_named_address("CreateCall deployed at:", address(createCall));

        MultiSend multiSend = new MultiSend();
        emit log_named_address("MultiSend deployed at:", address(multiSend));

        MultiSendCallOnly multiSendCallOnly = new MultiSendCallOnly();
        emit log_named_address(
            "MultiSendCallOnly deployed at:",
            address(multiSendCallOnly)
        );

        SignMessageLib signMessageLib = new SignMessageLib();
        emit log_named_address(
            "SignMessageLib deployed at:",
            address(signMessageLib)
        );

        SafeL2 safeL2 = new SafeL2();
        emit log_named_address("SafeL2 deployed at:", address(safeL2));

        vm.stopBroadcast();
    }
}
