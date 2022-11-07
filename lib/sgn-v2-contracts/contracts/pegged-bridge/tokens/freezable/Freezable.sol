// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

abstract contract Freezable {
    event Frozen(address account);
    event Unfrozen(address account);
    mapping(address => bool) internal freezes;

    function isFrozen(address _account) public view virtual returns (bool) {
        return freezes[_account];
    }

    modifier whenAccountNotFrozen(address _account) {
        require(!isFrozen(_account), "Freezable: frozen");
        _;
    }

    modifier whenAccountFrozen(address _account) {
        require(isFrozen(_account), "Freezable: not frozen");
        _;
    }
}
