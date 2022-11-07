// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "./Ownable.sol";

abstract contract Whitelist is Ownable {
    mapping(address => bool) public whitelist;
    bool public whitelistEnabled;

    event WhitelistedAdded(address account);
    event WhitelistedRemoved(address account);

    modifier onlyWhitelisted() {
        if (whitelistEnabled) {
            require(isWhitelisted(msg.sender), "Caller is not whitelisted");
        }
        _;
    }

    /**
     * @notice Set whitelistEnabled
     */
    function setWhitelistEnabled(bool _whitelistEnabled) external onlyOwner {
        whitelistEnabled = _whitelistEnabled;
    }

    /**
     * @notice Add an account to whitelist
     */
    function addWhitelisted(address account) external onlyOwner {
        require(!isWhitelisted(account), "Already whitelisted");
        whitelist[account] = true;
        emit WhitelistedAdded(account);
    }

    /**
     * @notice Remove an account from whitelist
     */
    function removeWhitelisted(address account) external onlyOwner {
        require(isWhitelisted(account), "Not whitelisted");
        whitelist[account] = false;
        emit WhitelistedRemoved(account);
    }

    /**
     * @return is account whitelisted
     */
    function isWhitelisted(address account) public view returns (bool) {
        return whitelist[account];
    }
}
