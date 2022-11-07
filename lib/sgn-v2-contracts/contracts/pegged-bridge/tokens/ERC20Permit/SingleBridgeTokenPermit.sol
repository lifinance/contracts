// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";
import "../SingleBridgeToken.sol";

/**
 * @title Example Pegged ERC20Permit token
 */
contract SingleBridgeTokenPermit is ERC20Permit, SingleBridgeToken {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address bridge_
    ) SingleBridgeToken(name_, symbol_, decimals_, bridge_) ERC20Permit(name_) {
        _decimals = decimals_;
    }

    function decimals() public view override(ERC20, SingleBridgeToken) returns (uint8) {
        return _decimals;
    }
}
