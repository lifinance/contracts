# Intent Factory

## Description

The intent factory allows for triggering an action for a user 
in a non-custodial way. The user/on-ramp/protocol/bridge simply sends funds to 
an address we compute. It can then deploy a contract to that address and 
trigger the action the user intended. This is done by encoding the user's 
intent into that address/contract. Fallback handling allows the user to 
withdraw their funds at any time.

## How To Use

1. The first step to generating an intent is to calculate the intent contract's
deterministic address. You do this by providing the following:
- A random `bytes32` id
- The receiver address
- The address of the output token
- Minimum amount of token to receive

```solidity
// Compute the address of the intent
address intentClone = factory.getIntentAddress(
    IIntent.InitData({
        intentId: RANDOM_BYTES32_ID,
        receiver: RECEIVER_ADDRESS,
        tokenOut: TOKEN_OUT_ADDRESS,
        amountOutMin: 100 * 10**TOKEN_OUT_DECIMALS
    })
);
```

2. Next the tokens needed to fulfill the intent need to be sent to the
pre-calculated address. (NOTE: you can send multiple tokens if you wish).
A normal use-case would be bridging tokens from one chain to the pre-calculated
address on another chain and waiting for the bridge to complete to execute
the intent.

3. Execute the intent by passing an array of sequential calldata that will 
yield the intended output amount for the receiver. For example, the first call
would approve the deposited token to an AMM. The next call would perform the
swap. Finally transfer any positive slippage or a pre-determined fee. As long
as the minimum output amount is left, the call will succeed and the remaining
output tokens will be transferred to the receiver.

```solidity
IIntent.Call[] memory calls = new IIntent.Call[](2);

// get approve calldata
bytes memory approveCalldata = abi.encodeWithSignature(
    "approve(address,uint256)",
    AMM_ADDRESS,
    1000
);
calls[0] = IIntent.Call({
    to: TOKEN_OUT_ADDRESS,
    value: 0,
    data: approveCalldata
});

// get swap calldata
bytes memory swapCalldata = abi.encodeWithSignature(
    "swap(address,uint256,address,uint256)",
    TOKEN_IN_ADDRESS,
    1000 * 10**TOKEN_IN_DECIMALS,
    TOKEN_OUT_ADDRESS,
    100 * 10**TOKEN_OUT_DECIMALS
);
calls[1] = IIntent.Call({
    to: AMM_ADDRESS,
    value: 0,
    data: swapCalldata
});

// execute the intent
factory.deployAndExecuteIntent(
    IIntent.InitData({
        intentId: intentId,
        receiver: RECEIVER_ADDRESS,
        tokenOut: TOKEN_OUT_ADDRESS,
        amountOutMin: 100 * 10**TOKEN_OUT_DECIMALS
    }),
    calls
);
```
