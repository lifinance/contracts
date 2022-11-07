// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./PbBridge.sol";
import "./PbPegged.sol";
import "./PbPool.sol";
import "../interfaces/IBridge.sol";
import "../interfaces/IOriginalTokenVault.sol";
import "../interfaces/IOriginalTokenVaultV2.sol";
import "../interfaces/IPeggedTokenBridge.sol";
import "../interfaces/IPeggedTokenBridgeV2.sol";

interface INativeWrap {
    function nativeWrap() external view returns (address);
}

library BridgeTransferLib {
    using SafeERC20 for IERC20;

    enum BridgeSendType {
        Null,
        Liquidity,
        PegDeposit,
        PegBurn,
        PegV2Deposit,
        PegV2Burn,
        PegV2BurnFrom
    }

    enum BridgeReceiveType {
        Null,
        LqRelay,
        LqWithdraw,
        PegMint,
        PegWithdraw,
        PegV2Mint,
        PegV2Withdraw
    }

    struct ReceiveInfo {
        bytes32 transferId;
        address receiver;
        address token; // 0 address for native token
        uint256 amount;
        bytes32 refid; // reference id, e.g., srcTransferId for refund
    }

    // ============== Internal library functions called by apps ==============

    /**
     * @notice Send a cross-chain transfer of ERC20 token either via liquidity pool-based bridge or in the form of pegged mint / burn.
     * @param _receiver The address of the receiver.
     * @param _token The address of the token.
     * @param _amount The amount of the transfer.
     * @param _dstChainId The destination chain ID.
     * @param _nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
     * @param _maxSlippage The max slippage accepted, given as percentage in point (pip). Eg. 5000 means 0.5%.
     *        Must be greater than minimalMaxSlippage. Receiver is guaranteed to receive at least
     *        (100% - max slippage percentage) * amount or the transfer can be refunded.
     *        Only applicable to the {BridgeSendType.Liquidity}.
     * @param _bridgeSendType The type of the bridge used by this transfer. One of the {BridgeSendType} enum.
     * @param _bridgeAddr The address of the bridge used.
     */
    function sendTransfer(
        address _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage, // slippage * 1M, eg. 0.5% -> 5000
        BridgeSendType _bridgeSendType,
        address _bridgeAddr
    ) internal returns (bytes32) {
        bytes32 transferId;
        IERC20(_token).safeIncreaseAllowance(_bridgeAddr, _amount);
        if (_bridgeSendType == BridgeSendType.Liquidity) {
            IBridge(_bridgeAddr).send(_receiver, _token, _amount, _dstChainId, _nonce, _maxSlippage);
            transferId = keccak256(
                abi.encodePacked(address(this), _receiver, _token, _amount, _dstChainId, _nonce, uint64(block.chainid))
            );
        } else if (_bridgeSendType == BridgeSendType.PegDeposit) {
            IOriginalTokenVault(_bridgeAddr).deposit(_token, _amount, _dstChainId, _receiver, _nonce);
            transferId = keccak256(
                abi.encodePacked(address(this), _token, _amount, _dstChainId, _receiver, _nonce, uint64(block.chainid))
            );
        } else if (_bridgeSendType == BridgeSendType.PegBurn) {
            IPeggedTokenBridge(_bridgeAddr).burn(_token, _amount, _receiver, _nonce);
            transferId = keccak256(
                abi.encodePacked(address(this), _token, _amount, _receiver, _nonce, uint64(block.chainid))
            );
            // handle cases where certain tokens do not spend allowance for role-based burn
            IERC20(_token).safeApprove(_bridgeAddr, 0);
        } else if (_bridgeSendType == BridgeSendType.PegV2Deposit) {
            transferId = IOriginalTokenVaultV2(_bridgeAddr).deposit(_token, _amount, _dstChainId, _receiver, _nonce);
        } else if (_bridgeSendType == BridgeSendType.PegV2Burn) {
            transferId = IPeggedTokenBridgeV2(_bridgeAddr).burn(_token, _amount, _dstChainId, _receiver, _nonce);
            // handle cases where certain tokens do not spend allowance for role-based burn
            IERC20(_token).safeApprove(_bridgeAddr, 0);
        } else if (_bridgeSendType == BridgeSendType.PegV2BurnFrom) {
            transferId = IPeggedTokenBridgeV2(_bridgeAddr).burnFrom(_token, _amount, _dstChainId, _receiver, _nonce);
            // handle cases where certain tokens do not spend allowance for role-based burn
            IERC20(_token).safeApprove(_bridgeAddr, 0);
        } else {
            revert("bridge send type not supported");
        }
        return transferId;
    }

    /**
     * @notice Send a cross-chain transfer of native token either via liquidity pool-based bridge or in the form of pegged mint / burn.
     * @param _receiver The address of the receiver.
     * @param _amount The amount of the transfer.
     * @param _dstChainId The destination chain ID.
     * @param _nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
     * @param _maxSlippage The max slippage accepted, given as percentage in point (pip). Eg. 5000 means 0.5%.
     *        Must be greater than minimalMaxSlippage. Receiver is guaranteed to receive at least
     *        (100% - max slippage percentage) * amount or the transfer can be refunded.
     *        Only applicable to the {BridgeSendType.Liquidity}.
     * @param _bridgeSendType The type of the bridge used by this transfer. One of the {BridgeSendType} enum.
     * @param _bridgeAddr The address of the bridge used.
     */
    function sendNativeTransfer(
        address _receiver,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage, // slippage * 1M, eg. 0.5% -> 5000
        BridgeSendType _bridgeSendType,
        address _bridgeAddr
    ) internal returns (bytes32) {
        require(_bridgeSendType == BridgeSendType.Liquidity || _bridgeSendType == BridgeSendType.PegDeposit || _bridgeSendType == BridgeSendType.PegV2Deposit, "Lib: invalid bridge send type");
        address _token = INativeWrap(_bridgeAddr).nativeWrap();
        bytes32 transferId;
        if (_bridgeSendType == BridgeSendType.Liquidity) {
            IBridge(_bridgeAddr).sendNative{value: msg.value}(_receiver, _amount, _dstChainId, _nonce, _maxSlippage);
            transferId = keccak256(
                abi.encodePacked(address(this), _receiver, _token, _amount, _dstChainId, _nonce, uint64(block.chainid))
            );
        } else if (_bridgeSendType == BridgeSendType.PegDeposit) {
            IOriginalTokenVault(_bridgeAddr).depositNative{value: msg.value}(_amount, _dstChainId, _receiver, _nonce);
            transferId = keccak256(
                abi.encodePacked(address(this), _token, _amount, _dstChainId, _receiver, _nonce, uint64(block.chainid))
            );
        } else {
            // _bridgeSendType == BridgeSendType.PegV2Deposit
            transferId = IOriginalTokenVaultV2(_bridgeAddr).depositNative{value: msg.value}(_amount, _dstChainId, _receiver, _nonce);
        }
        return transferId;
    }

    /**
     * @notice Receive a cross-chain transfer.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeReceiveType The type of the received transfer. One of the {BridgeReceiveType} enum.
     * @param _bridgeAddr The address of the bridge used.
     */
    function receiveTransfer(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        BridgeReceiveType _bridgeReceiveType,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        if (_bridgeReceiveType == BridgeReceiveType.LqRelay) {
            return receiveLiquidityRelay(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else if (_bridgeReceiveType == BridgeReceiveType.LqWithdraw) {
            return receiveLiquidityWithdraw(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else if (_bridgeReceiveType == BridgeReceiveType.PegWithdraw) {
            return receivePegWithdraw(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else if (_bridgeReceiveType == BridgeReceiveType.PegMint) {
            return receivePegMint(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else if (_bridgeReceiveType == BridgeReceiveType.PegV2Withdraw) {
            return receivePegV2Withdraw(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else if (_bridgeReceiveType == BridgeReceiveType.PegV2Mint) {
            return receivePegV2Mint(_request, _sigs, _signers, _powers, _bridgeAddr);
        } else {
            revert("bridge receive type not supported");
        }
    }

    /**
     * @notice Receive a liquidity bridge relay.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of liquidity bridge.
     */
    function receiveLiquidityRelay(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbBridge.Relay memory request = PbBridge.decRelay(_request);
        recv.transferId = keccak256(
            abi.encodePacked(
                request.sender,
                request.receiver,
                request.token,
                request.amount,
                request.srcChainId,
                uint64(block.chainid),
                request.srcTransferId
            )
        );
        recv.refid = request.srcTransferId;
        recv.receiver = request.receiver;
        recv.token = request.token;
        recv.amount = request.amount;
        if (!IBridge(_bridgeAddr).transfers(recv.transferId)) {
            IBridge(_bridgeAddr).relay(_request, _sigs, _signers, _powers);
        }
        return recv;
    }

    /**
     * @notice Receive a liquidity bridge withdrawal.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of liquidity bridge.
     */
    function receiveLiquidityWithdraw(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbPool.WithdrawMsg memory request = PbPool.decWithdrawMsg(_request);
        recv.transferId = keccak256(
            abi.encodePacked(request.chainid, request.seqnum, request.receiver, request.token, request.amount)
        );
        recv.refid = request.refid;
        recv.receiver = request.receiver;
        if (INativeWrap(_bridgeAddr).nativeWrap() == request.token) {
            recv.token = address(0);
        } else {
            recv.token = request.token;
        }
        recv.amount = request.amount;
        if (!IBridge(_bridgeAddr).withdraws(recv.transferId)) {
            IBridge(_bridgeAddr).withdraw(_request, _sigs, _signers, _powers);
        }
        return recv;
    }

    /**
     * @notice Receive an OriginalTokenVault withdrawal.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of OriginalTokenVault.
     */
    function receivePegWithdraw(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbPegged.Withdraw memory request = PbPegged.decWithdraw(_request);
        recv.transferId = keccak256(
            abi.encodePacked(
                request.receiver,
                request.token,
                request.amount,
                request.burnAccount,
                request.refChainId,
                request.refId
            )
        );
        recv.refid = request.refId;
        recv.receiver = request.receiver;
        if (INativeWrap(_bridgeAddr).nativeWrap() == request.token) {
            recv.token = address(0);
        } else {
            recv.token = request.token;
        }
        recv.amount = request.amount;
        if (!IOriginalTokenVault(_bridgeAddr).records(recv.transferId)) {
            IOriginalTokenVault(_bridgeAddr).withdraw(_request, _sigs, _signers, _powers);
        }
        return recv;
    }

    /**
     * @notice Receive a PeggedTokenBridge mint.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of PeggedTokenBridge.
     */
    function receivePegMint(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbPegged.Mint memory request = PbPegged.decMint(_request);
        recv.transferId = keccak256(
            abi.encodePacked(
                request.account,
                request.token,
                request.amount,
                request.depositor,
                request.refChainId,
                request.refId
            )
        );
        recv.refid = request.refId;
        recv.receiver = request.account;
        recv.token = request.token;
        recv.amount = request.amount;
        if (!IPeggedTokenBridge(_bridgeAddr).records(recv.transferId)) {
            IPeggedTokenBridge(_bridgeAddr).mint(_request, _sigs, _signers, _powers);
        }
        return recv;
    }

    /**
     * @notice Receive an OriginalTokenVaultV2 withdrawal.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order. A request must be signed-off by
     * +2/3 of the bridge's current signing power to be delivered.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of OriginalTokenVaultV2.
     */
    function receivePegV2Withdraw(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbPegged.Withdraw memory request = PbPegged.decWithdraw(_request);
        if (IOriginalTokenVaultV2(_bridgeAddr).records(request.refId)) {
            recv.transferId = keccak256(
                abi.encodePacked(
                    request.receiver,
                    request.token,
                    request.amount,
                    request.burnAccount,
                    request.refChainId,
                    request.refId,
                    _bridgeAddr
                )
            );
        } else {
            recv.transferId = IOriginalTokenVaultV2(_bridgeAddr).withdraw(_request, _sigs, _signers, _powers);
        }
        recv.refid = request.refId;
        recv.receiver = request.receiver;
        if (INativeWrap(_bridgeAddr).nativeWrap() == request.token) {
            recv.token = address(0);
        } else {
            recv.token = request.token;
        }
        recv.amount = request.amount;
        return recv;
    }

    /**
     * @notice Receive a PeggedTokenBridgeV2 mint.
     * @param _request The serialized request protobuf.
     * @param _sigs The list of signatures sorted by signing addresses in ascending order. A request must be signed-off by
     * +2/3 of the bridge's current signing power to be delivered.
     * @param _signers The sorted list of signers.
     * @param _powers The signing powers of the signers.
     * @param _bridgeAddr The address of PeggedTokenBridgeV2.
     */
    function receivePegV2Mint(
        bytes calldata _request,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers,
        address _bridgeAddr
    ) internal returns (ReceiveInfo memory) {
        ReceiveInfo memory recv;
        PbPegged.Mint memory request = PbPegged.decMint(_request);
        if (IPeggedTokenBridgeV2(_bridgeAddr).records(request.refId)) {
            recv.transferId = keccak256(
                abi.encodePacked(
                    request.account,
                    request.token,
                    request.amount,
                    request.depositor,
                    request.refChainId,
                    request.refId,
                    _bridgeAddr
                )
            );
        } else {
            recv.transferId = IPeggedTokenBridgeV2(_bridgeAddr).mint(_request, _sigs, _signers, _powers);
        }
        recv.refid = request.refId;
        recv.receiver = request.account;
        recv.token = request.token;
        recv.amount = request.amount;
        return recv;
    }

    function bridgeRefundType(BridgeSendType _bridgeSendType) internal pure returns (BridgeReceiveType) {
        if (_bridgeSendType == BridgeSendType.Liquidity) {
            return BridgeReceiveType.LqWithdraw;
        }
        if (_bridgeSendType == BridgeSendType.PegDeposit) {
            return BridgeReceiveType.PegWithdraw;
        }
        if (_bridgeSendType == BridgeSendType.PegBurn) {
            return BridgeReceiveType.PegMint;
        }
        if (_bridgeSendType == BridgeSendType.PegV2Deposit) {
            return BridgeReceiveType.PegV2Withdraw;
        }
        if (_bridgeSendType == BridgeSendType.PegV2Burn || _bridgeSendType == BridgeSendType.PegV2BurnFrom) {
            return BridgeReceiveType.PegV2Mint;
        }
        return BridgeReceiveType.Null;
    }
}
