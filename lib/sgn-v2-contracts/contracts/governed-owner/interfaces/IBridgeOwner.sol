// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface IBridgeOwner {
    // for bridges

    function resetSigners(address[] calldata _signers, uint256[] calldata _powers) external;

    function notifyResetSigners() external;

    function increaseNoticePeriod(uint256 _period) external;

    function setWrap(address _token) external;

    function setSupply(address _token, uint256 _supply) external;

    function increaseSupply(address _token, uint256 _delta) external;

    function decreaseSupply(address _token, uint256 _delta) external;

    function addGovernor(address _account) external;

    function removeGovernor(address _account) external;

    // for bridge tokens

    function updateBridge(address _bridge) external;

    function updateBridgeSupplyCap(address _bridge, uint256 _cap) external;

    function setBridgeTokenSwapCap(address _bridgeToken, uint256 _swapCap) external;
}
