// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ISigsVerifier.sol";
import "../libraries/PbFarming.sol";
import "../safeguard/Pauser.sol";

/**
 * @title A contract to hold and distribute farming rewards.
 */
contract FarmingRewards is Pauser {
    using SafeERC20 for IERC20;

    ISigsVerifier public immutable sigsVerifier;

    // recipient => tokenAddress => amount
    mapping(address => mapping(address => uint256)) public claimedRewardAmounts;

    event FarmingRewardClaimed(address indexed recipient, address indexed token, uint256 reward);
    event FarmingRewardContributed(address indexed contributor, address indexed token, uint256 contribution);

    constructor(ISigsVerifier _sigsVerifier) {
        sigsVerifier = _sigsVerifier;
    }

    /**
     * @notice Claim rewards
     * @dev Here we use cumulative reward to make claim process idempotent
     * @param _rewardsRequest rewards request bytes coded in protobuf
     * @param _sigs list of signatures sorted by signer addresses in ascending order
     * @param _signers sorted list of current signers
     * @param _powers powers of current signers
     */
    function claimRewards(
        bytes calldata _rewardsRequest,
        bytes[] calldata _sigs,
        address[] calldata _signers,
        uint256[] calldata _powers
    ) external whenNotPaused {
        bytes32 domain = keccak256(abi.encodePacked(block.chainid, address(this), "FarmingRewards"));
        sigsVerifier.verifySigs(abi.encodePacked(domain, _rewardsRequest), _sigs, _signers, _powers);
        PbFarming.FarmingRewards memory rewards = PbFarming.decFarmingRewards(_rewardsRequest);
        bool hasNewReward;
        for (uint256 i = 0; i < rewards.tokenAddresses.length; i++) {
            address token = rewards.tokenAddresses[i];
            uint256 cumulativeRewardAmount = rewards.cumulativeRewardAmounts[i];
            uint256 newReward = cumulativeRewardAmount - claimedRewardAmounts[rewards.recipient][token];
            if (newReward > 0) {
                hasNewReward = true;
                claimedRewardAmounts[rewards.recipient][token] = cumulativeRewardAmount;
                IERC20(token).safeTransfer(rewards.recipient, newReward);
                emit FarmingRewardClaimed(rewards.recipient, token, newReward);
            }
        }
        require(hasNewReward, "No new reward");
    }

    /**
     * @notice Contribute reward tokens to the reward pool
     * @param _token the address of the token to contribute
     * @param _amount the amount of the token to contribute
     */
    function contributeToRewardPool(address _token, uint256 _amount) external whenNotPaused {
        address contributor = msg.sender;
        IERC20(_token).safeTransferFrom(contributor, address(this), _amount);

        emit FarmingRewardContributed(contributor, _token, _amount);
    }

    /**
     * @notice Owner drains tokens when the contract is paused
     * @dev emergency use only
     * @param _token the address of the token to drain
     * @param _amount drained token amount
     */
    function drainToken(address _token, uint256 _amount) external whenPaused onlyOwner {
        IERC20(_token).safeTransfer(msg.sender, _amount);
    }
}
