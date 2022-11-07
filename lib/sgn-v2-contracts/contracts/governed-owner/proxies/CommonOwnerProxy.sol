// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./OwnerProxyBase.sol";
import "../interfaces/ICommonOwner.sol";
import {SimpleGovernance as sg} from "../SimpleGovernance.sol";
import {OwnerDataTypes as dt} from "./OwnerDataTypes.sol";

abstract contract CommonOwnerProxy is OwnerProxyBase {
    event TransferOwnershipProposalCreated(uint256 proposalId, address target, uint256 newOwner);
    event UpdatePauserProposalCreated(uint256 proposalId, address target, dt.Action action, address account);

    function proposeTransferOwnership(address _target, uint256 _newOwner) external {
        bytes memory data = abi.encodeWithSelector(ICommonOwner.transferOwnership.selector, _newOwner);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit TransferOwnershipProposalCreated(proposalId, _target, _newOwner);
    }

    function proposeUpdatePauser(
        address _target,
        dt.Action _action,
        address _account
    ) external {
        bytes4 selector;
        if (_action == dt.Action.Add) {
            selector = ICommonOwner.addPauser.selector;
        } else if (_action == dt.Action.Remove) {
            selector = ICommonOwner.removePauser.selector;
        } else {
            revert("invalid action");
        }
        bytes memory data = abi.encodeWithSelector(selector, _account);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalFastPass);
        emit UpdatePauserProposalCreated(proposalId, _target, _action, _account);
    }
}
