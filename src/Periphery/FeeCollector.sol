// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.13;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting integrator fees
contract FeeCollector is TransferrableOwnership {
    /// State ///

    // Integrator -> TokenAddress -> Balance
    mapping(address => mapping(address => uint256)) private _balances;
    // TokenAddress -> Balance
    mapping(address => uint256) private _lifiBalances;

    /// Errors ///
    error TransferFailure();

    /// Events ///
    event FeesCollected(address indexed _token, address indexed _integrator, uint256 _integratorFee, uint256 _lifiFee);
    event FeesWithdrawn(address indexed _token, address indexed _to, uint256 _amount);
    event LiFiFeesWithdrawn(address indexed _token, address indexed _to, uint256 _amount);

    /// Constructor ///

    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// External Methods ///

    /// @notice Collects fees for the integrator
    /// @param tokenAddress address of the token to collect fees for
    /// @param integratorFee amount of fees to collect going to the integrator
    /// @param lifiFee amount of fees to collect going to lifi
    /// @param integratorAddress address of the integrator
    function collectTokenFees(
        address tokenAddress,
        uint256 integratorFee,
        uint256 lifiFee,
        address integratorAddress
    ) external {
        LibAsset.depositAsset(tokenAddress, integratorFee + lifiFee);
        _balances[integratorAddress][tokenAddress] += integratorFee;
        _lifiBalances[tokenAddress] += lifiFee;
        emit FeesCollected(tokenAddress, integratorAddress, integratorFee, lifiFee);
    }

    /// @notice Collects fees for the integrator in native token
    /// @param integratorFee amount of fees to collect going to the integrator
    /// @param lifiFee amount of fees to collect going to lifi
    /// @param integratorAddress address of the integrator
    function collectNativeFees(
        uint256 integratorFee,
        uint256 lifiFee,
        address integratorAddress
    ) external payable {
        _balances[integratorAddress][LibAsset.NULL_ADDRESS] += integratorFee;
        _lifiBalances[LibAsset.NULL_ADDRESS] += lifiFee;
        uint256 remaining = msg.value - (integratorFee + lifiFee);
        // Prevent extra native token from being locked in the contract
        if (remaining > 0) {
            (bool success, ) = msg.sender.call{ value: remaining }("");
            if (!success) {
                revert TransferFailure();
            }
        }
        emit FeesCollected(LibAsset.NULL_ADDRESS, integratorAddress, integratorFee, lifiFee);
    }

    /// @notice Withdraw fees and sends to the integrator
    /// @param tokenAddress address of the token to withdraw fees for
    function withdrawIntegratorFees(address tokenAddress) external {
        uint256 balance = _balances[msg.sender][tokenAddress];
        if (balance == 0) {
            return;
        }
        _balances[msg.sender][tokenAddress] = 0;
        LibAsset.transferAsset(tokenAddress, payable(msg.sender), balance);
        emit FeesWithdrawn(tokenAddress, msg.sender, balance);
    }

    /// @notice Batch withdraw fees and sends to the integrator
    /// @param tokenAddresses addresses of the tokens to withdraw fees for
    function batchWithdrawIntegratorFees(address[] memory tokenAddresses) external {
        uint256 length = tokenAddresses.length;
        uint256 balance;
        for (uint256 i = 0; i < length; i++) {
            balance = _balances[msg.sender][tokenAddresses[i]];
            if (balance == 0) {
                continue;
            }
            _balances[msg.sender][tokenAddresses[i]] = 0;
            LibAsset.transferAsset(tokenAddresses[i], payable(msg.sender), balance);
            emit FeesWithdrawn(tokenAddresses[i], msg.sender, balance);
        }
    }

    /// @notice Withdraws fees and sends to lifi
    /// @param tokenAddress address of the token to withdraw fees for
    function withdrawLifiFees(address tokenAddress) external onlyOwner {
        uint256 balance = _lifiBalances[tokenAddress];
        if (balance == 0) {
            return;
        }
        _lifiBalances[tokenAddress] = 0;
        LibAsset.transferAsset(tokenAddress, msg.sender, balance);
        emit LiFiFeesWithdrawn(tokenAddress, msg.sender, balance);
    }

    /// @notice Batch withdraws fees and sends to lifi
    /// @param tokenAddresses addresses of the tokens to withdraw fees for
    function batchWithdrawLifiFees(address[] memory tokenAddresses) external onlyOwner {
        uint256 length = tokenAddresses.length;
        uint256 balance;
        for (uint256 i = 0; i < length; i++) {
            balance = _lifiBalances[tokenAddresses[i]];
            if (balance == 0) {
                continue;
            }
            _lifiBalances[tokenAddresses[i]] = 0;
            LibAsset.transferAsset(tokenAddresses[i], msg.sender, balance);
            emit LiFiFeesWithdrawn(tokenAddresses[i], msg.sender, balance);
        }
    }

    /// @notice Returns the balance of the integrator
    /// @param integratorAddress address of the integrator
    /// @param tokenAddress address of the token to get the balance of
    function getTokenBalance(address integratorAddress, address tokenAddress) external view returns (uint256) {
        return _balances[integratorAddress][tokenAddress];
    }

    /// @notice Returns the balance of lifi
    /// @param tokenAddress address of the token to get the balance of
    function getLifiTokenBalance(address tokenAddress) external view returns (uint256) {
        return _lifiBalances[tokenAddress];
    }
}
