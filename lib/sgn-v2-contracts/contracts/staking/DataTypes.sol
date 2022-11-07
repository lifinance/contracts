// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

library DataTypes {
    uint256 constant CELR_DECIMAL = 1e18;
    uint256 constant MAX_INT = 2**256 - 1;
    uint256 constant COMMISSION_RATE_BASE = 10000; // 1 commissionRate means 0.01%
    uint256 constant MAX_UNDELEGATION_ENTRIES = 10;
    uint256 constant SLASH_FACTOR_DECIMAL = 1e6;

    enum ValidatorStatus {
        Null,
        Unbonded,
        Unbonding,
        Bonded
    }

    enum ParamName {
        ProposalDeposit,
        VotingPeriod,
        UnbondingPeriod,
        MaxBondedValidators,
        MinValidatorTokens,
        MinSelfDelegation,
        AdvanceNoticePeriod,
        ValidatorBondInterval,
        MaxSlashFactor
    }

    struct Undelegation {
        uint256 shares;
        uint256 creationBlock;
    }

    struct Undelegations {
        mapping(uint256 => Undelegation) queue;
        uint32 head;
        uint32 tail;
    }

    struct Delegator {
        uint256 shares;
        Undelegations undelegations;
    }

    struct Validator {
        ValidatorStatus status;
        address signer;
        uint256 tokens; // sum of all tokens delegated to this validator
        uint256 shares; // sum of all delegation shares
        uint256 undelegationTokens; // tokens being undelegated
        uint256 undelegationShares; // shares of tokens being undelegated
        mapping(address => Delegator) delegators;
        uint256 minSelfDelegation;
        uint64 bondBlock; // cannot become bonded before this block
        uint64 unbondBlock; // cannot become unbonded before this block
        uint64 commissionRate; // equal to real commission rate * COMMISSION_RATE_BASE
    }

    // used for external view output
    struct ValidatorTokens {
        address valAddr;
        uint256 tokens;
    }

    // used for external view output
    struct ValidatorInfo {
        address valAddr;
        ValidatorStatus status;
        address signer;
        uint256 tokens;
        uint256 shares;
        uint256 minSelfDelegation;
        uint64 commissionRate;
    }

    // used for external view output
    struct DelegatorInfo {
        address valAddr;
        uint256 tokens;
        uint256 shares;
        Undelegation[] undelegations;
        uint256 undelegationTokens;
        uint256 withdrawableUndelegationTokens;
    }
}
