#!/bin/bash

updateFacetConfig() {
  # load deploy script & helper functions
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  # read function arguments into variables
  ENVIRONMENT="$2"
  SCRIPT="$4"
  DIAMOND_CONTRACT_NAME="$5"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$3" ]]; then
      # get user-selected network from list
      echo "Select Networks"
      if command -v gum >/dev/null 2>&1; then
          checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
          # Read the networks into an array, works on both Mac and Linux
          IFS=$'\n' read -r -d '' -a NETWORKS < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum choose --no-limit)

          if [[ ${#NETWORKS[@]} -eq 0 ]]; then
              error "No networks selected - exiting script"
              exit 1
          fi
          echo "[info] selected networks: ${NETWORKS[*]}"
      else
          error "gum is not installed"
          exit 1
      fi
  else
      NETWORKS=("$3")
  fi

    # if no SCRIPT was passed to this function, ask user to select it
  if [[ -z "$SCRIPT" ]]; then
    # select which script to execute
    local SCRIPT=$(ls -1 "$CONFIG_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | gum filter --placeholder "Please select a script to execute")
    echo "[info] selected script: $SCRIPT"
  fi

  # determine full (relative) path of deploy script
  SCRIPT_PATH=$CONFIG_SCRIPT_DIRECTORY"$SCRIPT.s.sol"

  DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND="true"

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # initialize failure flag
  FAILED=0

  # make sure GAS_ESTIMATE_MULTIPLIER is set
  if [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]]; then
    GAS_ESTIMATE_MULTIPLIER=130 # this is foundry's default value
  fi

  echoDebug "GAS_ESTIMATE_MULTIPLIER=$GAS_ESTIMATE_MULTIPLIER (default value: 130, set in .env for example to 200 for doubling Foundry's estimate)"

  for NETWORK in "${NETWORKS[@]}"; do
    # get deployer wallet balance
    echo "[info] loading deployer wallet balance for network $NETWORK..."
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""

    # ensure all required .env values are set
    checkRequiredVariablesInDotEnv "$NETWORK"


    # repeatedly call selected script until it's succeeded or out of attempts
    ATTEMPTS=1
    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      echo "[info] now executing $SCRIPT on $DIAMOND_CONTRACT_NAME in $ENVIRONMENT environment on $NETWORK (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

      # Add skip simulation flag based on environment variable
      SKIP_SIMULATION_FLAG=$(getSkipSimulationFlag)

      # Create temporary files to capture stdout and stderr separately
      # This ensures we can extract JSON from stdout while keeping stderr logs for debugging
      STDOUT_LOG=$(mktemp)
      STDERR_LOG=$(mktemp)
      trap "rm -f '$STDOUT_LOG' '$STDERR_LOG'" EXIT
      
      # Execute forge script with separate stdout/stderr redirection
      NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f "$NETWORK" --json --broadcast --legacy "$SKIP_SIMULATION_FLAG" --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER" >"$STDOUT_LOG" 2>"$STDERR_LOG"
      RETURN_CODE=$?
      
      # Read stdout (should contain JSON) and stderr (warnings/errors) separately
      RAW_RETURN_DATA=$(cat "$STDOUT_LOG" 2>/dev/null || echo "")
      STDERR_CONTENT=$(cat "$STDERR_LOG" 2>/dev/null || echo "")
      
      # Debug: Show what we captured
      echoDebug "=== RAW_RETURN_DATA (stdout, first 1000 chars) ==="
      echoDebug "${RAW_RETURN_DATA:0:1000}"
      echoDebug "=== STDERR logs (first 500 chars) ==="
      echoDebug "${STDERR_CONTENT:0:500}"
      
      # Extract JSON from RAW_RETURN_DATA (it should already be JSON when using --json)
      # Try to find JSON object with "logs" key
      if ! echo "$RAW_RETURN_DATA" | jq empty 2>/dev/null; then
        # If not valid JSON, try to extract JSON object
        RAW_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | grep -o '{"logs":.*}' | head -1)
        if [[ -z "$RAW_RETURN_DATA" ]] || ! echo "$RAW_RETURN_DATA" | jq empty 2>/dev/null; then
          RAW_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | jq -c 'if type=="object" and has("logs") then . else empty end' 2>/dev/null | head -1)
        fi
      fi
      
      # Clean up temporary files
      rm -f "$STDOUT_LOG" "$STDERR_LOG"
      trap - EXIT
      
      echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"
      # exit the loop if the operation was successful
      if [ "$RETURN_CODE" -eq 0 ]; then
        break
      fi

      ATTEMPTS=$(($ATTEMPTS + 1)) # increment attempts
      sleep 1                    # wait for 1 second before trying the operation again
    done

    # check if call was executed successfully or used all attempts
    if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
      error "failed to execute $SCRIPT on $DIAMOND_CONTRACT_NAME in $ENVIRONMENT environment on $NETWORK"
      FAILED=1
      continue
    else
      echo "[info] script executed successfully"
    fi
  done

  # check if any network failed and exit with appropriate status
  if [ $FAILED -eq 1 ]; then
    error "one or more networks failed during execution"
    exit 1
  fi
}


