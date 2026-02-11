// VIOLATION: Missing SPDX license identifier and incorrect pragma format
// Should start with: // SPDX-License-Identifier: LGPL-3.0-only
// Should be immediately followed by: pragma solidity ^0.8.17; (no blank line between)

// Bad: Missing SPDX license identifier
// Bad: Blank line before pragma
pragma solidity ^0.8.20;

// Bad: Wrong pragma version (should be ^0.8.17)

/**
 * @title BadLicensePragma
 * @author LI.FI (https://li.fi)
 * @notice Example contract violating license and pragma conventions
 * @custom:version 1.0.0
 */
contract BadLicensePragma {
    uint256 public value;

    function setValue(uint256 _value) external {
        value = _value;
    }
}
