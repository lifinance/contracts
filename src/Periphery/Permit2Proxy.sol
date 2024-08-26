// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Permit2Proxy is TransferrableOwnership {
    /// Storage ///

    ISignatureTransfer public immutable PERMIT2;
    mapping(address => bool) public diamondWhitelist;

    string public constant WITNESS_TYPE_STRING =
        "LIFICall witness)LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256(
            "LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)"
        );

    /// Types ///

    // @dev LIFI Specific Witness to verify
    struct LIFICall {
        address tokenReceiver;
        address diamondAddress;
        bytes32 diamondCalldataHash;
    }

    /// Errors ///

    error CallToDiamondFailed(bytes);
    error DiamondAddressNotWhitelisted();

    /// Events ///

    event WhitelistUpdated(address[] addresses, bool[] values);

    /// Constructor ///

    constructor(
        address _owner,
        ISignatureTransfer _permit2
    ) TransferrableOwnership(_owner) {
        PERMIT2 = _permit2;
    }

    /// External Functions ///

    function diamondCallSingle(
        address _tokenReceiver,
        address _diamondAddress,
        bytes calldata _diamondCalldata,
        address _owner,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable {
        LIFICall memory lifiCall = LIFICall(
            _tokenReceiver,
            _diamondAddress,
            keccak256(_diamondCalldata)
        );

        bytes32 witness = keccak256(abi.encode(WITNESS_TYPEHASH, lifiCall));

        PERMIT2.permitWitnessTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: _permit.permitted.amount
            }),
            _owner,
            witness,
            WITNESS_TYPE_STRING,
            _signature
        );

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(_permit.permitted.token),
            _diamondAddress,
            _permit.permitted.amount
        );

        _executeCalldata(_diamondAddress, _diamondCalldata);
    }

    function _executeCalldata(
        address diamondAddress,
        bytes memory diamondCalldata
    ) private {
        // make sure diamondAddress is whitelisted
        // this limits the usage of this Permit2Proxy contracts to only work with our diamond contracts
        if (!diamondWhitelist[diamondAddress])
            revert DiamondAddressNotWhitelisted();

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = diamondAddress.call{
            value: msg.value
        }(diamondCalldata);
        // throw error to make sure tx reverts if low-level call was unsuccessful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }

    /// @notice Allows to update the whitelist of diamond contracts
    /// @dev Admin function
    /// @param addresses Addresses to be added (true) or removed (false) from whitelist
    /// @param values Values for each address that should be updated
    function updateWhitelist(
        address[] calldata addresses,
        bool[] calldata values
    ) external onlyOwner {
        for (uint i; i < addresses.length; ) {
            // update whitelist address value
            diamondWhitelist[addresses[i]] = values[i];

            // gas-efficient way to increase the loop counter
            unchecked {
                ++i;
            }
        }
        emit WhitelistUpdated(addresses, values);
    }
}
