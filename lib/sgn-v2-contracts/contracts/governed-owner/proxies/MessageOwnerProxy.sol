// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./OwnerProxyBase.sol";
import "../interfaces/IMessageOwner.sol";
import {SimpleGovernance as sg} from "../SimpleGovernance.sol";
import {OwnerDataTypes as dt} from "./OwnerDataTypes.sol";

abstract contract MessageOwnerProxy is OwnerProxyBase {
    event SetMsgFeeProposalCreated(uint256 proposalId, address target, dt.MsgFeeType feeType, uint256 fee);
    event SetBridgeAddressProposalCreated(
        uint256 proposalId,
        address target,
        dt.BridgeType bridgeType,
        address bridgeAddr
    );
    event SetPreExecuteMessageGasUsageProposalCreated(uint256 proposalId, address target, uint256 usage);

    function proposeSetMsgFee(
        address _target,
        dt.MsgFeeType _feeType,
        uint256 _fee
    ) external {
        bytes4 selector;
        if (_feeType == dt.MsgFeeType.PerByte) {
            selector = IMessageOwner.setFeePerByte.selector;
        } else if (_feeType == dt.MsgFeeType.Base) {
            selector = IMessageOwner.setFeeBase.selector;
        } else {
            revert("invalid fee type");
        }
        bytes memory data = abi.encodeWithSelector(selector, _fee);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit SetMsgFeeProposalCreated(proposalId, _target, _feeType, _fee);
    }

    function proposeSetBridgeAddress(
        address _target,
        dt.BridgeType _bridgeType,
        address _bridgeAddr
    ) external {
        bytes4 selector;
        if (_bridgeType == dt.BridgeType.Liquidity) {
            selector = IMessageOwner.setLiquidityBridge.selector;
        } else if (_bridgeType == dt.BridgeType.PegBridge) {
            selector = IMessageOwner.setPegBridge.selector;
        } else if (_bridgeType == dt.BridgeType.PegVault) {
            selector = IMessageOwner.setPegVault.selector;
        } else if (_bridgeType == dt.BridgeType.PegBridgeV2) {
            selector = IMessageOwner.setPegBridgeV2.selector;
        } else if (_bridgeType == dt.BridgeType.PegVaultV2) {
            selector = IMessageOwner.setPegVaultV2.selector;
        } else {
            revert("invalid bridge type");
        }
        bytes memory data = abi.encodeWithSelector(selector, _bridgeAddr);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetBridgeAddressProposalCreated(proposalId, _target, _bridgeType, _bridgeAddr);
    }

    function proposeSetPreExecuteMessageGasUsage(address _target, uint256 _usage) external {
        bytes memory data = abi.encodeWithSelector(IMessageOwner.setPreExecuteMessageGasUsage.selector, _usage);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetPreExecuteMessageGasUsageProposalCreated(proposalId, _target, _usage);
    }
}
