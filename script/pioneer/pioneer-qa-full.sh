## Load env
source .env

# This script is created to assist with throughput testing of Pioneer through the LI.FI diamond.

# Get from network.
NETWORK=$1  # ["optimism", "arbitrum", "polygon"]
# Get to networks
TO_NETWORKS=$2  # ["optimism", "arbitrum", "polygon"]
# Get the token
TOKEN=$3  # 0x...
NUM_TRANSACTIONS=$4 # 10
NUM_RUNS=5 # 5


# For each network provided, run the qa script in parallel and then wait for all to finish.
for RUN in $(seq 1 $NUM_RUNS);
do
  echo "Starting run $RUN of $NUM_RUNS"
  for NETWORK in $(echo $NETWORK | tr -d '[]"' | tr ',' '\n');
  do
    echo "Starting QA for network: $NETWORK"
    bash script/pioneer/pioneer-qa.sh "$NETWORK" "$TO_NETWORKS" "$TOKEN" "$NUM_TRANSACTIONS" &
  done
  # Wait for all background processes to finish
  wait
done;

echo "All QA processes completed."
