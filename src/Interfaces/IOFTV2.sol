// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IOFTV2 {
    struct LzCallParams {
        address payable refundAddress;
        address zroPaymentAddress;
        bytes adapterParams;
    }

    function sendFrom(
        address _from,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        LzCallParams memory _callParams
    ) external payable;

    function estimateSendFee(
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint _amount,
        bool _useZro,
        bytes calldata _adapterParams
    ) external view returns (uint nativeFee, uint zroFee);
}
