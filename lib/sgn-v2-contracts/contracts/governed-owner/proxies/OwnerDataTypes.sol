// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

library OwnerDataTypes {
    enum Action {
        Set,
        Add,
        Remove
    }

    enum MsgFeeType {
        PerByte,
        Base
    }

    enum BridgeType {
        Liquidity,
        PegBridge,
        PegVault,
        PegBridgeV2,
        PegVaultV2
    }
}
