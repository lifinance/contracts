// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import {DataTypes as dt} from "./DataTypes.sol";
import "./Staking.sol";

/**
 * @title Viewer of the staking contract
 * @notice Using a separate viewer contract to reduce staking contract size
 */
contract Viewer {
    Staking public immutable staking;

    constructor(Staking _staking) {
        staking = _staking;
    }

    function getValidatorInfos() public view returns (dt.ValidatorInfo[] memory) {
        uint256 valNum = staking.getValidatorNum();
        dt.ValidatorInfo[] memory infos = new dt.ValidatorInfo[](valNum);
        for (uint32 i = 0; i < valNum; i++) {
            infos[i] = getValidatorInfo(staking.valAddrs(i));
        }
        return infos;
    }

    function getBondedValidatorInfos() public view returns (dt.ValidatorInfo[] memory) {
        uint256 bondedValNum = staking.getBondedValidatorNum();
        dt.ValidatorInfo[] memory infos = new dt.ValidatorInfo[](bondedValNum);
        for (uint32 i = 0; i < bondedValNum; i++) {
            infos[i] = getValidatorInfo(staking.bondedValAddrs(i));
        }
        return infos;
    }

    function getValidatorInfo(address _valAddr) public view returns (dt.ValidatorInfo memory) {
        (
            dt.ValidatorStatus status,
            address signer,
            uint256 tokens,
            uint256 shares,
            ,
            ,
            uint256 minSelfDelegation,
            ,
            ,
            uint64 commissionRate
        ) = staking.validators(_valAddr);
        return
            dt.ValidatorInfo({
                valAddr: _valAddr,
                status: status,
                signer: signer,
                tokens: tokens,
                shares: shares,
                minSelfDelegation: minSelfDelegation,
                commissionRate: commissionRate
            });
    }

    function getDelegatorInfos(address _delAddr) public view returns (dt.DelegatorInfo[] memory) {
        uint256 valNum = staking.getValidatorNum();
        dt.DelegatorInfo[] memory infos = new dt.DelegatorInfo[](valNum);
        uint32 num = 0;
        for (uint32 i = 0; i < valNum; i++) {
            address valAddr = staking.valAddrs(i);
            infos[i] = staking.getDelegatorInfo(valAddr, _delAddr);
            if (infos[i].shares != 0 || infos[i].undelegationTokens != 0) {
                num++;
            }
        }
        dt.DelegatorInfo[] memory res = new dt.DelegatorInfo[](num);
        uint32 j = 0;
        for (uint32 i = 0; i < valNum; i++) {
            if (infos[i].shares != 0 || infos[i].undelegationTokens != 0) {
                res[j] = infos[i];
                j++;
            }
        }
        return res;
    }

    function getDelegatorTokens(address _delAddr) public view returns (uint256, uint256) {
        dt.DelegatorInfo[] memory infos = getDelegatorInfos(_delAddr);
        uint256 tokens;
        uint256 undelegationTokens;
        for (uint32 i = 0; i < infos.length; i++) {
            tokens += infos[i].tokens;
            undelegationTokens += infos[i].undelegationTokens;
        }
        return (tokens, undelegationTokens);
    }

    /**
     * @notice Get the minimum staking pool of all bonded validators
     * @return the minimum staking pool of all bonded validators
     */
    function getMinValidatorTokens() public view returns (uint256) {
        uint256 bondedValNum = staking.getBondedValidatorNum();
        if (bondedValNum < staking.params(dt.ParamName.MaxBondedValidators)) {
            return 0;
        }
        uint256 minTokens = dt.MAX_INT;
        for (uint256 i = 0; i < bondedValNum; i++) {
            uint256 tokens = staking.getValidatorTokens(staking.bondedValAddrs(i));
            if (tokens < minTokens) {
                minTokens = tokens;
                if (minTokens == 0) {
                    return 0;
                }
            }
        }
        return minTokens;
    }

    function shouldBondValidator(address _valAddr) public view returns (bool) {
        (dt.ValidatorStatus status, , uint256 tokens, , , , , uint64 bondBlock, , ) = staking.validators(_valAddr);
        if (status == dt.ValidatorStatus.Null || status == dt.ValidatorStatus.Bonded) {
            return false;
        }
        if (block.number < bondBlock) {
            return false;
        }
        if (!staking.hasMinRequiredTokens(_valAddr, true)) {
            return false;
        }
        if (tokens <= getMinValidatorTokens()) {
            return false;
        }
        uint256 nextBondBlock = staking.nextBondBlock();
        if (block.number < nextBondBlock) {
            return false;
        }
        return true;
    }
}
