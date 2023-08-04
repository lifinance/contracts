// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IOFT {
    function estimateSendFee(
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint _amount,
        bool _useZro,
        bytes calldata _adapterParams
    ) external view returns (uint nativeFee, uint zroFee);
}

interface IOFTV2 {
    function estimateSendFee(
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint _amount,
        bool _useZro,
        bytes calldata _adapterParams
    ) external view returns (uint nativeFee, uint zroFee);
}

interface IProxyOFT {
    function token() external view returns (address);
}

interface IOFTWrapper {
    struct LzCallParams {
        address payable refundAddress;
        address zroPaymentAddress;
        bytes adapterParams;
    }

    struct FeeObj {
        uint256 callerBps;
        address caller;
        bytes2 partnerId;
    }

    function sendOFT(
        address _oft,
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams,
        FeeObj calldata _feeObj
    ) external payable;

    function sendProxyOFT(
        address _proxyOft,
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams,
        FeeObj calldata _feeObj
    ) external payable;

    function sendOFTV2(
        address _oft,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        LzCallParams calldata _callParams,
        FeeObj calldata _feeObj
    ) external payable;

    function sendOFTFeeV2(
        address _oft,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        LzCallParams calldata _callParams,
        FeeObj calldata _feeObj
    ) external payable;

    function sendProxyOFTV2(
        address _proxyOft,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        LzCallParams calldata _callParams,
        FeeObj calldata _feeObj
    ) external payable;

    function sendProxyOFTFeeV2(
        address _proxyOft,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        LzCallParams calldata _callParams,
        FeeObj calldata _feeObj
    ) external payable;

    function getAmountAndFees(
        address _token,
        uint256 _amount,
        uint256 _callerBps
    )
        external
        view
        returns (uint256 amount, uint256 wrapperFee, uint256 callerFee);

    function estimateSendFee(
        address _oft,
        uint16 _dstChainId,
        bytes calldata _toAddress,
        uint256 _amount,
        bool _useZro,
        bytes calldata _adapterParams,
        FeeObj calldata _feeObj
    ) external view returns (uint nativeFee, uint zroFee);

    function estimateSendFeeV2(
        address _oft,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        bool _useZro,
        bytes calldata _adapterParams,
        FeeObj calldata _feeObj
    ) external view returns (uint nativeFee, uint zroFee);
}
