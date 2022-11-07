// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./OwnerProxyBase.sol";
import "../interfaces/IBridgeOwner.sol";
import {SimpleGovernance as sg} from "../SimpleGovernance.sol";
import {OwnerDataTypes as dt} from "./OwnerDataTypes.sol";

abstract contract BridgeOwnerProxy is OwnerProxyBase {
    // for bridges
    event ResetSignersProposalCreated(uint256 proposalId, address target, address[] signers, uint256[] powers);
    event NotifyResetSignersProposalCreated(uint256 proposalId, address target);
    event IncreaseNoticePeriodProposalCreated(uint256 proposalId, address target, uint256 period);
    event SetNativeWrapProposalCreated(uint256 proposalId, address target, address token);
    event UpdateSupplyProposalCreated(
        uint256 proposalId,
        address target,
        dt.Action action,
        address token,
        uint256 supply
    );
    event UpdateGovernorProposalCreated(uint256 proposalId, address target, dt.Action action, address account);

    // for bridge tokens
    event UpdateBridgeProposalCreated(uint256 proposalId, address target, address bridgeAddr);
    event UpdateBridgeSupplyCapProposalCreated(uint256 proposalId, address target, address bridge, uint256 cap);
    event SetBridgeTokenSwapCapProposalCreated(uint256 proposalId, address target, address bridgeToken, uint256 cap);

    function proposeResetSigners(
        address _target,
        address[] calldata _signers,
        uint256[] calldata _powers
    ) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.resetSigners.selector, _signers, _powers);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit ResetSignersProposalCreated(proposalId, _target, _signers, _powers);
    }

    function proposeNotifyResetSigners(address _target) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.notifyResetSigners.selector);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit NotifyResetSignersProposalCreated(proposalId, _target);
    }

    function proposeIncreaseNoticePeriod(address _target, uint256 _period) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.increaseNoticePeriod.selector, _period);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit IncreaseNoticePeriodProposalCreated(proposalId, _target, _period);
    }

    function proposeSetNativeWrap(address _target, address _token) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.setWrap.selector, _token);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetNativeWrapProposalCreated(proposalId, _target, _token);
    }

    function proposeUpdateSupply(
        address _target,
        dt.Action _action,
        address _token,
        uint256 _supply
    ) external {
        bytes4 selector;
        if (_action == dt.Action.Set) {
            selector = IBridgeOwner.setSupply.selector;
        } else if (_action == dt.Action.Add) {
            selector = IBridgeOwner.increaseSupply.selector;
        } else if (_action == dt.Action.Remove) {
            selector = IBridgeOwner.decreaseSupply.selector;
        } else {
            revert("invalid action");
        }
        bytes memory data = abi.encodeWithSelector(selector, _token, _supply);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit UpdateSupplyProposalCreated(proposalId, _target, _action, _token, _supply);
    }

    function proposeUpdateGovernor(
        address _target,
        dt.Action _action,
        address _account
    ) external {
        bytes4 selector;
        if (_action == dt.Action.Add) {
            selector = IBridgeOwner.addGovernor.selector;
        } else if (_action == dt.Action.Remove) {
            selector = IBridgeOwner.removeGovernor.selector;
        } else {
            revert("invalid action");
        }
        bytes memory data = abi.encodeWithSelector(selector, _account);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit UpdateGovernorProposalCreated(proposalId, _target, _action, _account);
    }

    function proposeUpdateBridgeSupplyCap(
        address _target,
        address _bridge,
        uint256 _cap
    ) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.updateBridgeSupplyCap.selector, _bridge, _cap);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit UpdateBridgeSupplyCapProposalCreated(proposalId, _target, _bridge, _cap);
    }

    function proposeSetBridgeTokenSwapCap(
        address _target,
        address _bridgeToken,
        uint256 _swapCap
    ) external {
        bytes memory data = abi.encodeWithSelector(IBridgeOwner.setBridgeTokenSwapCap.selector, _bridgeToken, _swapCap);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetBridgeTokenSwapCapProposalCreated(proposalId, _target, _bridgeToken, _swapCap);
    }
}
