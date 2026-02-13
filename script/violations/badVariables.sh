#!/bin/bash

# VIOLATION: Variables not in UPPERCASE
myNetwork="ethereum"
contractAddr="0xABC"

# VIOLATION: Unquoted variable expansion
echo Contract is $contractAddr

# VIOLATION: Unsafe variable expansion without ${VAR:-}
set -u  # This would fail
echo $UNDEFINED_VARIABLE

# VIOLATION: Using $ARRAY[@] instead of ${ARRAY[@]:-}
CONTRACTS=(Diamond Executor)
echo ${CONTRACTS[@]}  # Should be ${CONTRACTS[@]:-}

# VIOLATION: Not checking array length before access
echo "First contract: ${CONTRACTS[0]}"  # Should check ${#CONTRACTS[@]} first

# VIOLATION: Mixed case variables
DeploymentAddress="0x123"
deployment_name="MyContract"

# VIOLATION: No quotes around variables with spaces
FILE_PATH="/path/with spaces/file.txt"
cat $FILE_PATH  # Will fail with spaces

# VIOLATION: Using $* instead of "$@" for arguments
function processArgs() {
    for arg in $*; do  # Should be "$@"
        echo $arg
    done
}

# VIOLATION: Environment variables inline (secrets exposure)
API_KEY="sk-1234567890abcdef"
curl -H "Authorization: Bearer $API_KEY" https://api.example.com

# VIOLATION: No validation of required variables
REQUIRED_VAR="$SOME_ENV_VAR"  # Should validate first
