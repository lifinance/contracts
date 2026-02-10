// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Interface does not use the required I* prefix
// Violation: Incorrect location - should live under src/Interfaces/
// Violation: Includes many unused functions (should only declare what is actually used)
interface BadExternalProtocol {
    function function1() external;
    function function2() external;
    function function3() external;
    function function4() external;
    function function5() external;
    // Many functions that are never used
}

// Violation: Mixes interface and implementation in the same file
contract BadImplementation is BadExternalProtocol {
    function function1() external override {}
}
