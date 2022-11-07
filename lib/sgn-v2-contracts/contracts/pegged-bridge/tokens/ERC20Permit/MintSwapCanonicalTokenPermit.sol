// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";
import "../MintSwapCanonicalToken.sol";

/**
 * @title MintSwapCanonicalToke with ERC20Permit
 */
contract MintSwapCanonicalTokenPermit is ERC20Permit, MintSwapCanonicalToken {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) MintSwapCanonicalToken(name_, symbol_, decimals_) ERC20Permit(name_) {
        _decimals = decimals_;
    }

    function decimals() public view override(ERC20, MultiBridgeToken) returns (uint8) {
        return _decimals;
    }
}
