// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface ICommonOwner {
    function transferOwnership(address _newOwner) external;

    function addPauser(address _account) external;

    function removePauser(address _account) external;
}
