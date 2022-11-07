// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DataTypes as dt} from "./DataTypes.sol";
import "./Staking.sol";

/**
 * @title Governance module for Staking contract
 */
contract Govern {
    using SafeERC20 for IERC20;

    Staking public immutable staking;
    IERC20 public immutable celerToken;

    enum ProposalStatus {
        Uninitiated,
        Voting,
        Closed
    }

    enum VoteOption {
        Null,
        Yes,
        Abstain,
        No
    }

    struct ParamProposal {
        address proposer;
        uint256 deposit;
        uint256 voteDeadline;
        dt.ParamName name;
        uint256 newValue;
        ProposalStatus status;
        mapping(address => VoteOption) votes;
    }

    mapping(uint256 => ParamProposal) public paramProposals;
    uint256 public nextParamProposalId;

    uint256 public forfeiture;
    address public immutable collector;

    event CreateParamProposal(
        uint256 proposalId,
        address proposer,
        uint256 deposit,
        uint256 voteDeadline,
        dt.ParamName name,
        uint256 newValue
    );
    event VoteParam(uint256 proposalId, address voter, VoteOption vote);
    event ConfirmParamProposal(uint256 proposalId, bool passed, dt.ParamName name, uint256 newValue);

    constructor(
        Staking _staking,
        address _celerTokenAddress,
        address _collector
    ) {
        staking = _staking;
        celerToken = IERC20(_celerTokenAddress);
        collector = _collector;
    }

    /**
     * @notice Get the vote type of a voter on a parameter proposal
     * @param _proposalId the proposal id
     * @param _voter the voter address
     * @return the vote type of the given voter on the given parameter proposal
     */
    function getParamProposalVote(uint256 _proposalId, address _voter) public view returns (VoteOption) {
        return paramProposals[_proposalId].votes[_voter];
    }

    /**
     * @notice Create a parameter proposal
     * @param _name the key of this parameter
     * @param _value the new proposed value of this parameter
     */
    function createParamProposal(dt.ParamName _name, uint256 _value) external {
        ParamProposal storage p = paramProposals[nextParamProposalId];
        nextParamProposalId = nextParamProposalId + 1;
        address msgSender = msg.sender;
        uint256 deposit = staking.getParamValue(dt.ParamName.ProposalDeposit);

        p.proposer = msgSender;
        p.deposit = deposit;
        p.voteDeadline = block.number + staking.getParamValue(dt.ParamName.VotingPeriod);
        p.name = _name;
        p.newValue = _value;
        p.status = ProposalStatus.Voting;

        celerToken.safeTransferFrom(msgSender, address(this), deposit);

        emit CreateParamProposal(nextParamProposalId - 1, msgSender, deposit, p.voteDeadline, _name, _value);
    }

    /**
     * @notice Vote for a parameter proposal with a specific type of vote
     * @param _proposalId the id of the parameter proposal
     * @param _vote the type of vote
     */
    function voteParam(uint256 _proposalId, VoteOption _vote) external {
        address valAddr = msg.sender;
        require(staking.getValidatorStatus(valAddr) == dt.ValidatorStatus.Bonded, "Voter is not a bonded validator");
        ParamProposal storage p = paramProposals[_proposalId];
        require(p.status == ProposalStatus.Voting, "Invalid proposal status");
        require(block.number < p.voteDeadline, "Vote deadline passed");
        require(p.votes[valAddr] == VoteOption.Null, "Voter has voted");
        require(_vote != VoteOption.Null, "Invalid vote");

        p.votes[valAddr] = _vote;

        emit VoteParam(_proposalId, valAddr, _vote);
    }

    /**
     * @notice Confirm a parameter proposal
     * @param _proposalId the id of the parameter proposal
     */
    function confirmParamProposal(uint256 _proposalId) external {
        uint256 yesVotes;
        uint256 bondedTokens;
        dt.ValidatorTokens[] memory validators = staking.getBondedValidatorsTokens();
        for (uint32 i = 0; i < validators.length; i++) {
            if (getParamProposalVote(_proposalId, validators[i].valAddr) == VoteOption.Yes) {
                yesVotes += validators[i].tokens;
            }
            bondedTokens += validators[i].tokens;
        }
        bool passed = (yesVotes >= (bondedTokens * 2) / 3 + 1);

        ParamProposal storage p = paramProposals[_proposalId];
        require(p.status == ProposalStatus.Voting, "Invalid proposal status");
        require(block.number >= p.voteDeadline, "Vote deadline not reached");

        p.status = ProposalStatus.Closed;
        if (passed) {
            staking.setParamValue(p.name, p.newValue);
            celerToken.safeTransfer(p.proposer, p.deposit);
        } else {
            forfeiture += p.deposit;
        }

        emit ConfirmParamProposal(_proposalId, passed, p.name, p.newValue);
    }

    function collectForfeiture() external {
        require(forfeiture > 0, "Nothing to collect");
        celerToken.safeTransfer(collector, forfeiture);
        forfeiture = 0;
    }
}
