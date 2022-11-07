// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

interface IPool {
    function addLiquidity(address _token, uint256 _amount) external;

    function withdraws(bytes32 withdrawId) external view returns (bool);

    function withdraw(
        bytes calldata _wdmsg,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers
    ) external;
}
