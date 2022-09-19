// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

error TokenAddressIsZero();
error CannotBridgeToSameNetwork();
error ZeroPostSwapBalance();
error NoSwapDataProvided();
error NativeValueWithERC();
error ContractCallNotAllowed();
error NullAddrIsNotAValidSpender();
error NullAddrIsNotAnERC20Token();
error NoTransferToNullAddress();
error NativeAssetTransferFailed();
error InvalidBridgeConfigLength();
error InvalidAmount();
error InvalidContract();
error InvalidConfig();
error InvalidReceiver();
error InvalidDestinationChain();
error InvalidSendingToken();
error InvalidCaller();
error OnlyContractOwner();
error CannotAuthoriseSelf();
error RecoveryAddressCannotBeZero();
error CannotDepositNativeToken();
error ZeroAmount();
error UnAuthorized();
error NoSwapFromZeroBalance();
error InvalidFallbackAddress();
