// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IFraxHopV2
/// @notice Minimal interface for Frax's HopV2 bridge (LayerZero V2 OFT hub-and-spoke)
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev Shadows FraxFinance HopV2/RemoteHopV2 (src/contracts/hop/HopV2.sol)
interface IFraxHopV2 {
    /// @notice Bridges an OFT to a destination chain (plain transfer, no compose)
    /// @param oft Address of the OFT messenger on the source chain
    /// @param dstEid LayerZero endpoint ID of the destination chain
    /// @param recipient bytes32-encoded recipient on the destination chain
    /// @param amountLD Amount to send in local decimals (floored to dust internally)
    /// @param dstGas Gas forwarded to the destination compose (0 for standard transfers)
    /// @param data Extra compose payload (empty for standard transfers)
    function sendOFT(
        address oft,
        uint32 dstEid,
        bytes32 recipient,
        uint256 amountLD,
        uint128 dstGas,
        bytes calldata data
    ) external payable;

    /// @notice Quotes the messaging fee for a hop (native on standard chains, TIP20 on Tempo)
    /// @param oft Address of the OFT messenger on the source chain
    /// @param dstEid LayerZero endpoint ID of the destination chain
    /// @param recipient bytes32-encoded recipient on the destination chain
    /// @param amount Amount to send in local decimals (dust removed internally)
    /// @param dstGas Gas forwarded to the destination compose
    /// @param data Extra compose payload
    /// @return fee The total fee required for the send
    function quote(
        address oft,
        uint32 dstEid,
        bytes32 recipient,
        uint256 amount,
        uint128 dstGas,
        bytes calldata data
    ) external view returns (uint256 fee);

    /// @notice Quotes the fee in a specific ERC20 gas token (Tempo EndpointV2Alt only)
    /// @param oft Address of the OFT messenger on the source chain
    /// @param dstEid LayerZero endpoint ID of the destination chain
    /// @param recipient bytes32-encoded recipient on the destination chain
    /// @param amount Amount to send in local decimals (dust removed internally)
    /// @param dstGas Gas forwarded to the destination compose
    /// @param data Extra compose payload
    /// @param userToken The ERC20 gas token the fee will be paid in
    /// @return fee The fee denominated in userToken
    function quoteStatic(
        address oft,
        uint32 dstEid,
        bytes32 recipient,
        uint256 amount,
        uint128 dstGas,
        bytes calldata data,
        address userToken
    ) external view returns (uint256 fee);

    /// @notice Floors an amount to the OFT's dust-free granularity
    /// @param oft Address of the OFT messenger
    /// @param amountLD Amount in local decimals
    /// @return flooredAmountLD The amount floored to a decimalConversionRate multiple
    function removeDust(
        address oft,
        uint256 amountLD
    ) external view returns (uint256 flooredAmountLD);
}

/// @title ITipFeeManager
/// @notice Tempo TIP20 fee-manager precompile: resolves a caller's preferred gas token
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev Tempo precompile at 0xfeEC000000000000000000000000000000000000
interface ITipFeeManager {
    /// @notice The gas token a user has opted into (address(0) if unset → PATH_USD default)
    /// @param user The account whose preferred gas token to read
    /// @return token The preferred TIP20 gas token, or address(0) if none set
    function userTokens(address user) external view returns (address token);
}

/// @title IFraxOFT
/// @notice Minimal OFT surface used by FraxFacet to resolve the underlying ERC20
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IFraxOFT {
    /// @notice The ERC20 token that the OFT transfers on the local chain
    /// @return The underlying ERC20 token address
    function token() external view returns (address);
}
