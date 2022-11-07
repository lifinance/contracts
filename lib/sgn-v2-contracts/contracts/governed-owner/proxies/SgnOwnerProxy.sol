// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./OwnerProxyBase.sol";
import "../interfaces/ISgnOwner.sol";
import {SimpleGovernance as sg} from "../SimpleGovernance.sol";
import {OwnerDataTypes as dt} from "./OwnerDataTypes.sol";

abstract contract SgnOwnerProxy is OwnerProxyBase {
    event SetWhitelistEnableProposalCreated(uint256 proposalId, address target, bool enabled);
    event UpdateWhitelistedProposalCreated(uint256 proposalId, address target, dt.Action action, address account);
    event SetGovContractProposalCreated(uint256 proposalId, address target, address addr);
    event SetRewardContractProposalCreated(uint256 proposalId, address target, address addr);
    event SetMaxSlashFactorProposalCreated(uint256 proposalId, address target, uint256 maxSlashFactor);
    event DrainTokenProposalCreated(uint256 proposalId, address target, address token, uint256 amount);

    function proposeSetWhitelistEnable(address _target, bool _enable) external {
        bytes memory data = abi.encodeWithSelector(ISgnOwner.setWhitelistEnabled.selector, _enable);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetWhitelistEnableProposalCreated(proposalId, _target, _enable);
    }

    function proposeUpdateWhitelisted(
        address _target,
        dt.Action _action,
        address _account
    ) external {
        bytes4 selector;
        if (_action == dt.Action.Add) {
            selector = ISgnOwner.addWhitelisted.selector;
        } else if (_action == dt.Action.Remove) {
            selector = ISgnOwner.removeWhitelisted.selector;
        } else {
            revert("invalid action");
        }
        bytes memory data = abi.encodeWithSelector(selector, _account);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit UpdateWhitelistedProposalCreated(proposalId, _target, _action, _account);
    }

    function proposeSetGovContract(address _target, address _addr) external {
        bytes memory data = abi.encodeWithSelector(ISgnOwner.setGovContract.selector, _addr);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetGovContractProposalCreated(proposalId, _target, _addr);
    }

    function proposeSetRewardContract(address _target, address _addr) external {
        bytes memory data = abi.encodeWithSelector(ISgnOwner.setRewardContract.selector, _addr);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetRewardContractProposalCreated(proposalId, _target, _addr);
    }

    function proposeSetMaxSlashFactor(address _target, uint256 _maxSlashFactor) external {
        bytes memory data = abi.encodeWithSelector(ISgnOwner.setMaxSlashFactor.selector, _maxSlashFactor);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit SetMaxSlashFactorProposalCreated(proposalId, _target, _maxSlashFactor);
    }

    function proposeDrainToken(
        address _target,
        address _token,
        uint256 _amount
    ) external {
        bytes memory data;
        if (_token == address(0)) {
            data = abi.encodeWithSelector(bytes4(keccak256(bytes("drainToken(uint256"))), _amount);
        } else {
            data = abi.encodeWithSelector(bytes4(keccak256(bytes("drainToken(address,uint256"))), _token, _amount);
        }
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit DrainTokenProposalCreated(proposalId, _target, _token, _amount);
    }
}
