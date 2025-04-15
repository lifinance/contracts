// SPDX-License-Identifier: Unlicensed
pragma solidity ^0.8.17;

import { Test, stdJson } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { GasRebateDistributor } from "lifi/Periphery/GasRebateDistributor.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract GasRebateDistributorTest is Test {
    using stdJson for string;
    bytes32 public constant MERKLE_ROOT =
        hex"b1a3e69afbb24ad2239e09935fdec19313f8b4b914e9a0cb8d956dab28464f0b"; // [pre-commit-checker: not a secret]
    bytes32 public constant MERKLE_ROOT_2 =
        hex"36fe7f7f4ab9cb7c2a36293cbe1d37aca4d8021b6f87ef8b518d34475c891919"; // [pre-commit-checker: not a secret]

    address public constant ADDRES_USDC_ETH =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant ADDRES_USDT_ETH =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address public constant VALID_CLAIMER_1 =
        0x29DaCdF7cCaDf4eE67c923b4C22255A4B2494eD7;
    address public constant VALID_CLAIMER_2 =
        0x4577a46A3eCf44E0ed44410B7793977ffbe22CE0;

    GasRebateDistributor public distributor;
    ERC20 public usdc;
    ERC20 public usdt;
    uint256 public deadline;
    address public contractOwner;

    struct ClaimWithProof {
        address account;
        uint256 amount;
        bytes32[] merkleProof;
    }

    struct NetworkClaims {
        bytes32 merkleRoot;
        ClaimWithProof[] claims;
    }

    event Claimed(address indexed account, uint256 amount);

    error AlreadyClaimed();
    error InvalidProof();
    error ClaimDeadlineExpired();

    function setUp() public {
        // activate mainnet fork
        _fork();

        contractOwner = address(this);

        usdc = ERC20(ADDRES_USDC_ETH);
        usdt = ERC20(ADDRES_USDT_ETH);

        // deploy contract
        deadline = block.timestamp + 1000;
        distributor = new GasRebateDistributor(
            contractOwner,
            MERKLE_ROOT,
            deadline,
            ADDRES_USDC_ETH
        );

        // fund contract with 100000 USDC
        deal(
            ADDRES_USDC_ETH,
            address(distributor),
            100000 * 10 ** usdc.decimals()
        );
        // fund contract with 100000 USDT
        deal(
            ADDRES_USDT_ETH,
            address(distributor),
            100000 * 10 ** usdt.decimals()
        );
    }

    function _fork() private {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 14847528;

        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function _getValidMerkleProofClaimer1()
        private
        pure
        returns (bytes32[] memory merkleProof)
    {
        merkleProof = new bytes32[](1);
        merkleProof[
            0
        ] = hex"8b795aba0c0dd676e6e109be0785907973939d81e185eebcf81ec130feda059e"; // [pre-commit-checker: not a secret]
    }

    /// Tests for function claim() ///

    function test_distributesFundsWithValidProof() public {
        vm.startPrank(VALID_CLAIMER_1);
        uint256 claimAmount = 8000000;

        // get initial balance
        uint256 initialBalance = usdc.balanceOf(VALID_CLAIMER_1);

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectEmit(true, true, true, true, address(distributor));
        emit Claimed(VALID_CLAIMER_1, claimAmount);

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);

        // check final balance
        uint256 finalBalance = usdc.balanceOf(VALID_CLAIMER_1);
        assertEq(initialBalance + claimAmount, finalBalance);
    }

    function test_canClaimAgainAfterMerkleRootWasUpdatedWithNewToken() public {
        // claim
        test_distributesFundsWithValidProof();

        // update merkle root
        test_ownerCanUpdateMerkleRoot();

        // claim new rebates based on updated merkle tree
        vm.startPrank(VALID_CLAIMER_1);
        uint256 claimAmount = 2500000;

        // get initial balance
        uint256 initialBalance = usdt.balanceOf(VALID_CLAIMER_1);

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();
        merkleProof[
            0
        ] = hex"fa4a9a72daea98757e27bd57e7ef6bca5177b8adddc97b6c8de1cbd20ad6059f"; // valid proof to claim 2.5 USDT  // [pre-commit-checker: not a secret]

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);

        // check final balance
        uint256 finalBalance = usdt.balanceOf(VALID_CLAIMER_1);
        assertEq(initialBalance + claimAmount, finalBalance);
    }

    function test_revert_cannotClaimTwice() public {
        // claim once
        test_distributesFundsWithValidProof();

        vm.startPrank(VALID_CLAIMER_1);
        uint256 claimAmount = 8000000;

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectRevert(AlreadyClaimed.selector);

        // try to claim for a second timeaq
        distributor.claim(claimAmount, merkleProof);
    }

    function test_revert_cannotClaimAfterDeadlineExpired() public {
        vm.startPrank(VALID_CLAIMER_1);
        uint256 claimAmount = 8000000;

        vm.warp(deadline + 1);

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectRevert(ClaimDeadlineExpired.selector);

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);
    }

    function test_revert_cannotClaimMoreThanAllowedWithValidProof() public {
        vm.startPrank(VALID_CLAIMER_1);
        uint256 claimAmount = 8000000;

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectRevert(InvalidProof.selector);

        // call distributor contract
        distributor.claim(claimAmount + 1, merkleProof);
    }

    function test_revert_cannotClaimWithValidProofForOtherWallet() public {
        vm.startPrank(VALID_CLAIMER_2);
        uint256 claimAmount = 8000000;

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectRevert(InvalidProof.selector);

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);

        // try the same with the amount that valid claimer 2 is permitted to claim (but using proof of claimer 1)
        claimAmount = 2500000;

        vm.expectRevert(InvalidProof.selector);

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);
    }

    function test_revert_cannotClaimWhenContractIsPaused() public {
        // pause contract
        vm.startPrank(contractOwner);
        distributor.pauseContract();

        assertEq(distributor.paused(), true);

        // try to claim
        uint256 claimAmount = 8000000;

        // get merkle proof
        bytes32[] memory merkleProof = _getValidMerkleProofClaimer1();

        vm.expectRevert("Pausable: paused");

        // call distributor contract
        distributor.claim(claimAmount, merkleProof);
    }

    /// Tests for function withdrawUnclaimed() ///
    function test_ownerCanWithdrawUnclaimed() public {
        vm.startPrank(contractOwner);

        uint256 initialBalanceDistributor = usdc.balanceOf(
            address(distributor)
        );
        uint256 initialBalanceTestContract = usdc.balanceOf(contractOwner);

        address[] memory addresses = new address[](1);
        addresses[0] = ADDRES_USDC_ETH;

        distributor.withdrawUnclaimed(addresses, contractOwner);

        assertEq(
            usdc.balanceOf(contractOwner),
            initialBalanceTestContract + initialBalanceDistributor
        );
    }

    function test_revert_nonOwnerCannotWithdrawUnclaimed() public {
        vm.startPrank(VALID_CLAIMER_1);

        address[] memory addresses = new address[](1);
        addresses[0] = ADDRES_USDC_ETH;

        vm.expectRevert(UnAuthorized.selector);

        distributor.withdrawUnclaimed(addresses, contractOwner);
    }

    function test_revert_cannotWithdrawWhenContractIsPaused() public {
        // pause contract
        vm.startPrank(contractOwner);
        distributor.pauseContract();

        assertEq(distributor.paused(), true);

        // prepare arguments (try to withdraw all USDC balance)
        address[] memory addresses = new address[](1);
        addresses[0] = ADDRES_USDC_ETH;

        // try to withdraw
        vm.expectRevert("Pausable: paused");
        distributor.withdrawUnclaimed(addresses, contractOwner);
    }

    /// Tests for function updateMerkleRoot() ///

    function test_ownerCanUpdateMerkleRoot() public {
        vm.startPrank(contractOwner);

        uint256 newDeadline = block.timestamp + 5000;

        distributor.updateMerkleRoot(
            MERKLE_ROOT_2,
            newDeadline,
            ADDRES_USDT_ETH
        );

        assertEq(distributor.merkleRoot(), MERKLE_ROOT_2);
        assertEq(distributor.claimDeadline(), newDeadline);
        assertEq(distributor.tokenAddress(), ADDRES_USDT_ETH);

        vm.stopPrank();
    }

    function test_revert_nonOwnerCannotUpdateMerkleRoot() public {
        vm.startPrank(VALID_CLAIMER_1);

        uint256 newDeadline = block.timestamp + 5000;

        vm.expectRevert(UnAuthorized.selector);

        distributor.updateMerkleRoot(
            MERKLE_ROOT_2,
            newDeadline,
            ADDRES_USDT_ETH
        );
    }

    function test_revert_ownerCanUnpauseContract() public {
        // pause contract
        vm.startPrank(contractOwner);
        distributor.pauseContract();

        assertEq(distributor.paused(), true);

        // unpause contract
        distributor.unpauseContract();

        assertEq(distributor.paused(), false);
    }
}
