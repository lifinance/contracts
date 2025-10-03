// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InvalidSendingToken, InvalidAmount, InvalidReceiver, InvalidConfig, CannotBridgeToSameNetwork, InformationMismatch } from "lifi/Errors/GenericErrors.sol";

// Stub UnitFacet Contract
contract TestUnitFacet is UnitFacet {
    constructor(address _backendSigner) UnitFacet(_backendSigner) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract UnitFacetTest is TestBaseFacet {
    UnitFacet.UnitData internal validUnitData;
    TestUnitFacet internal unitFacet;

    // backend signer private key and address
    uint256 internal backendSignerPrivateKey =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress = vm.addr(backendSignerPrivateKey);
    address internal randomDepositAddress =
        0xCE50D8e79e047534627B3Bc38DE747426Ec63927;

    // unit node public key
    bytes internal unitNodePublicKey =
        hex"04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061";
    // h1 node public key
    bytes internal h1NodePublicKey =
        hex"048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b";
    // field node public key
    bytes internal fieldNodePublicKey =
        hex"04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99";

    // Constants for EIP-712
    // EIP-712 typehash for UnitPayload: keccak256("UnitPayload(bytes32 transactionId,uint256 minAmount,address receiver,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline)");
    // this is the same as the typehash in the UnitFacet contract
    bytes32 internal constant UNIT_PAYLOAD_TYPEHASH =
        0xe40c93b75fa097357b7b866c9d28e3dba6e987fba2808befeaafebac93b94cba;

    struct UnitPayload {
        bytes32 transactionId;
        uint256 minAmount;
        address receiver;
        address depositAddress;
        uint256 destinationChainId;
        address sendingAssetId;
        uint256 deadline;
    }

    error NotSupported();

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        unitFacet = new TestUnitFacet(backendSignerAddress);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = unitFacet.startBridgeTokensViaUnit.selector;
        functionSelectors[1] = unitFacet
            .swapAndStartBridgeTokensViaUnit
            .selector;
        functionSelectors[2] = unitFacet.addDex.selector;
        functionSelectors[3] = unitFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(unitFacet), functionSelectors);
        unitFacet = TestUnitFacet(address(diamond));
        // whitelist uniswap dex with function selectors
        unitFacet.addDex(address(uniswap));
        unitFacet.addDex(address(unitFacet));
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(unitFacet), "UnitFacet");

        // adjust bridgeData
        bridgeData.bridge = "unit";
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        bridgeData.sendingAssetId = LibAsset.NULL_ADDRESS;
        bridgeData.minAmount = 0.05 ether; // minimum amount is 0.05 ETH (5e16 wei) mentioned in https://docs.hyperunit.xyz/developers/api/generate-address

        validUnitData = _generateValidUnitData(
            randomDepositAddress,
            bridgeData,
            block.chainid
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
                bridgeData,
                validUnitData
            );
        } else {
            // not native tokens are not supported
            revert NotSupported();
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            unitFacet.swapAndStartBridgeTokensViaUnit{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validUnitData);
        } else {
            unitFacet.swapAndStartBridgeTokensViaUnit(
                bridgeData,
                swapData,
                validUnitData
            );
        }
    }

    function testRevert_ConstructorWithZeroBackendSigner() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestUnitFacet(address(0));
    }

    function testBase_CanBridgeTokens() public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testBase_CanBridgeTokens_fuzzed(
        uint256 amount
    ) public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testBase_CanSwapAndBridgeTokens() public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testRevert_CanNotBridgeERC20Tokens() public virtual {
        // facet does not support bridging ERC20 tokens
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        usdc.approve(address(unitFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidSendingToken.selector);
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            validUnitData
        );

        vm.stopPrank();
    }

    function testRevert_CanNotSwapAndBridgeERC20Tokens() public virtual {
        // facet does not support bridging ERC20 tokens
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        usdc.approve(address(unitFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidSendingToken.selector);
        unitFacet.swapAndStartBridgeTokensViaUnit{
            value: bridgeData.minAmount
        }(bridgeData, swapData, validUnitData);

        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens()
        public
        virtual
        override
        assertBalanceChange(address(0), USER_SENDER, -int256(0.05 ether))
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(unitFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset create swapData (300 DAI to native) - it has to be at least 0.05 ETH
        uint256 daiAmount = 300 * 10 ** dai.decimals();

        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, daiAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        validUnitData = _generateValidUnitData(
            randomDepositAddress,
            bridgeData,
            1
        );

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_Revert_BridgeToSameChainId() public virtual override {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = block.chainid;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidAmount()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // prepare bridgeData
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
        public
        virtual
        override
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);

        // execute call in child contract
        initiateBridgeTxWithFacet(true);
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        // the startBridgeTokensViaUnit can only be used for native tokens, therefore this test case is not applicable
    }

    function testBase_Revert_SwapAndBridgeWithInvalidSwapData()
        public
        override
    {
        // since the facets accesses the swapData parameter already before trying to execute the swap, we need to override the expected error message
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        delete swapData;

        vm.expectRevert();

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function test_CanSwapAndBridgeNativeTokens_fuzzed(uint256 amount) public {
        vm.assume(amount > 215 && amount < 100_000); // 215 a little bit above the minimum amount for a swap (0.05 ETH)
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset create swapData (300 DAI to native) - it has to be at least 0.05 ETH
        uint256 daiAmount = amount * 10 ** dai.decimals();

        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, daiAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        validUnitData = _generateValidUnitData(
            randomDepositAddress,
            bridgeData,
            1
        );

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testRevert_InvalidMinimumAmount() public {
        vm.startPrank(USER_SENDER);

        vm.chainId(1); // Set chain ID to ethereum
        // Set amount below minimum for ethereum (0.05 ETH)
        bridgeData.minAmount = 0.04 ether; // Below 0.05 ETH minimum
        // Regenerate signature for ethereum chain
        UnitFacet.UnitData memory unitData = _generateValidUnitData(
            randomDepositAddress,
            bridgeData,
            1
        );

        vm.expectRevert(InvalidAmount.selector);
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            unitData
        );

        vm.chainId(9745); // Set chain ID to plasma
        // Set amount below minimum for plasma (15 XPL)
        bridgeData.minAmount = 10 ether; // Below 15 XPL minimum
        // Regenerate signature for plasma chain
        unitData = _generateValidUnitData(
            randomDepositAddress,
            bridgeData,
            9745
        );

        vm.expectRevert(InvalidAmount.selector);
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            unitData
        );

        vm.stopPrank();
    }

    function testRevert_InvalidSignature() public {
        vm.startPrank(USER_SENDER);

        // Create a signature with a different private key (wrong signer)
        uint256 wrongPrivateKey = 0x9876543210987654321098765432109876543210987654321098765432109876;

        UnitPayload memory payload = _createUnitPayload(
            bridgeData,
            validUnitData.depositAddress,
            validUnitData.deadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(block.chainid);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory wrongSignature = _signDigest(wrongPrivateKey, digest);

        UnitFacet.UnitData memory invalidUnitData = UnitFacet.UnitData({
            depositAddress: validUnitData.depositAddress,
            signature: wrongSignature, // Valid signature format but from wrong signer
            deadline: validUnitData.deadline
        });

        vm.expectRevert(UnitFacet.InvalidSignature.selector);
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            invalidUnitData
        );

        vm.stopPrank();
    }

    function testRevert_SignatureExpired() public {
        vm.startPrank(USER_SENDER);

        // Create unit data with expired deadline
        uint256 expiredDeadline = block.timestamp - 1 hours; // Past deadline

        UnitPayload memory payload = _createUnitPayload(
            bridgeData,
            randomDepositAddress,
            expiredDeadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(block.chainid);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        UnitFacet.UnitData memory expiredUnitData = UnitFacet.UnitData({
            depositAddress: randomDepositAddress,
            signature: signature,
            deadline: expiredDeadline
        });

        vm.expectRevert(UnitFacet.SignatureExpired.selector);
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            expiredUnitData
        );

        vm.stopPrank();
    }

    // ============ EIP-712 Helper Functions ============

    /// @dev Builds the EIP-712 domain separator for the Unit facet
    /// @param _chainId The chain ID to use in the domain separator
    /// @return The computed domain separator hash
    function _buildDomainSeparator(
        uint256 _chainId
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI Unit Facet")),
                    keccak256(bytes("1")),
                    _chainId,
                    address(unitFacet)
                )
            );
    }

    /// @dev Creates a UnitPayload struct from bridge data and additional parameters
    /// @param _bridgeData The bridge data containing transaction details
    /// @param _depositAddress The deposit address for the unit transaction
    /// @param _deadline The deadline for the transaction
    /// @return The constructed UnitPayload struct
    function _createUnitPayload(
        ILiFi.BridgeData memory _bridgeData,
        address _depositAddress,
        uint256 _deadline
    ) internal pure returns (UnitPayload memory) {
        return
            UnitPayload({
                transactionId: _bridgeData.transactionId,
                minAmount: _bridgeData.minAmount,
                receiver: _bridgeData.receiver,
                depositAddress: _depositAddress,
                destinationChainId: _bridgeData.destinationChainId,
                sendingAssetId: _bridgeData.sendingAssetId,
                deadline: _deadline
            });
    }

    /// @dev Builds the struct hash for the UnitPayload
    /// @param _payload The UnitPayload to hash
    /// @return The computed struct hash
    function _buildStructHash(
        UnitPayload memory _payload
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    UNIT_PAYLOAD_TYPEHASH,
                    _payload.transactionId,
                    _payload.minAmount,
                    _payload.receiver,
                    _payload.depositAddress,
                    _payload.destinationChainId,
                    _payload.sendingAssetId,
                    _payload.deadline
                )
            );
    }

    /// @dev Builds the final EIP-712 digest from domain separator and struct hash
    /// @param _domainSeparator The domain separator hash
    /// @param _structHash The struct hash
    /// @return The computed digest ready for signing
    function _buildDigest(
        bytes32 _domainSeparator,
        bytes32 _structHash
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparator, _structHash)
            );
    }

    /// @dev Signs a digest with the given private key
    /// @param _privateKey The private key to sign with
    /// @param _digest The digest to sign
    /// @return The signature bytes (r, s, v format)
    function _signDigest(
        uint256 _privateKey,
        bytes32 _digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_privateKey, _digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Helper function to generate valid unit data for a given chain and bridge data.
    /// @param _depositAddress The deposit address for the unit transaction
    /// @param _currentBridgeData The bridge data containing transaction details
    /// @param _chainId The source chain ID
    /// @return The generated valid unit data
    function _generateValidUnitData(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId
    ) internal view returns (UnitFacet.UnitData memory) {
        uint256 deadline = block.timestamp + 0.1 hours;

        UnitPayload memory payload = _createUnitPayload(
            _currentBridgeData,
            _depositAddress,
            deadline
        );

        bytes32 domainSeparator = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        return
            UnitFacet.UnitData({
                depositAddress: _depositAddress,
                deadline: deadline,
                signature: signature
            });
    }
}
