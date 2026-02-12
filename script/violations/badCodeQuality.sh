#!/bin/bash

# VIOLATION: No usage/help text
# VIOLATION: No environment loading
# VIOLATION: No validation of required variables

NETWORK=$1
CONTRACT=$2

# VIOLATION: Inconsistent indentation
if [[ -z "$NETWORK" ]]; then
echo "Network required"
    exit 1
  fi

# VIOLATION: Inconsistent naming (camelCase vs snake_case)
contractAddress="0x123"
deployment_name="MyContract"
FACET_LIST=()

# VIOLATION: Unclear exit codes
if [[ -z "$CONTRACT" ]]; then
    exit 2  # What does 2 mean?
fi

# VIOLATION: No TODO/FIXME documentation
# TODO fix this later
broken_function() {
    echo "This doesn't work"
}

# VIOLATION: Magic numbers without explanation
sleep 5
timeout 120 some_command

# VIOLATION: Overly complex logic without breakdown
result=$(cast call "$CONTRACT" "getData()" | grep "0x" | cut -d' ' -f1 | tr -d '\n' | sed 's/^0x//')

# VIOLATION: No comments for complex regex/awk/sed
echo "$result" | awk '{print $3}' | sed 's/[^0-9]//g'

# VIOLATION: Inconsistent quoting style
echo 'Single quotes'
echo "Double quotes"
echo $UNQUOTED

# VIOLATION: No sourcing of helper functions
# Should source script/helperFunctions.sh and script/playgroundHelpers.sh

# VIOLATION: Not checking command availability
forge build  # What if forge is not installed?
jq '.networks' config.json  # What if jq is not installed?

# VIOLATION: Hardcoded paths
source /absolute/path/to/config.sh
cat ~/hardcoded/file.txt
