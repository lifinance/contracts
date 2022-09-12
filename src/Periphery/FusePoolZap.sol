// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

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
contract FusePoolZap {
    /// Constants ///
    address private constant NULL_ADDRESS = address(0);
    IFusePoolDirectory private immutable fusePoolDirectory;

    /// Errors ///

    error InvalidPoolAddress(address);
    error InvalidSupplyToken(address);
    error InvalidAmount(uint256);
    error CannotDepositNativeToken();
    error MintingError(bytes);

    /// Events ///

    event ZappedIn(address indexed pool, address indexed fToken, uint256 amount);

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
        unchecked {
            if (_pool == NULL_ADDRESS || !fusePoolDirectory.poolExists(_pool)) {
                revert InvalidPoolAddress(_pool);
            }

            if (_amount <= 0) {
                revert InvalidAmount(_amount);
            }

            IFToken fToken = IFToken(IFusePool(_pool).cTokensByUnderlying(_supplyToken));

            if (address(fToken) == NULL_ADDRESS) {
                revert InvalidSupplyToken(_supplyToken);
            }

            uint256 preMintBalance = IERC20(address(fToken)).balanceOf(address(this));

            LibAsset.transferFromERC20(_supplyToken, msg.sender, address(this), _amount);
            IERC20(_supplyToken).approve(address(fToken), _amount);
            fToken.mint(_amount);

            uint256 mintAmount = IERC20(address(fToken)).balanceOf(address(this)) - preMintBalance;

            IERC20(address(fToken)).transfer(msg.sender, mintAmount);

            emit ZappedIn(_pool, address(fToken), mintAmount);
        }
    }

    /// @notice Given ETH receive fETH from a given Fuse pool
    /// @param _pool Rari Fuse Pool contract address
    function zapIn(address _pool) external payable {
        unchecked {
            if (_pool == NULL_ADDRESS || !fusePoolDirectory.poolExists(_pool)) {
                revert InvalidPoolAddress(_pool);
            }

            if (msg.value <= 0) {
                revert InvalidAmount(msg.value);
            }

            IFToken fToken = IFToken(IFusePool(_pool).cTokensByUnderlying(NULL_ADDRESS));

            if (address(fToken) == NULL_ADDRESS) {
                revert InvalidSupplyToken(NULL_ADDRESS);
            }

            uint256 preMintBalance = IERC20(address(fToken)).balanceOf(address(this));

            // Use call because method can succeed with partial revert
            (bool success, bytes memory res) = address(fToken).call{ value: msg.value }(
                abi.encodeWithSignature("mint()")
            );
            uint256 mintAmount = IERC20(address(fToken)).balanceOf(address(this)) - preMintBalance;
            if (!success && mintAmount == 0) {
                revert MintingError(res);
            }

            IERC20(address(fToken)).transfer(msg.sender, mintAmount);

            emit ZappedIn(_pool, address(fToken), mintAmount);
        }
    }
}
