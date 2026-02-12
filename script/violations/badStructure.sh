# VIOLATION: Missing #!/bin/bash shebang

# VIOLATION: No functions, everything inline
# VIOLATION: No DRY principle - duplicated code

# VIOLATION: Variables not in UPPERCASE
network="mainnet"
contractAddress="0x1234"

# VIOLATION: No error handling with checkFailure
# VIOLATION: No logging helpers (echoDebug, error, warning, success)

# VIOLATION: Hardcoded network checks instead of using universalCast
if [[ "$network" == "tron" ]]; then
    # VIOLATION: Direct troncast call instead of universalCast
    troncast call "$contractAddress" "facets()"
else
    # VIOLATION: Direct cast call instead of universalCast
    cast call "$contractAddress" "facets()"
fi

# VIOLATION: Duplicate logic (should be in a function)
if [[ "$network" == "tron" ]]; then
    troncast call "$contractAddress" "owner()"
else
    cast call "$contractAddress" "owner()"
fi

# VIOLATION: Unquoted variable expansion
echo $contractAddress

# VIOLATION: Unsafe variable expansion (should use ${VAR:-})
echo $UNDEFINED_VAR

# VIOLATION: No validation of required variables
# VIOLATION: No environment loading from .env/config.sh

# VIOLATION: Using $VAR[@] instead of ${VAR[@]:-}
FACETS=(Facet1 Facet2)
for facet in ${FACETS[@]}; do
    echo $facet
done

# VIOLATION: No exit codes
# VIOLATION: No usage/help text
# VIOLATION: Inconsistent indentation
