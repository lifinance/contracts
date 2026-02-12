#!/bin/bash

# VIOLATION: No function documentation at all
function deployContract() {
    local network=$1
    local contractName=$2
    
    if [[ "$network" == "tron" ]]; then
        troncast deploy "$contractName"
    else
        forge create "$contractName"
    fi
}

# VIOLATION: Inconsistent documentation format
# This function does something
# params: network, address
function checkOwner() {
    local network=$1
    local addr=$2
    cast call "$addr" "owner()"
}

# VIOLATION: Missing usage/parameter descriptions
# Function: updateConfig
function updateConfig() {
    local NETWORK=$1  # VIOLATION: Parameters should be lowercase in code
    local VALUE=$2
    echo "Updating config"
}

# VIOLATION: No routing/behavior documentation for universalCast usage
function makeCall() {
    universalCast "call" "$1" "$2" "owner()"
}

# VIOLATION: Missing returns documentation
function getOwner() {
    local contract=$1
    cast call "$contract" "owner()"
}

# VIOLATION: No examples provided
function complexOperation() {
    local network=$1
    local contract=$2
    local selector=$3
    
    # Complex logic with no explanation
    if [[ "$network" == "tron" ]]; then
        troncast call "$contract" "$selector"
    else
        cast call "$contract" "$selector"
    fi
}

# VIOLATION: Using lowercase parameters in docs but UPPERCASE in code
# Parameters:
# - network: Network name
# - address: Contract address
function badParamStyle() {
    local NETWORK=$1  # Inconsistent with docs
    local ADDRESS=$2
}

# VIOLATION: Missing "Optional:" prefix for optional parameters
# Parameters:
# - network
# - timeout (optional)
function withOptional() {
    local network=$1
    local timeout=${2:-30}
}
