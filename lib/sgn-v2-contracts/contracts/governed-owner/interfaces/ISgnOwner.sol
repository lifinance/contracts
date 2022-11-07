// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface ISgnOwner {
    function setWhitelistEnabled(bool _whitelistEnabled) external;

    function addWhitelisted(address _account) external;

    function removeWhitelisted(address _account) external;

    function setGovContract(address _addr) external;

    function setRewardContract(address _addr) external;

    function setMaxSlashFactor(uint256 _maxSlashFactor) external;
}
