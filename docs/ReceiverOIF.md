# ReceiverOIF

## Description

Periphery contract used for arbitrary cross-chain destination calls via OIF

## How To Use

The contract has one method which will be called through the configured OIF OutputSettler:

```solidity
/// @notice Completes an OIF Intent via outputFilled.
/// @dev The endpoint is configured to only accept calldata coming from a specfic output settler. This does not prevent people from calling this function with malicious or fradulent data but we can assure that the tokens and amounts have been correctly delivered.
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
- `uint256 _minimumGas`: Required gas that solvers have to provide. Needs to be sufficiently larger than `_recoverGas` such that the difference allows swapData to execute. Can be set to 0 to rely on the recovery logic using the 1/64'th gas to block execution.
- `uint256 _recoverGas`: Gas reserved for recovery. If configured to 0, then the logic relies on the executor leaving gas after reverting for the fallback to trigger. Can be set anywhere between the 0 and the actual amount to adjust how aggressive the contract should enforce attempt to execute provided gas.

## Events

The contract emits `LiFiTransferRecovered` events when swap execution fails and tokens are sent directly to the receiver.
