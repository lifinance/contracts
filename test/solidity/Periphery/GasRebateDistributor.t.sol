// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { Test, stdJson } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { GasRebateDistributor } from "lifi/Periphery/GasRebateDistributor.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";

contract GasRebateDistributorTest is Test {
    using stdJson for string;
    bytes32 public constant MERKLE_ROOT =
        // hex"48610c6988ab1e1abe0a8726194432e735609c50ffbc4f35c0a176e95f1c67d7";
        hex"b1a3e69afbb24ad2239e09935fdec19313f8b4b914e9a0cb8d956dab28464f0b";

    address public constant ADDRES_USDC_ETH =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant VALID_CLAIMER_1 =
        0x29DaCdF7cCaDf4eE67c923b4C22255A4B2494eD7;
    address public constant VALID_CLAIMER_2 =
        0x4577a46A3eCf44E0ed44410B7793977ffbe22CE0;
    address public constant INVALID_CLAIMER =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    GasRebateDistributor public distributor;
    ERC20 public usdc;

    struct ClaimWithProof {
        address account;
        uint256 amount;
        bytes32[] merkleProof;
    }

    struct NetworkClaims {
        bytes32 merkleRoot;
        ClaimWithProof[] claims;
    }

    function setUp() public {
        // activate mainnet fork
        _fork();

        usdc = ERC20(ADDRES_USDC_ETH);

        // deploy contract
        address owner = address(this);
        uint256 deadline = block.timestamp + 1000;
        distributor = new GasRebateDistributor(
            owner,
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
    }

    function _fork() private {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 14847528;

        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function _getClaims() private view returns (NetworkClaims memory claims) {
        console.log("AA");

        // parse JSON with merkle roots / proofs
        string memory path = string.concat(
            vm.projectRoot(),
            "/script/output/outputMerkleProofsUINT.json"
        );
        console.log("BB");
        string memory json = vm.readFile(path);

        console.log("CC");
        bytes memory rawConfig = json.parseRaw(string.concat(".mainnet"));
        console.log("DD");
        claims = abi.decode(rawConfig, (NetworkClaims));
        console.log("EE");
    }

    function _getMerkleProof(
        address account,
        uint256 amount
    ) private view returns (bytes32[] memory merkleProof) {
        console.log("A");
        ClaimWithProof[] memory accounts = _getClaims().claims;

        console.log("B");
        // iterate over all claims and find the matching one
        for (uint i; i < accounts.length; i++) {
            console.log(i);
            if (accounts[i].account == account && accounts[i].amount == amount)
                merkleProof = accounts[i].merkleProof;
        }
    }

    function test_distributesNativeRewardsWithValidProof() public {
        vm.startPrank(VALID_CLAIMER_1);

        // get initial native balance
        uint256 initialBalance = usdc.balanceOf(VALID_CLAIMER_1);

        uint256 nativeClaimAmount = 8000000;

        // get merkle proof from input file
        // bytes32[] memory merkleProof = _getMerkleProof(
        //     VALID_CLAIMER_1,
        //     nativeClaimAmount
        // );

        bytes32[] memory merkleProof = new bytes32[](1);
        merkleProof[
            0
        ] = hex"8b795aba0c0dd676e6e109be0785907973939d81e185eebcf81ec130feda059e";

        // call distributor contract
        distributor.claim(nativeClaimAmount, merkleProof);

        // check final balance
        uint256 finalBalance = usdc.balanceOf(VALID_CLAIMER_1);
        assertEq(initialBalance + nativeClaimAmount, finalBalance);
    }
}
