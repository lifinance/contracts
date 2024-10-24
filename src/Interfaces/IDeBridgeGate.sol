// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IDeBridgeGate {
    /// @param fixedNativeFee Transfer fixed fee.
    /// @param isSupported Whether the chain for the asset is supported.
    /// @param transferFeeBps Transfer fee rate nominated in basis points (1/10000)
    ///                       of transferred amount.
    struct ChainSupportInfo {
        uint256 fixedNativeFee;
        bool isSupported;
        uint16 transferFeeBps;
    }

    /// @dev Fallback fixed fee in native asset, used if a chain fixed fee is set to 0
    function globalFixedNativeFee() external view returns (uint256);

    /// @dev Whether the chain for the asset is supported to send
    function getChainToConfig(
        uint256
    ) external view returns (ChainSupportInfo memory);

    /// @dev This method is used for the transfer of assets.
    ///      It locks an asset in the smart contract in the native chain
    ///      and enables minting of deAsset on the secondary chain.
    /// @param _tokenAddress Asset identifier.
    /// @param _amount Amount to be transferred (note: the fee can be applied).
    /// @param _chainIdTo Chain id of the target chain.
    /// @param _receiver Receiver address.
    /// @param _permit deadline + signature for approving the spender by signature.
    /// @param _useAssetFee use assets fee for pay protocol fix (work only for specials token)
    /// @param _referralCode Referral code
    /// @param _autoParams Auto params for external call in target network
    function send(
        address _tokenAddress,
        uint256 _amount,
        uint256 _chainIdTo,
        bytes memory _receiver,
        bytes memory _permit,
        bool _useAssetFee,
        uint32 _referralCode,
        bytes calldata _autoParams
    ) external payable;
}
