// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {DataTypes as dt} from "./DataTypes.sol";
import "../interfaces/ISigsVerifier.sol";
import "../libraries/PbStaking.sol";
import "../safeguard/Pauser.sol";
import "../safeguard/Whitelist.sol";

/**
 * @title A Staking contract shared by all external sidechains and apps
 */
contract Staking is ISigsVerifier, Pauser, Whitelist {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    IERC20 public immutable CELER_TOKEN;

    uint256 public bondedTokens;
    uint256 public nextBondBlock;
    address[] public valAddrs;
    address[] public bondedValAddrs;
    mapping(address => dt.Validator) public validators; // key is valAddr
    mapping(address => address) public signerVals; // signerAddr -> valAddr
    mapping(uint256 => bool) public slashNonces;

    mapping(dt.ParamName => uint256) public params;
    address public govContract;
    address public rewardContract;
    uint256 public forfeiture;

    /* Events */
    event ValidatorNotice(address indexed valAddr, string key, bytes data, address from);
    event ValidatorStatusUpdate(address indexed valAddr, dt.ValidatorStatus indexed status);
    event DelegationUpdate(
        address indexed valAddr,
        address indexed delAddr,
        uint256 valTokens,
        uint256 delShares,
        int256 tokenDiff
    );
    event Undelegated(address indexed valAddr, address indexed delAddr, uint256 amount);
    event Slash(address indexed valAddr, uint64 nonce, uint256 slashAmt);
    event SlashAmtCollected(address indexed recipient, uint256 amount);

    /**
     * @notice Staking constructor
     * @param _celerTokenAddress address of Celer Token Contract
     * @param _proposalDeposit required deposit amount for a governance proposal
     * @param _votingPeriod voting timeout for a governance proposal
     * @param _unbondingPeriod the locking time for funds locked before withdrawn
     * @param _maxBondedValidators the maximum number of bonded validators
     * @param _minValidatorTokens the global minimum token amount requirement for bonded validator
     * @param _minSelfDelegation minimal amount of self-delegated tokens
     * @param _advanceNoticePeriod the wait time after the announcement and prior to the effective date of an update
     * @param _validatorBondInterval min interval between bondValidator
     * @param _maxSlashFactor maximal slashing factor (1e6 = 100%)
     */
    constructor(
        address _celerTokenAddress,
        uint256 _proposalDeposit,
        uint256 _votingPeriod,
        uint256 _unbondingPeriod,
        uint256 _maxBondedValidators,
        uint256 _minValidatorTokens,
        uint256 _minSelfDelegation,
        uint256 _advanceNoticePeriod,
        uint256 _validatorBondInterval,
        uint256 _maxSlashFactor
    ) {
        CELER_TOKEN = IERC20(_celerTokenAddress);

        params[dt.ParamName.ProposalDeposit] = _proposalDeposit;
        params[dt.ParamName.VotingPeriod] = _votingPeriod;
        params[dt.ParamName.UnbondingPeriod] = _unbondingPeriod;
        params[dt.ParamName.MaxBondedValidators] = _maxBondedValidators;
        params[dt.ParamName.MinValidatorTokens] = _minValidatorTokens;
        params[dt.ParamName.MinSelfDelegation] = _minSelfDelegation;
        params[dt.ParamName.AdvanceNoticePeriod] = _advanceNoticePeriod;
        params[dt.ParamName.ValidatorBondInterval] = _validatorBondInterval;
        params[dt.ParamName.MaxSlashFactor] = _maxSlashFactor;
    }

    receive() external payable {}

    /*********************************
     * External and Public Functions *
     *********************************/

    /**
     * @notice Initialize a validator candidate
     * @param _signer signer address
     * @param _minSelfDelegation minimal amount of tokens staked by the validator itself
     * @param _commissionRate the self-declaimed commission rate
     */
    function initializeValidator(
        address _signer,
        uint256 _minSelfDelegation,
        uint64 _commissionRate
    ) external whenNotPaused onlyWhitelisted {
        address valAddr = msg.sender;
        dt.Validator storage validator = validators[valAddr];
        require(validator.status == dt.ValidatorStatus.Null, "Validator is initialized");
        require(validators[_signer].status == dt.ValidatorStatus.Null, "Signer is other validator");
        require(signerVals[valAddr] == address(0), "Validator is other signer");
        require(signerVals[_signer] == address(0), "Signer already used");
        require(_commissionRate <= dt.COMMISSION_RATE_BASE, "Invalid commission rate");
        require(_minSelfDelegation >= params[dt.ParamName.MinSelfDelegation], "Insufficient min self delegation");
        validator.signer = _signer;
        validator.status = dt.ValidatorStatus.Unbonded;
        validator.minSelfDelegation = _minSelfDelegation;
        validator.commissionRate = _commissionRate;
        valAddrs.push(valAddr);
        signerVals[_signer] = valAddr;

        delegate(valAddr, _minSelfDelegation);
        emit ValidatorNotice(valAddr, "init", abi.encode(_signer, _minSelfDelegation, _commissionRate), address(0));
    }

    /**
     * @notice Update validator signer address
     * @param _signer signer address
     */
    function updateValidatorSigner(address _signer) external {
        address valAddr = msg.sender;
        dt.Validator storage validator = validators[valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator not initialized");
        require(signerVals[_signer] == address(0), "Signer already used");
        if (_signer != valAddr) {
            require(validators[_signer].status == dt.ValidatorStatus.Null, "Signer is other validator");
        }

        delete signerVals[validator.signer];
        validator.signer = _signer;
        signerVals[_signer] = valAddr;

        emit ValidatorNotice(valAddr, "signer", abi.encode(_signer), address(0));
    }

    /**
     * @notice Candidate claims to become a bonded validator
     * @dev caller can be either validator owner or signer
     */
    function bondValidator() external {
        address valAddr = msg.sender;
        if (signerVals[msg.sender] != address(0)) {
            valAddr = signerVals[msg.sender];
        }
        dt.Validator storage validator = validators[valAddr];
        require(
            validator.status == dt.ValidatorStatus.Unbonded || validator.status == dt.ValidatorStatus.Unbonding,
            "Invalid validator status"
        );
        require(block.number >= validator.bondBlock, "Bond block not reached");
        require(block.number >= nextBondBlock, "Too frequent validator bond");
        nextBondBlock = block.number + params[dt.ParamName.ValidatorBondInterval];
        require(hasMinRequiredTokens(valAddr, true), "Not have min tokens");

        uint256 maxBondedValidators = params[dt.ParamName.MaxBondedValidators];
        // if the number of validators has not reached the max_validator_num,
        // add validator directly
        if (bondedValAddrs.length < maxBondedValidators) {
            _bondValidator(valAddr);
            _decentralizationCheck(validator.tokens);
            return;
        }
        // if the number of validators has already reached the max_validator_num,
        // add validator only if its tokens is more than the current least bonded validator tokens
        uint256 minTokens = dt.MAX_INT;
        uint256 minTokensIndex;
        for (uint256 i = 0; i < maxBondedValidators; i++) {
            if (validators[bondedValAddrs[i]].tokens < minTokens) {
                minTokensIndex = i;
                minTokens = validators[bondedValAddrs[i]].tokens;
                if (minTokens == 0) {
                    break;
                }
            }
        }
        require(validator.tokens > minTokens, "Insufficient tokens");
        _replaceBondedValidator(valAddr, minTokensIndex);
        _decentralizationCheck(validator.tokens);
    }

    /**
     * @notice Confirm validator status from Unbonding to Unbonded
     * @param _valAddr the address of the validator
     */
    function confirmUnbondedValidator(address _valAddr) external {
        dt.Validator storage validator = validators[_valAddr];
        require(validator.status == dt.ValidatorStatus.Unbonding, "Validator not unbonding");
        require(block.number >= validator.unbondBlock, "Unbond block not reached");

        validator.status = dt.ValidatorStatus.Unbonded;
        delete validator.unbondBlock;
        emit ValidatorStatusUpdate(_valAddr, dt.ValidatorStatus.Unbonded);
    }

    /**
     * @notice Delegate CELR tokens to a validator
     * @dev Minimal amount per delegate operation is 1 CELR
     * @param _valAddr validator to delegate
     * @param _tokens the amount of delegated CELR tokens
     */
    function delegate(address _valAddr, uint256 _tokens) public whenNotPaused {
        address delAddr = msg.sender;
        require(_tokens >= dt.CELR_DECIMAL, "Minimal amount is 1 CELR");

        dt.Validator storage validator = validators[_valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        uint256 shares = _tokenToShare(_tokens, validator.tokens, validator.shares);

        dt.Delegator storage delegator = validator.delegators[delAddr];
        delegator.shares += shares;
        validator.shares += shares;
        validator.tokens += _tokens;
        if (validator.status == dt.ValidatorStatus.Bonded) {
            bondedTokens += _tokens;
            _decentralizationCheck(validator.tokens);
        }
        CELER_TOKEN.safeTransferFrom(delAddr, address(this), _tokens);
        emit DelegationUpdate(_valAddr, delAddr, validator.tokens, delegator.shares, int256(_tokens));
    }

    /**
     * @notice Undelegate shares from a validator
     * @dev Tokens are delegated by the msgSender to the validator
     * @param _valAddr the address of the validator
     * @param _shares undelegate shares
     */
    function undelegateShares(address _valAddr, uint256 _shares) external {
        require(_shares >= dt.CELR_DECIMAL, "Minimal amount is 1 share");
        dt.Validator storage validator = validators[_valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        uint256 tokens = _shareToToken(_shares, validator.tokens, validator.shares);
        _undelegate(validator, _valAddr, tokens, _shares);
    }

    /**
     * @notice Undelegate shares from a validator
     * @dev Tokens are delegated by the msgSender to the validator
     * @param _valAddr the address of the validator
     * @param _tokens undelegate tokens
     */
    function undelegateTokens(address _valAddr, uint256 _tokens) external {
        require(_tokens >= dt.CELR_DECIMAL, "Minimal amount is 1 CELR");
        dt.Validator storage validator = validators[_valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        uint256 shares = _tokenToShare(_tokens, validator.tokens, validator.shares);
        _undelegate(validator, _valAddr, _tokens, shares);
    }

    /**
     * @notice Complete pending undelegations from a validator
     * @param _valAddr the address of the validator
     */
    function completeUndelegate(address _valAddr) external {
        address delAddr = msg.sender;
        dt.Validator storage validator = validators[_valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        dt.Delegator storage delegator = validator.delegators[delAddr];

        uint256 unbondingPeriod = params[dt.ParamName.UnbondingPeriod];
        bool isUnbonded = validator.status == dt.ValidatorStatus.Unbonded;
        // for all pending undelegations
        uint32 i;
        uint256 undelegationShares;
        for (i = delegator.undelegations.head; i < delegator.undelegations.tail; i++) {
            if (isUnbonded || delegator.undelegations.queue[i].creationBlock + unbondingPeriod <= block.number) {
                // complete undelegation when the validator becomes unbonded or
                // the unbondingPeriod for the pending undelegation is up.
                undelegationShares += delegator.undelegations.queue[i].shares;
                delete delegator.undelegations.queue[i];
                continue;
            }
            break;
        }
        delegator.undelegations.head = i;

        require(undelegationShares > 0, "No undelegation ready to be completed");
        uint256 tokens = _shareToToken(undelegationShares, validator.undelegationTokens, validator.undelegationShares);
        validator.undelegationShares -= undelegationShares;
        validator.undelegationTokens -= tokens;
        CELER_TOKEN.safeTransfer(delAddr, tokens);
        emit Undelegated(_valAddr, delAddr, tokens);
    }

    /**
     * @notice Update commission rate
     * @param _newRate new commission rate
     */
    function updateCommissionRate(uint64 _newRate) external {
        address valAddr = msg.sender;
        dt.Validator storage validator = validators[valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        require(_newRate <= dt.COMMISSION_RATE_BASE, "Invalid new rate");
        validator.commissionRate = _newRate;
        emit ValidatorNotice(valAddr, "commission", abi.encode(_newRate), address(0));
    }

    /**
     * @notice Update minimal self delegation value
     * @param _minSelfDelegation minimal amount of tokens staked by the validator itself
     */
    function updateMinSelfDelegation(uint256 _minSelfDelegation) external {
        address valAddr = msg.sender;
        dt.Validator storage validator = validators[valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        require(_minSelfDelegation >= params[dt.ParamName.MinSelfDelegation], "Insufficient min self delegation");
        if (_minSelfDelegation < validator.minSelfDelegation) {
            require(validator.status != dt.ValidatorStatus.Bonded, "Validator is bonded");
            validator.bondBlock = uint64(block.number + params[dt.ParamName.AdvanceNoticePeriod]);
        }
        validator.minSelfDelegation = _minSelfDelegation;
        emit ValidatorNotice(valAddr, "min-self-delegation", abi.encode(_minSelfDelegation), address(0));
    }

    /**
     * @notice Slash a validator and its delegators
     * @param _slashRequest slash request bytes coded in protobuf
     * @param _sigs list of validator signatures
     */
    function slash(bytes calldata _slashRequest, bytes[] calldata _sigs) external whenNotPaused {
        bytes32 domain = keccak256(abi.encodePacked(block.chainid, address(this), "Slash"));
        verifySignatures(abi.encodePacked(domain, _slashRequest), _sigs);

        PbStaking.Slash memory request = PbStaking.decSlash(_slashRequest);
        require(block.timestamp < request.expireTime, "Slash expired");
        require(request.slashFactor <= dt.SLASH_FACTOR_DECIMAL, "Invalid slash factor");
        require(request.slashFactor <= params[dt.ParamName.MaxSlashFactor], "Exceed max slash factor");
        require(!slashNonces[request.nonce], "Used slash nonce");
        slashNonces[request.nonce] = true;

        address valAddr = request.validator;
        dt.Validator storage validator = validators[valAddr];
        require(
            validator.status == dt.ValidatorStatus.Bonded || validator.status == dt.ValidatorStatus.Unbonding,
            "Invalid validator status"
        );

        // slash delegated tokens
        uint256 slashAmt = (validator.tokens * request.slashFactor) / dt.SLASH_FACTOR_DECIMAL;
        validator.tokens -= slashAmt;
        if (validator.status == dt.ValidatorStatus.Bonded) {
            bondedTokens -= slashAmt;
            if (request.jailPeriod > 0 || !hasMinRequiredTokens(valAddr, true)) {
                _unbondValidator(valAddr);
            }
        }
        if (validator.status == dt.ValidatorStatus.Unbonding && request.jailPeriod > 0) {
            validator.bondBlock = uint64(block.number + request.jailPeriod);
        }
        emit DelegationUpdate(valAddr, address(0), validator.tokens, 0, -int256(slashAmt));

        // slash pending undelegations
        uint256 slashUndelegation = (validator.undelegationTokens * request.slashFactor) / dt.SLASH_FACTOR_DECIMAL;
        validator.undelegationTokens -= slashUndelegation;
        slashAmt += slashUndelegation;

        uint256 collectAmt;
        for (uint256 i = 0; i < request.collectors.length; i++) {
            PbStaking.AcctAmtPair memory collector = request.collectors[i];
            if (collectAmt + collector.amount > slashAmt) {
                collector.amount = slashAmt - collectAmt;
            }
            if (collector.amount > 0) {
                collectAmt += collector.amount;
                if (collector.account == address(0)) {
                    CELER_TOKEN.safeTransfer(msg.sender, collector.amount);
                    emit SlashAmtCollected(msg.sender, collector.amount);
                } else {
                    CELER_TOKEN.safeTransfer(collector.account, collector.amount);
                    emit SlashAmtCollected(collector.account, collector.amount);
                }
            }
        }
        forfeiture += slashAmt - collectAmt;
        emit Slash(valAddr, request.nonce, slashAmt);
    }

    function collectForfeiture() external {
        require(forfeiture > 0, "Nothing to collect");
        CELER_TOKEN.safeTransfer(rewardContract, forfeiture);
        forfeiture = 0;
    }

    /**
     * @notice Validator notice event, could be triggered by anyone
     */
    function validatorNotice(
        address _valAddr,
        string calldata _key,
        bytes calldata _data
    ) external {
        dt.Validator storage validator = validators[_valAddr];
        require(validator.status != dt.ValidatorStatus.Null, "Validator is not initialized");
        emit ValidatorNotice(_valAddr, _key, _data, msg.sender);
    }

    function setParamValue(dt.ParamName _name, uint256 _value) external {
        require(msg.sender == govContract, "Caller is not gov contract");
        if (_name == dt.ParamName.MaxBondedValidators) {
            require(bondedValAddrs.length <= _value, "invalid value");
        }
        params[_name] = _value;
    }

    function setGovContract(address _addr) external onlyOwner {
        govContract = _addr;
    }

    function setRewardContract(address _addr) external onlyOwner {
        rewardContract = _addr;
    }

    /**
     * @notice Set max slash factor
     */
    function setMaxSlashFactor(uint256 _maxSlashFactor) external onlyOwner {
        params[dt.ParamName.MaxSlashFactor] = _maxSlashFactor;
    }

    /**
     * @notice Owner drains tokens when the contract is paused
     * @dev emergency use only
     * @param _amount drained token amount
     */
    function drainToken(uint256 _amount) external whenPaused onlyOwner {
        CELER_TOKEN.safeTransfer(msg.sender, _amount);
    }

    /**************************
     *  Public View Functions *
     **************************/

    /**
     * @notice Validate if a message is signed by quorum tokens
     * @param _msg signed message
     * @param _sigs list of validator signatures
     */
    function verifySignatures(bytes memory _msg, bytes[] memory _sigs) public view returns (bool) {
        bytes32 hash = keccak256(_msg).toEthSignedMessageHash();
        uint256 signedTokens;
        address prev = address(0);
        uint256 quorum = getQuorumTokens();
        for (uint256 i = 0; i < _sigs.length; i++) {
            address signer = hash.recover(_sigs[i]);
            require(signer > prev, "Signers not in ascending order");
            prev = signer;
            dt.Validator storage validator = validators[signerVals[signer]];
            if (validator.status != dt.ValidatorStatus.Bonded) {
                continue;
            }
            signedTokens += validator.tokens;
            if (signedTokens >= quorum) {
                return true;
            }
        }
        revert("Quorum not reached");
    }

    /**
     * @notice Verifies that a message is signed by a quorum among the validators.
     * @param _msg signed message
     * @param _sigs the list of signatures
     */
    function verifySigs(
        bytes memory _msg,
        bytes[] calldata _sigs,
        address[] calldata,
        uint256[] calldata
    ) public view override {
        require(verifySignatures(_msg, _sigs), "Failed to verify sigs");
    }

    /**
     * @notice Get quorum amount of tokens
     * @return the quorum amount
     */
    function getQuorumTokens() public view returns (uint256) {
        return (bondedTokens * 2) / 3 + 1;
    }

    /**
     * @notice Get validator info
     * @param _valAddr the address of the validator
     * @return Validator token amount
     */
    function getValidatorTokens(address _valAddr) public view returns (uint256) {
        return validators[_valAddr].tokens;
    }

    /**
     * @notice Get validator info
     * @param _valAddr the address of the validator
     * @return Validator status
     */
    function getValidatorStatus(address _valAddr) public view returns (dt.ValidatorStatus) {
        return validators[_valAddr].status;
    }

    /**
     * @notice Check the given address is a validator or not
     * @param _addr the address to check
     * @return the given address is a validator or not
     */
    function isBondedValidator(address _addr) public view returns (bool) {
        return validators[_addr].status == dt.ValidatorStatus.Bonded;
    }

    /**
     * @notice Get the number of validators
     * @return the number of validators
     */
    function getValidatorNum() public view returns (uint256) {
        return valAddrs.length;
    }

    /**
     * @notice Get the number of bonded validators
     * @return the number of bonded validators
     */
    function getBondedValidatorNum() public view returns (uint256) {
        return bondedValAddrs.length;
    }

    /**
     * @return addresses and token amounts of bonded validators
     */
    function getBondedValidatorsTokens() public view returns (dt.ValidatorTokens[] memory) {
        dt.ValidatorTokens[] memory infos = new dt.ValidatorTokens[](bondedValAddrs.length);
        for (uint256 i = 0; i < bondedValAddrs.length; i++) {
            address valAddr = bondedValAddrs[i];
            infos[i] = dt.ValidatorTokens(valAddr, validators[valAddr].tokens);
        }
        return infos;
    }

    /**
     * @notice Check if min token requirements are met
     * @param _valAddr the address of the validator
     * @param _checkSelfDelegation check self delegation
     */
    function hasMinRequiredTokens(address _valAddr, bool _checkSelfDelegation) public view returns (bool) {
        dt.Validator storage v = validators[_valAddr];
        uint256 valTokens = v.tokens;
        if (valTokens < params[dt.ParamName.MinValidatorTokens]) {
            return false;
        }
        if (_checkSelfDelegation) {
            uint256 selfDelegation = _shareToToken(v.delegators[_valAddr].shares, valTokens, v.shares);
            if (selfDelegation < v.minSelfDelegation) {
                return false;
            }
        }
        return true;
    }

    /**
     * @notice Get the delegator info of a specific validator
     * @param _valAddr the address of the validator
     * @param _delAddr the address of the delegator
     * @return DelegatorInfo from the given validator
     */
    function getDelegatorInfo(address _valAddr, address _delAddr) public view returns (dt.DelegatorInfo memory) {
        dt.Validator storage validator = validators[_valAddr];
        dt.Delegator storage d = validator.delegators[_delAddr];
        uint256 tokens = _shareToToken(d.shares, validator.tokens, validator.shares);

        uint256 undelegationShares;
        uint256 withdrawableUndelegationShares;
        uint256 unbondingPeriod = params[dt.ParamName.UnbondingPeriod];
        bool isUnbonded = validator.status == dt.ValidatorStatus.Unbonded;
        uint256 len = d.undelegations.tail - d.undelegations.head;
        dt.Undelegation[] memory undelegations = new dt.Undelegation[](len);
        for (uint256 i = 0; i < len; i++) {
            undelegations[i] = d.undelegations.queue[i + d.undelegations.head];
            undelegationShares += undelegations[i].shares;
            if (isUnbonded || undelegations[i].creationBlock + unbondingPeriod <= block.number) {
                withdrawableUndelegationShares += undelegations[i].shares;
            }
        }
        uint256 undelegationTokens = _shareToToken(
            undelegationShares,
            validator.undelegationTokens,
            validator.undelegationShares
        );
        uint256 withdrawableUndelegationTokens = _shareToToken(
            withdrawableUndelegationShares,
            validator.undelegationTokens,
            validator.undelegationShares
        );

        return
            dt.DelegatorInfo(
                _valAddr,
                tokens,
                d.shares,
                undelegations,
                undelegationTokens,
                withdrawableUndelegationTokens
            );
    }

    /**
     * @notice Get the value of a specific uint parameter
     * @param _name the key of this parameter
     * @return the value of this parameter
     */
    function getParamValue(dt.ParamName _name) public view returns (uint256) {
        return params[_name];
    }

    /*********************
     * Private Functions *
     *********************/

    function _undelegate(
        dt.Validator storage validator,
        address _valAddr,
        uint256 _tokens,
        uint256 _shares
    ) private {
        address delAddr = msg.sender;
        dt.Delegator storage delegator = validator.delegators[delAddr];
        delegator.shares -= _shares;
        validator.shares -= _shares;
        validator.tokens -= _tokens;
        if (validator.tokens != validator.shares && delegator.shares <= 2) {
            // Remove residual share caused by rounding error when total shares and tokens are not equal
            validator.shares -= delegator.shares;
            delegator.shares = 0;
        }
        require(delegator.shares == 0 || delegator.shares >= dt.CELR_DECIMAL, "not enough remaining shares");

        if (validator.status == dt.ValidatorStatus.Unbonded) {
            CELER_TOKEN.safeTransfer(delAddr, _tokens);
            emit Undelegated(_valAddr, delAddr, _tokens);
            return;
        } else if (validator.status == dt.ValidatorStatus.Bonded) {
            bondedTokens -= _tokens;
            if (!hasMinRequiredTokens(_valAddr, delAddr == _valAddr)) {
                _unbondValidator(_valAddr);
            }
        }
        require(
            delegator.undelegations.tail - delegator.undelegations.head < dt.MAX_UNDELEGATION_ENTRIES,
            "Exceed max undelegation entries"
        );

        uint256 undelegationShares = _tokenToShare(_tokens, validator.undelegationTokens, validator.undelegationShares);
        validator.undelegationShares += undelegationShares;
        validator.undelegationTokens += _tokens;
        dt.Undelegation storage undelegation = delegator.undelegations.queue[delegator.undelegations.tail];
        undelegation.shares = undelegationShares;
        undelegation.creationBlock = block.number;
        delegator.undelegations.tail++;

        emit DelegationUpdate(_valAddr, delAddr, validator.tokens, delegator.shares, -int256(_tokens));
    }

    /**
     * @notice Set validator to bonded
     * @param _valAddr the address of the validator
     */
    function _setBondedValidator(address _valAddr) private {
        dt.Validator storage validator = validators[_valAddr];
        validator.status = dt.ValidatorStatus.Bonded;
        delete validator.unbondBlock;
        bondedTokens += validator.tokens;
        emit ValidatorStatusUpdate(_valAddr, dt.ValidatorStatus.Bonded);
    }

    /**
     * @notice Set validator to unbonding
     * @param _valAddr the address of the validator
     */
    function _setUnbondingValidator(address _valAddr) private {
        dt.Validator storage validator = validators[_valAddr];
        validator.status = dt.ValidatorStatus.Unbonding;
        validator.unbondBlock = uint64(block.number + params[dt.ParamName.UnbondingPeriod]);
        bondedTokens -= validator.tokens;
        emit ValidatorStatusUpdate(_valAddr, dt.ValidatorStatus.Unbonding);
    }

    /**
     * @notice Bond a validator
     * @param _valAddr the address of the validator
     */
    function _bondValidator(address _valAddr) private {
        bondedValAddrs.push(_valAddr);
        _setBondedValidator(_valAddr);
    }

    /**
     * @notice Replace a bonded validator
     * @param _valAddr the address of the new validator
     * @param _index the index of the validator to be replaced
     */
    function _replaceBondedValidator(address _valAddr, uint256 _index) private {
        _setUnbondingValidator(bondedValAddrs[_index]);
        bondedValAddrs[_index] = _valAddr;
        _setBondedValidator(_valAddr);
    }

    /**
     * @notice Unbond a validator
     * @param _valAddr validator to be removed
     */
    function _unbondValidator(address _valAddr) private {
        uint256 lastIndex = bondedValAddrs.length - 1;
        for (uint256 i = 0; i < bondedValAddrs.length; i++) {
            if (bondedValAddrs[i] == _valAddr) {
                if (i < lastIndex) {
                    bondedValAddrs[i] = bondedValAddrs[lastIndex];
                }
                bondedValAddrs.pop();
                _setUnbondingValidator(_valAddr);
                return;
            }
        }
        revert("Not bonded validator");
    }

    /**
     * @notice Check if one validator has too much power
     * @param _valTokens token amounts of the validator
     */
    function _decentralizationCheck(uint256 _valTokens) private view {
        uint256 bondedValNum = bondedValAddrs.length;
        if (bondedValNum == 2 || bondedValNum == 3) {
            require(_valTokens < getQuorumTokens(), "Single validator should not have quorum tokens");
        } else if (bondedValNum > 3) {
            require(_valTokens < bondedTokens / 3, "Single validator should not have 1/3 tokens");
        }
    }

    /**
     * @notice Convert token to share
     */
    function _tokenToShare(
        uint256 tokens,
        uint256 totalTokens,
        uint256 totalShares
    ) private pure returns (uint256) {
        if (totalTokens == 0) {
            return tokens;
        }
        return (tokens * totalShares) / totalTokens;
    }

    /**
     * @notice Convert share to token
     */
    function _shareToToken(
        uint256 shares,
        uint256 totalTokens,
        uint256 totalShares
    ) private pure returns (uint256) {
        if (totalShares == 0) {
            return shares;
        }
        return (shares * totalTokens) / totalShares;
    }
}
