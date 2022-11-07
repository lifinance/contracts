# 0.2.0 (2022-03-28)

## MsgDataTypes

- Most message bridge related data types are now in a separate library `MsgDataTypes`. Some types have their naming changed but there is no structural change.

- `MsgDataTypes.BridgeSendType` (originally `BridgeType`) now has three more types `PegV2Deposit`, `PegV2Burn`, and `PegV2BurnFrom`.

## MessageReceiverApp

- Receiver functions `executeMessageWithTransfer`, `executeMessageWithTransferFallback`, `executeMessageWithTransferRefund`, `executeMessage` now has an extra param `address _executor` that the app developer could use to check who submitted the execution.

- Receiver functions' required return value also changed from a `boolean success` to `ExecutionStatus` to accommodate a third status `ExecutionStatus.Retry`. This status indicates that the message processing should not be regarded as "processed" by MessageBus and the processing should simply be ignored. This status can be used in conjunction with the aforementioned `address _executor` to completely ignore executions that are not originated from a specific executor.

## MessageBus (MessageBusReceiver)

- Added a helper function `refund()` to aggregate refund call to `Bridge.withdraw()` and refund functions in other bridges and `MessageBus.executeMessageWithTransferRefund()` into one call.

- Added a new event `NeedRetry`, emitted when the execution logic in an app contract returns `ExecutionStatus.Retry`.

- Added a field `srcTxHash` in `Executed` and `NeedRetry` event to enable third parties to co-verify a whether a transfer/message send does happen on the source chain (in the name of not completely trusting message bus).
