// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface IMessageOwner {
    function setFeePerByte(uint256 _fee) external;

    function setFeeBase(uint256 _fee) external;

    function setLiquidityBridge(address _addr) external;

    function setPegBridge(address _addr) external;

    function setPegVault(address _addr) external;

    function setPegBridgeV2(address _addr) external;

    function setPegVaultV2(address _addr) external;

    function setPreExecuteMessageGasUsage(uint256 _usage) external;
}
