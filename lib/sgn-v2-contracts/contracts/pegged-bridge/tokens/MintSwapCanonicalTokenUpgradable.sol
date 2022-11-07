// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "./MintSwapCanonicalToken.sol";

/**
 * @title Upgradable canonical token that supports multi-bridge minter and multi-token swap
 */

// First deploy this contract, constructor will set name, symbol and owner in contract state, but these are NOT used.
// decimal isn't saved in state because it's immutable in MultiBridgeToken and will be set in the code binary.
// Then deploy proxy contract with this contract as impl, proxy constructor will delegatecall this.init which sets name, symbol and owner in proxy contract state.
// why we need to shadow name and symbol: ERC20 only allows set them in constructor which isn't available after deploy so proxy state can't be updated.
contract MintSwapCanonicalTokenUpgradable is MintSwapCanonicalToken {
    string private _name;
    string private _symbol;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) MintSwapCanonicalToken(name_, symbol_, decimals_) {}

    // only to be called by Proxy via delegatecall and will modify Proxy state
    // this func has no access control because initOwner only allows delegateCall
    function init(string memory name_, string memory symbol_) external {
        initOwner(); // this will fail if Ownable._owner is already set
        _name = name_;
        _symbol = symbol_;
    }

    // override name, symbol and owner getters
    function name() public view virtual override returns (string memory) {
        return _name;
    }

    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }
}
