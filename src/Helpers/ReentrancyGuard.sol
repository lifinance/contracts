// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;

abstract contract ReentrancyGuard {
    bytes32 private constant NAMESPACE = hex"a65bb2f450488ab0858c00edc14abc5297769bf42adb48cfb77752890e8b697b";

    struct ReentrancyStorage {
        uint256 status;
    }

    error ReentrancyError();

    uint256 private constant _NOT_ENTERED = 0;
    uint256 private constant _ENTERED = 1;

    modifier nonReentrant() {
        ReentrancyStorage storage s = reentrancyStorage();
        if (s.status == _ENTERED) revert ReentrancyError();
        s.status = _ENTERED;
        _;
        s.status = _NOT_ENTERED;
    }

    function reentrancyStorage() private pure returns (ReentrancyStorage storage data) {
        bytes32 position = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            data.slot := position
        }
    }
}
