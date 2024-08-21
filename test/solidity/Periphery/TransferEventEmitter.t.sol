// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { TransferEventEmitter } from "lifi/Periphery/TransferEventEmitter.sol";

contract TransferEventEmitterTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    TransferEventEmitter internal eventEmitter;

    event TokensTransferred();

    function setUp() public {
        eventEmitter = new TransferEventEmitter();
    }

    function testCanEmitTransferEvent() public {
        vm.expectEmit();
        emit TokensTransferred();
        eventEmitter.emitTransferEvent();
    }
}
