# ReceiverOIF

## Description

Periphery contract used for arbitrary cross-chain destination calls via OIF

## How To Use

The contract has one method which will be called through the configured OIF OutputSettler:

```solidity
/// @notice Completes an OIF Intent via outputFilled.
/// @dev The endpoint is configured to only accept calldata coming from a specific output settler. This does not prevent people from calling this function with malicious or fraudulent data but we can assure that the tokens and amounts have been correctly delivered.
// If token is bytes32(0) then the native amount has been delivered before this call and no call value is provided.
/// @param token Token identifier for the filled output. If normal ERC20, the 20 least significant bytes contains the address.
/// @param amount Token amount
/// @param executionData Attached arbitrary callbackData for the output.
function outputFilled(
    bytes32 token,
    uint256 amount,
    bytes calldata executionData
) external onlyTrustedOutputSettler;
```

## Constructor Parameters

- `address _owner`: The owner address with withdrawal permissions
- `address _executor`: The Executor contract address for swap execution
- `address _outputSettler`: The specified allowed outputSettler
- `uint256 _minimumGas`: Required gas that solvers have to provide. It needs to be sufficiently larger than `_recoverGas` such that the difference allows execution data to execute. It can be set to 0 to rely on the recovery logic using the 1/64'th gas to block execution.
- `uint256 _recoverGas`: Gas reserved for recovery. If configured to 0, the logic relies on the executor leaving gas after reverting for the fallback to trigger. It can be set anywhere between 0 and the actual amount to adjust how aggressively the contract enforces the attempt to execute with provided gas.

## Events

The contract emits `LiFiTransferRecovered` events when swap execution fails and tokens are sent directly to the receiver.
