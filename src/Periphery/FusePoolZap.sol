// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ZeroAmount } from "../Errors/GenericErrors.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";

interface IFusePool {
    function cTokensByUnderlying(address) external view returns (address);
}

interface IFToken {
    function isCEther() external returns (bool);

    function mint(uint256) external returns (uint256);
}

interface IFusePoolDirectory {
    function poolExists(address) external view returns (bool);
}

/// @title Fuse Pool Zap
/// @author LI.FI (https://li.fi)
/// @notice Allows anyone to quickly zap into a Rari Fuse Pool
contract FusePoolZap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Constants ///
    address private constant NULL_ADDRESS = address(0);
    IFusePoolDirectory private immutable fusePoolDirectory;

    /// Errors ///

    error InvalidPoolAddress(address);
    error InvalidSupplyToken(address);
    error InvalidAmount(uint256);
    error MintingError(bytes);

    /// Events ///

    event ZappedIn(
        address indexed pool,
        address indexed fToken,
        uint256 amount
    );

    /// Constructor ///

    constructor(address _fusePoolDirectory) {
        fusePoolDirectory = IFusePoolDirectory(_fusePoolDirectory);
    }

    /// Public Methods ///

    /// @notice Given a supply token receive an fToken from a given Fuse pool
    /// @param _pool Rari Fuse Pool contract address
    /// @param _supplyToken the token to supply to the pool
    /// @param _amount Amount of _supplyToken to supply
    function zapIn(
        address _pool,
        address _supplyToken,
        uint256 _amount
    ) external {
        if (_pool == NULL_ADDRESS || !fusePoolDirectory.poolExists(_pool)) {
            revert InvalidPoolAddress(_pool);
        }

        if (_amount == 0) {
            revert ZeroAmount();
        }

        IFToken fToken = IFToken(
            IFusePool(_pool).cTokensByUnderlying(_supplyToken)
        );

        if (address(fToken) == NULL_ADDRESS) {
            revert InvalidSupplyToken(_supplyToken);
        }

        uint256 preMintBalance = IERC20(address(fToken)).balanceOf(
            address(this)
        );

        LibAsset.transferFromERC20(
            _supplyToken,
            msg.sender,
            address(this),
            _amount
        );
        IERC20(_supplyToken).safeApprove(address(fToken), 0);
        IERC20(_supplyToken).safeApprove(address(fToken), _amount);

        fToken.mint(_amount);
        uint256 mintAmount = 0;
        unchecked {
            mintAmount =
                IERC20(address(fToken)).balanceOf(address(this)) -
                preMintBalance;
        }
        IERC20(address(fToken)).transfer(msg.sender, mintAmount);

        emit ZappedIn(_pool, address(fToken), mintAmount);
    }

    /// @notice Given ETH receive fETH from a given Fuse pool
    /// @param _pool Rari Fuse Pool contract address
    function zapIn(address _pool) external payable {
        if (_pool == NULL_ADDRESS || !fusePoolDirectory.poolExists(_pool)) {
            revert InvalidPoolAddress(_pool);
        }

        if (msg.value == 0) {
            revert ZeroAmount();
        }

        IFToken fToken = IFToken(
            IFusePool(_pool).cTokensByUnderlying(NULL_ADDRESS)
        );

        if (address(fToken) == NULL_ADDRESS) {
            revert InvalidSupplyToken(NULL_ADDRESS);
        }

        uint256 preMintBalance = IERC20(address(fToken)).balanceOf(
            address(this)
        );

        // Use call because method can succeed with partial revert
        (bool success, bytes memory res) = address(fToken).call{
            value: msg.value
        }(abi.encodeWithSignature("mint()"));
        uint256 mintAmount = 0;
        unchecked {
            mintAmount =
                IERC20(address(fToken)).balanceOf(address(this)) -
                preMintBalance;
        }
        if (!success && mintAmount == 0) {
            revert MintingError(res);
        }

        IERC20(address(fToken)).transfer(msg.sender, mintAmount);

        emit ZappedIn(_pool, address(fToken), mintAmount);
    }
}
