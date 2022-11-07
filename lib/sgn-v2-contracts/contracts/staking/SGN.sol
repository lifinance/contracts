// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DataTypes as dt} from "./DataTypes.sol";
import "../libraries/PbSgn.sol";
import "../safeguard/Pauser.sol";
import "./Staking.sol";

/**
 * @title contract of SGN chain
 */
contract SGN is Pauser {
    using SafeERC20 for IERC20;

    Staking public immutable staking;
    bytes32[] public deposits;
    // account -> (token -> amount)
    mapping(address => mapping(address => uint256)) public withdrawnAmts;
    mapping(address => bytes) public sgnAddrs;

    /* Events */
    event SgnAddrUpdate(address indexed valAddr, bytes oldAddr, bytes newAddr);
    event Deposit(uint256 depositId, address account, address token, uint256 amount);
    event Withdraw(address account, address token, uint256 amount);

    /**
     * @notice SGN constructor
     * @dev Need to deploy Staking contract first before deploying SGN contract
     * @param _staking address of Staking Contract
     */
    constructor(Staking _staking) {
        staking = _staking;
    }

    /**
     * @notice Update sgn address
     * @param _sgnAddr the new address in the layer 2 SGN
     */
    function updateSgnAddr(bytes calldata _sgnAddr) external {
        address valAddr = msg.sender;
        if (staking.signerVals(msg.sender) != address(0)) {
            valAddr = staking.signerVals(msg.sender);
        }

        dt.ValidatorStatus status = staking.getValidatorStatus(valAddr);
        require(status == dt.ValidatorStatus.Unbonded, "Not unbonded validator");

        bytes memory oldAddr = sgnAddrs[valAddr];
        sgnAddrs[valAddr] = _sgnAddr;

        staking.validatorNotice(valAddr, "sgn-addr", _sgnAddr);
        emit SgnAddrUpdate(valAddr, oldAddr, _sgnAddr);
    }

    /**a
     * @notice Deposit to SGN
     * @param _amount subscription fee paid along this function call in CELR tokens
     */
    function deposit(address _token, uint256 _amount) external whenNotPaused {
        address msgSender = msg.sender;
        deposits.push(keccak256(abi.encodePacked(msgSender, _token, _amount)));
        IERC20(_token).safeTransferFrom(msgSender, address(this), _amount);
        uint64 depositId = uint64(deposits.length - 1);
        emit Deposit(depositId, msgSender, _token, _amount);
    }

    /**
     * @notice Withdraw token
     * @dev Here we use cumulative amount to make withdrawal process idempotent
     * @param _withdrawalRequest withdrawal request bytes coded in protobuf
     * @param _sigs list of validator signatures
     */
    function withdraw(bytes calldata _withdrawalRequest, bytes[] calldata _sigs) external whenNotPaused {
        bytes32 domain = keccak256(abi.encodePacked(block.chainid, address(this), "Withdrawal"));
        staking.verifySignatures(abi.encodePacked(domain, _withdrawalRequest), _sigs);
        PbSgn.Withdrawal memory withdrawal = PbSgn.decWithdrawal(_withdrawalRequest);

        uint256 amount = withdrawal.cumulativeAmount - withdrawnAmts[withdrawal.account][withdrawal.token];
        require(amount > 0, "No new amount to withdraw");
        withdrawnAmts[withdrawal.account][withdrawal.token] = withdrawal.cumulativeAmount;

        IERC20(withdrawal.token).safeTransfer(withdrawal.account, amount);
        emit Withdraw(withdrawal.account, withdrawal.token, amount);
    }

    /**
     * @notice Owner drains one type of tokens when the contract is paused
     * @dev emergency use only
     * @param _amount drained token amount
     */
    function drainToken(address _token, uint256 _amount) external whenPaused onlyOwner {
        IERC20(_token).safeTransfer(msg.sender, _amount);
    }
}
