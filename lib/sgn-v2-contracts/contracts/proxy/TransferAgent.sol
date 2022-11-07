// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../libraries/BridgeTransferLib.sol";
import "../safeguard/Ownable.sol";

/**
 * @title Transfer agent. Designed to support arbitrary length receiver address for transfer. Supports the liquidity pool-based {Bridge}, the {OriginalTokenVault} for pegged
 * deposit and the {PeggedTokenBridge} for pegged burn.
 */
contract TransferAgent is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    struct Extension {
        uint8 Type;
        bytes Value;
    }

    mapping(BridgeTransferLib.BridgeSendType => address) public bridges;

    event Supplement(
        BridgeTransferLib.BridgeSendType bridgeSendType,
        bytes32 transferId,
        address sender,
        bytes receiver,
        Extension[] extensions
    );
    event BridgeUpdated(BridgeTransferLib.BridgeSendType bridgeSendType, address bridgeAddr);

    /**
     * @notice Send a cross-chain transfer of ERC20 token either via liquidity pool-based bridge or in form of mint/burn.
     * @param _receiver The address of the receiver.
     * @param _token The address of the token.
     * @param _amount The amount of the transfer.
     * @param _dstChainId The destination chain ID.
     * @param _nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
     * @param _maxSlippage The max slippage accepted, given as percentage in point (pip). Eg. 5000 means 0.5%.
     *        Must be greater than minimalMaxSlippage. Receiver is guaranteed to receive at least
     *        (100% - max slippage percentage) * amount or the transfer can be refunded.
     *        Only applicable to the {BridgeSendType.Liquidity}.
     * @param _bridgeSendType The type of bridge used by this transfer. One of the {BridgeSendType} enum.
     * @param _extensions A list of extension to be processed by agent, is designed to be used for extending
     *        present transfer. Contact Celer team to learn about already supported type of extension.
     */
    function transfer(
        bytes calldata _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage, // slippage * 1M, eg. 0.5% -> 5000
        BridgeTransferLib.BridgeSendType _bridgeSendType,
        Extension[] calldata _extensions
    ) external nonReentrant returns (bytes32) {
        bytes32 transferId;
        {
            address _bridgeAddr = bridges[_bridgeSendType];
            require(_bridgeAddr != address(0), "unknown bridge type");
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
            transferId = BridgeTransferLib.sendTransfer(
                address(0),
                _token,
                _amount,
                _dstChainId,
                _nonce,
                _maxSlippage,
                _bridgeSendType,
                _bridgeAddr
            );
        }
        emit Supplement(_bridgeSendType, transferId, msg.sender, _receiver, _extensions);
        return transferId;
    }

    /**
     * @notice Send a cross-chain transfer of native token either via liquidity pool-based bridge or in form of mint/burn.
     * @param _receiver The address of the receiver.
     * @param _amount The amount of the transfer.
     * @param _dstChainId The destination chain ID.
     * @param _nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
     * @param _maxSlippage The max slippage accepted, given as percentage in point (pip). Eg. 5000 means 0.5%.
     *        Must be greater than minimalMaxSlippage. Receiver is guaranteed to receive at least
     *        (100% - max slippage percentage) * amount or the transfer can be refunded.
     *        Only applicable to the {BridgeSendType.Liquidity}.
     * @param _bridgeSendType The type of bridge used by this transfer. One of the {BridgeSendType} enum.
     * @param _extensions A list of extension to be processed by agent, is designed to be used for extending
     *        present transfer. Contact Celer team to learn about already supported type of extension.
     */
    function transferNative(
        bytes calldata _receiver,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage, // slippage * 1M, eg. 0.5% -> 5000
        BridgeTransferLib.BridgeSendType _bridgeSendType,
        Extension[] calldata _extensions
    ) external payable nonReentrant returns (bytes32) {
        bytes32 transferId;
        {
            address _bridgeAddr = bridges[_bridgeSendType];
            require(_bridgeAddr != address(0), "unknown bridge type");
            require(msg.value == _amount, "amount mismatch");
            transferId = BridgeTransferLib.sendNativeTransfer(
                address(0),
                _amount,
                _dstChainId,
                _nonce,
                _maxSlippage,
                _bridgeSendType,
                _bridgeAddr
            );
        }
        emit Supplement(_bridgeSendType, transferId, msg.sender, _receiver, _extensions);
        return transferId;
    }

    // ----------------------Admin operation-----------------------

    function setBridgeAddress(BridgeTransferLib.BridgeSendType _bridgeSendType, address _addr) public onlyOwner {
        require(_addr != address(0), "invalid address");
        bridges[_bridgeSendType] = _addr;
        emit BridgeUpdated(_bridgeSendType, _addr);
    }
}
