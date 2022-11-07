// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface IUpgradeableOwner {
    function changeProxyAdmin(address _proxy, address _newAdmin) external;

    function upgrade(address _proxy, address _implementation) external;

    function upgradeAndCall(
        address _proxy,
        address _implementation,
        bytes calldata _data
    ) external;

    function upgradeTo(address _implementation) external;

    function upgradeToAndCall(address _implementation, bytes calldata _data) external;
}
