// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "./Freezable.sol";
import "../MintSwapCanonicalTokenUpgradable.sol";

/**
 * @title Upgradable canonical token that supports multi-bridge minter and multi-token swap. Support freezable erc20 transfer
 */
contract MintSwapCanonicalTokenUpgradableFreezable is MintSwapCanonicalTokenUpgradable, Freezable {
    string private _name;
    string private _symbol;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) MintSwapCanonicalTokenUpgradable(name_, symbol_, decimals_) {}

    // freezable related
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        super._beforeTokenTransfer(from, to, amount);
        require(!isFrozen(from), "ERC20Freezable: from account is frozen");
        require(!isFrozen(to), "ERC20Freezable: to account is frozen");
    }

    function freeze(address _account) public onlyOwner {
        freezes[_account] = true;
        emit Frozen(_account);
    }

    function unfreeze(address _account) public onlyOwner {
        freezes[_account] = false;
        emit Unfrozen(_account);
    }
}
