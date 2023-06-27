#!/bin/bash


# TODO
# - test helper function confirmOwnershipTransfer
# - test ownership transfer for periphery with actual wallets

diamondMakeImmutable() {
  # load env variables
	source .env

  # load config & helper functions
  source script/helperFunctions.sh

  # read function arguments into variables
  # the first parameter is unused/empty
  ENVIRONMENT="$2"
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  checkRequiredVariablesInDotEnv $NETWORK

  # define path of JSON file to get diamond address from
	ADDRS="deployments/$NETWORK.${FILE_SUFFIX}json"

  # get diamond address from path (finds any key that contains "LiFiDiamondImmutable"
	DIAMOND_ADDRESS=$(jq -r '.LiFiDiamondImmutable' "$ADDRS")

	# check if all required env variables have values
	if [[ -z "$PRIVATE_KEY_REFUND_WALLET" || -z "$PRIVATE_KEY_WITHDRAW_WALLET" ]]; then
	  error "your .env file is missing either PRIVATE_KEY_REFUND_WALLET or PRIVATE_KEY_WITHDRAW_WALLET values. Script cannot continue."
	  exit 1
  fi


  gum style \
  --foreground 212 --border-foreground 213 --border double \
  --align center --width 50 --margin "1 2" --padding "2 4" \
  '!!! ATTENTION !!!'

  echo "Please check that this is the correct diamond address: $DIAMOND_ADDRESS"
  echo "If you confirm the next prompt, this diamond will be made immutable"
  echo "Please check if you have added all necessary facets"
  echo "Once this script is completed, it is irreversible and the contract cannot be altered in any way"
  echo "    "
  echo "Last chance: Do you want to abort?"
  gum confirm && exit 1 || echo "OK, let's do it"



  #---------------------------------------------------------------------------------------------------------------------
  echo "PART 1 - TRANSFER OWNERSHIP OF PERIPHERY CONTRACTS"
	attempts=1

  while [ $attempts -lt 11 ]
  do
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>> Trying to transfer ownership of periphery contracts now - attempt ${attempts}"
    # try to execute call
    RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script script/tasks/solidity/transferOwnershipOfPeripheryContractsForImmutable.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
    RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      # try to extract error message and throw error
      ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
      if [[ $ERROR_MESSAGE == "" ]]; then
        error "execution of script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "execution of script failed with message: $ERROR_MESSAGE"
      fi

    # check the return code the last call
    elif [[ $RETURN_CODE -eq 0 && $RAW_RETURN_DATA != *"\"returns\":{}"* ]]; then
      break  # exit the loop if the operation was successful
    fi

    attempts=$((attempts+1))  # increment attempts
    sleep 1  # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]
  then
      echo "Failed to transfer ownership of periphery contracts"
      exit 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<< periphery ownership transferred/initiated"
  echo ""
  echo ""

  #---------------------------------------------------------------------------------------------------------------------
  echo "PART 2 - SETTER FUNCTION REMOVAL IN FACETS"
  # remove all function selectors that will be unusable in the immutable diamond
  attempts=1
  while [ $attempts -lt 11 ]
  do
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>> Trying to remove unusable function selectors from (pre-)immutable diamond ($DIAMOND_ADDRESS) now - attempt ${attempts}"
    # try to execute call
    RAW_RETURN_DATA=$(NETWORK=$NETWORK SALT="" FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") NO_BROADCAST=false forge script script/tasks/solidity/RemoveUnusableSelectorsFromImmutableDiamond.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
    RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      # try to extract error message and throw error
      ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
      if [[ $ERROR_MESSAGE == "" ]]; then
        error "execution of script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "execution of script failed with message: $ERROR_MESSAGE"
      fi

    # check the return code the last call
    elif [ $RETURN_CODE -eq 0 ]; then
      break  # exit the loop if the operation was successful
    fi

    attempts=$((attempts+1))  # increment attempts
    sleep 1  # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]
  then
      echo "Failed to remove selectors from (pre-)immutable diamond $DIAMOND_ADDRESS"
      exit 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<< function selectors removed"
  echo ""
  echo ""
  #---------------------------------------------------------------------------------------------------------------------
  echo "PART 3 - TRANSFER DIAMOND OWNERSHIP & REMOVE DIAMONDCUT FACET"
	# execute selected script
	attempts=1

  while [ $attempts -lt 11 ]
  do
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>> Trying to remove DiamondCutFacet from diamond $DIAMOND_ADDRESS and transfer ownership to address(0) now - attempt ${attempts}"
    # try to execute call
    RAW_RETURN_DATA=$(NETWORK=$NETWORK SALT="" FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") NO_BROADCAST=false forge script script/tasks/solidity/MakeLiFiDiamondImmutable.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
    RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      # try to extract error message and throw error
      ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
      if [[ $ERROR_MESSAGE == "" ]]; then
        error "execution of script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "execution of script failed with message: $ERROR_MESSAGE"
      fi

    # check the return code the last call
    elif [[ $RETURN_CODE -eq 0 && $RAW_RETURN_DATA != *"\"returns\":{}"* ]]; then
      break  # exit the loop if the operation was successful
    fi

    attempts=$((attempts+1))  # increment attempts
    sleep 1  # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]
  then
      echo "Failed to make $DIAMOND_ADDRESS immutable"
      exit 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<< diamondCutFacet removed and ownership transferred to address(0)"
  echo ""
  echo ""

#  #---------------------------------------------------------------------------------------------------------------------
  echo "PART 4 - ACCEPT PERIPHERY OWNERSHIP TRANSFERS TO REFUND_WALLET / WITHDRAW_WALLET, IF NEEDED"
  # get refund_wallet and withdraw_wallet addresses
  REFUND_WALLET_ADDRESS=$(getValueFromJSONFile "config/global.json" "refundWallet")
  WITHDRAW_WALLET_ADDRESS=$(getValueFromJSONFile "config/global.json" "withdrawWallet")

  # check ownership status and confirm ownership transfer, if necessary
  echo "[info] now checking ownership of FeeCollector"
  ADDRESS_OWNER=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "FeeCollector");
  if ! compareAddresses "$ADDRESS_OWNER" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
    ADDRESS_PENDING_OWNER=$(getPendingContractOwner "$NETWORK" "$ENVIRONMENT" "FeeCollector");
    if ! compareAddresses "$ADDRESS_PENDING_OWNER" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
      error "FeeCollector ownership transfer to withdrawWallet was not correctly registered"
      exit 1
    else
      confirmOwnershipTransfer "$ADDRESS" "$NETWORK" "$PRIVATE_KEY_WITHDRAW_WALLET"
      if [[ $? -ne 0 ]]; then
        error "ownership transfer of FeeCollector could not be confirmed"
      fi
    fi
  fi
  echo "[info] ownership of FeeCollector is correct (withdrawWallet: $WITHDRAW_WALLET_ADDRESS)"


  echo "[info] now checking ownership of Receiver"
  ADDRESS_OWNER=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "Receiver");
  if ! compareAddresses "$ADDRESS_OWNER" "$REFUND_WALLET_ADDRESS" >/dev/null; then
    ADDRESS_PENDING_OWNER=$(getPendingContractOwner "$NETWORK" "$ENVIRONMENT" "Receiver");
    if ! compareAddresses "$ADDRESS_PENDING_OWNER" "$REFUND_WALLET_ADDRESS" >/dev/null; then
      error "Receiver ownership transfer to refundWallet was not correctly initiated"
      exit 1
    else
      confirmOwnershipTransfer "$ADDRESS" "$NETWORK" "$PRIVATE_KEY_REFUND_WALLET"
      if [[ $? -ne 0 ]]; then
        error "ownership transfer of Receiver could not be confirmed"
      fi
    fi
  fi
  echo "[info] ownership of Receiver is correct (refundWallet: $REFUND_WALLET_ADDRESS)"


  # RelayerCelerIM
  # check first if RelayerCelerIM is registered in this diamond
  getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "LiFiDiamondImmutable" "RelayerCelerIM"
  if [[ $? -eq 0 ]]; then
    echo "[info] now checking ownership of RelayerCelerIM"
    # RelayerCelerIM is registered
    # get current owner and check if it matches with refundWallet address
    ADDRESS_OWNER=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "RelayerCelerIM");
    if ! compareAddresses "$ADDRESS_OWNER" "$REFUND_WALLET_ADDRESS" >/dev/null; then
      # owner is not refundWallet
      # get current pending owner and check if it matches with refundWallet address
      ADDRESS_PENDING_OWNER=$(getPendingContractOwner "$NETWORK" "$ENVIRONMENT" "RelayerCelerIM");
      if ! compareAddresses "ADDRESS_PENDING_OWNER" "$REFUND_WALLET_ADDRESS" >/dev/null; then
        error "RelayerCelerIM ownership transfer to refundWallet was not correctly initiated"
        exit 1
      else
        confirmOwnershipTransfer "$ADDRESS" "$NETWORK" "$PRIVATE_KEY_REFUND_WALLET"
        if [[ $? -ne 0 ]]; then
          error "ownership transfer of RelayerCelerIM could not be confirmed"
          exit 1
        fi
      fi
    fi
    echo "[info] ownership of RelayerCelerIM is correct (refundWallet: $REFUND_WALLET_ADDRESS)"
  fi

  # ServiceFeeCollector
  echo "[info] now checking ownership of ServiceFeeCollector"
  ADDRESS_OWNER=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "ServiceFeeCollector");
  if ! compareAddresses "$ADDRESS_OWNER" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
    ADDRESS_PENDING_OWNER=$(getPendingContractOwner "$NETWORK" "$ENVIRONMENT" "ServiceFeeCollector");
    if ! compareAddresses "$ADDRESS_PENDING_OWNER" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
      error "ServiceFeeCollector ownership transfer to withdrawWallet was not correctly initiated"
      exit 1
    else
      confirmOwnershipTransfer "$ADDRESS" "$NETWORK" "$PRIVATE_KEY_WITHDRAW_WALLET"
      if [[ $? -ne 0 ]]; then
        error "ownership transfer of ServiceFeeCollector could not be confirmed"
      fi
    fi
  fi
  echo "[info] ownership of ServiceFeeCollector is correct (withdrawWallet: $WITHDRAW_WALLET_ADDRESS)"
  echo ""
  echo ""


  #---------------------------------------------------------------------------------------------------------------------
  echo "PART 5 - CONDUCT SOME CHECKS FURTHER CHECKS TO ENSURE CORRECT SCRIPT EXECUTION"
  # check ownership of periphery contracts
  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "ERC20Proxy");
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "ERC20Proxy ownership was not transferred to address(0). Script cannot continue."
    exit 1
  else
    echo "[info] ERC20Proxy ownership correct (ZERO_ADDRESS)"
  fi

  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "FeeCollector");
  if ! compareAddresses "$ADDRESS" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
    error "FeeCollector ownership was not transferred to withdrawWallet. Script cannot continue."
    exit 1
  fi

  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "Receiver");
  if ! compareAddresses "$ADDRESS" "$REFUND_WALLET_ADDRESS" >/dev/null; then
    error "Receiver ownership was not transferred to refundWallet. Script cannot continue."
    exit 1
  fi

  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "ServiceFeeCollector");
  if ! compareAddresses "$ADDRESS" "$WITHDRAW_WALLET_ADDRESS" >/dev/null; then
    error "ServiceFeeCollector ownership was not transferred to withdrawWallet. Script cannot continue."
    exit 1
  fi

  # check if (some) function selectors are still available in diamond that should have been removed
  # check if AccessManagerFacet.setCanExecute facet was removed
  SELECTOR=$(getFunctionSelectorFromContractABI "AccessManagerFacet" "setCanExecute")
  ADDRESS=$(getFacetAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$SELECTOR")
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "function AccessManagerFacet.setCanExecute was not removed from diamond with address $DIAMOND_ADDRESS. Script cannot continue."
    exit 1
  else
    echo "[info] function selector AccessManagerFacet.setCanExecute was correctly removed"
  fi

  # check if OwnershipFacet.transferOwnership facet was removed
  SELECTOR=$(getFunctionSelectorFromContractABI "OwnershipFacet" "transferOwnership")
  ADDRESS=$(getFacetAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$SELECTOR")
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "function OwnershipFacet.transferOwnership was not removed from diamond with address $DIAMOND_ADDRESS. Script cannot continue."
    exit 1
  else
    echo "[info] function selector OwnershipFacet.transferOwnership was correctly removed"
  fi

  # check if WithdrawFacet.executeCallAndWithdraw facet was removed
  SELECTOR=$(getFunctionSelectorFromContractABI "WithdrawFacet" "executeCallAndWithdraw")
  ADDRESS=$(getFacetAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$SELECTOR")
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "function WithdrawFacet.executeCallAndWithdraw was not removed from diamond with address $DIAMOND_ADDRESS. Script cannot continue."
    exit 1
  else
    echo "[info] function selector WithdrawFacet.executeCallAndWithdraw was correctly removed"
  fi

  # check if diamondCut facet was removed
  SELECTOR_DIAMOND_CUT=$(getFunctionSelectorFromContractABI "DiamondCutFacet" "diamondCut")
  ADDRESS=$(getFacetAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$SELECTOR_DIAMOND_CUT")
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "function diamondCut was not removed from diamond with address $DIAMOND_ADDRESS. Script cannot continue."
    exit 1
  else
    echo "[info] function selector DiamondCutFacet.diamondCut was correctly removed"
  fi

  # check owner of diamond
  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "LiFiDiamondImmutable");
  if ! compareAddresses "$ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
    error "LiFiDiamondImmutable ownership was not transferred to address(0). Script cannot continue."
    exit 1
  else
    echo "[info] diamond owner is address(0)"
  fi

  echo ""
  echo "ALL CHECKS PASSED :)"

  echo ""
  echo ""
  echo ""
  echo "The diamond contract on network $NETWORK with address $DIAMOND_ADDRESS is now immutable"
}



