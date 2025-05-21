// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";

address constant PERMIT2 = address(0x000000000022D473030F116dDEE9F6B43aC78BA3);

contract Permit2Check is Script {
    address public toCheck = PERMIT2;

    error RuntimeCodesAreNotTheSame();

    function checkCode(address target, bytes memory expected) public virtual {
        if (keccak256(expected) != keccak256(target.code))
            revert RuntimeCodesAreNotTheSame();
    }

    function checkCode(bytes memory expected) public virtual {
        checkCode(toCheck, expected);
    }
}
