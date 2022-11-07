// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.9;

import "./OwnerProxyBase.sol";
import "../interfaces/IUpgradeableOwner.sol";
import {SimpleGovernance as sg} from "../SimpleGovernance.sol";
import {OwnerDataTypes as dt} from "./OwnerDataTypes.sol";

abstract contract UpgradeableOwnerProxy is OwnerProxyBase {
    event ChangeProxyAdminProposalCreated(uint256 proposalId, address target, address proxy, address newAdmin);
    event UpgradeProposalCreated(uint256 proposalId, address target, address proxy, address implementation);
    event UpgradeAndCallProposalCreated(
        uint256 proposalId,
        address target,
        address proxy,
        address implementation,
        bytes data
    );
    event UpgradeToProposalCreated(uint256 proposalId, address target, address implementation);
    event UpgradeToAndCallProposalCreated(uint256 proposalId, address target, address implementation, bytes data);

    function proposeChangeProxyAdmin(
        address _target,
        address _proxy,
        address _newAdmin
    ) external {
        bytes memory data = abi.encodeWithSelector(IUpgradeableOwner.changeProxyAdmin.selector, _proxy, _newAdmin);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit ChangeProxyAdminProposalCreated(proposalId, _target, _proxy, _newAdmin);
    }

    function proposeUpgrade(
        address _target,
        address _proxy,
        address _implementation
    ) external {
        bytes memory data = abi.encodeWithSelector(IUpgradeableOwner.upgrade.selector, _proxy, _implementation);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit UpgradeProposalCreated(proposalId, _target, _proxy, _implementation);
    }

    function proposeUpgradeAndCall(
        address _target,
        address _proxy,
        address _implementation,
        bytes calldata _data
    ) external {
        bytes memory data = abi.encodeWithSelector(
            IUpgradeableOwner.upgradeAndCall.selector,
            _proxy,
            _implementation,
            _data
        );
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit UpgradeAndCallProposalCreated(proposalId, _target, _proxy, _implementation, _data);
    }

    function proposeUpgradeTo(address _target, address _implementation) external {
        bytes memory data = abi.encodeWithSelector(IUpgradeableOwner.upgradeTo.selector, _implementation);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit UpgradeToProposalCreated(proposalId, _target, _implementation);
    }

    function proposeUpgradeToAndCall(
        address _target,
        address _implementation,
        bytes calldata _data
    ) external {
        bytes memory data = abi.encodeWithSelector(IUpgradeableOwner.upgradeToAndCall.selector, _implementation, _data);
        uint256 proposalId = gov.createProposal(msg.sender, _target, data, sg.ProposalType.ExternalDefault);
        emit UpgradeToAndCallProposalCreated(proposalId, _target, _implementation, _data);
    }
}
