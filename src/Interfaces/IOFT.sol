// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IOFT {
    struct FeeObj {
        uint256 callerBps;
        address caller;
        bytes2 partnerId;
    }

    function sendFrom(
        address _from,
        uint16 _dstChainId,
        bytes memory _toAddress,
        uint256 _amount,
        address _refundAddress,
        address _zroPaymentAddress,
        bytes memory _adapterParams
    ) external payable;

    function estimateSendFee(
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint _amount,
        bool _useZro,
        bytes calldata _adapterParams
    ) external view returns (uint nativeFee, uint zroFee);
}
