#!/bin/bash

verifyProdDeployment() {
  # load required resources
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  echo "---------------------------"
  echo "Verifying PROD Deployment now..."


  # Contract name is passed as an argument to the script
  CONTRACT_NAME=$1
  if [ -z "$CONTRACT_NAME" ]; then
    echo -e "\033[31mERROR: No contract name provided. Deployment is not allowed.\033[0m"
    exit 1
  fi

  FILE_PATH=$(getContractFilePath "$CONTRACT_NAME")

  # check if the file (path) was found
  if [[ $? -ne 0 ]]; then
    echo -e "\033[31mERROR: Could not find file path for contract $CONTRACT_NAME. Are you in the right branch? Cannot continue.\033[0m"
    exit 1
  fi

  # Extract the contract version from the contract
  CONTRACT_VERSION=$(grep -E '^/// @custom:version' "$FILE_PATH" | awk '{print $3}' || true)

  # throw error if no version was found
  if [ -z "$CONTRACT_VERSION" ]; then
    echo -e "\033[31mERROR: Could not determine the contract version of $FILE_PATH. Deployment is not allowed.\033[0m"
    exit 1
  fi

  echo "Contract: $CONTRACT_NAME (Version: $CONTRACT_VERSION)"

  # Check if the contract in this very version exists in the main branch
  MAIN_BRANCH="main"
  git fetch origin $MAIN_BRANCH &>/dev/null
  if git cat-file -e "origin/$MAIN_BRANCH:$FILE_PATH" &>/dev/null; then
    # get the version of the same contract in main branch
    MAIN_CONTRACT_VERSION=$(git show origin/$MAIN_BRANCH:$FILE_PATH | grep -E '^/// @custom:version' | awk '{print $3}' || true)

    echo "MAIN_CONTRACT_VERSION: $MAIN_CONTRACT_VERSION"

    # check if the contract versions are equal
    if [ "$CONTRACT_VERSION" = "$MAIN_CONTRACT_VERSION" ]; then
      echo -e "\033[32mContract $CONTRACT_NAME (v$CONTRACT_VERSION) found in main branch. Deployment is allowed.\033[0m"
      exit 0
    else
      echo -e "\033[33mContract $CONTRACT_NAME's version in main branch ($MAIN_CONTRACT_VERSION) differs from to-be-deployed version ($CONTRACT_VERSION).\033[0m"
    fi
  else
    echo -e "\033[33mContract $CONTRACT_NAME does not exist in main branch.\033[0m"
  fi

  # Get the current branch name
  CURRENT_BRANCH=$(git branch --show-current)
  echo "Checking now if open PRs exist for the current branch $CURRENT_BRANCH that contain any audit information..."

  # Fetch all PRs for this branch from GitHub
  ORG_NAME="lifinance"
  REPO_NAME="contracts"

  echo "$GITHUB_TOKEN" | gh auth login --with-token

  # Check if authentication was successful
  if ! gh auth status &>/dev/null; then
    echo "GitHub CLI authentication failed. Please check your GITHUB_TOKEN in .env."
    exit 1
  fi

  # Use GitHub CLI to get PRs associated with the current branch
  PRs=$(gh pr list --repo "$ORG_NAME/$REPO_NAME" --head "$CURRENT_BRANCH" --json number,title,labels,baseRefName)

  # Check the "AuditCompleted" label for each PR
  FAILED=0

  # If no PRs found, output an error and exit
  if [ -z "$PRs" ]; then
    echo -e "\033[31mERROR: No PRs found for branch $CURRENT_BRANCH. Deployment is not allowed.\033[0m"
    exit 1
  fi

  # Go through all PRs
  for row in $(echo "${PRs}" | jq -r '.[] | @base64'); do
    # Function to extract PR parameters
    _extractPRParameter() {
      echo ${row} | base64 --decode | jq -r ${1}
    }

    PR_NUMBER=$(_extractPRParameter '.number')
    PR_TITLE=$(_extractPRParameter '.title')
    PR_LABELS=$(_extractPRParameter '.labels[].name')

    # we need to make sure that a label cannot be quickly/temporarily manually assigned (before being removed by git action) to bypass this check
    # therefore we make sure that no actions are running or queued before checking the PR itself
    # Fetch the head SHA of the PR
    PR_INFO=$(gh pr view "$PR_NUMBER" --repo "$ORG_NAME/$REPO_NAME" --json headRefOid)
    PR_SHA=$(echo "$PR_INFO" | jq -r '.headRefOid')

    echo "PR_SHA: $PR_SHA"

    # Fetch workflow runs for the specific commit SHA
    WORKFLOW_RUNS=$(gh api "repos/$ORG_NAME/$REPO_NAME/actions/runs?head_sha=$PR_SHA" --paginate)

    # Check if there was an error fetching the runs
    if [ $? -ne 0 ]; then
        echo -e "\033[31mError fetching workflow runs: $WORKFLOW_RUNS for commit $PR_SHA in PR $PR_NUMBER\033[0m"
        exit 1
    fi

    # Debugging: Print the workflow runs
    echo "WORKFLOW_RUNS: $WORKFLOW_RUNS"


    # Check for running or queued workflows
    RUNNING_OR_QUEUED=$(echo "$WORKFLOW_RUNS" | jq -r '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | "\(.name) - Status: \(.status) - Event: \(.event)"')

    echo "RUNNING_OR_QUEUED: $RUNNING_OR_QUEUED"

    if [ ! -z "$RUNNING_OR_QUEUED" ]; then
        echo -e "\033[31mThere are running or queued github actions for PR #$PR_NUMBER:\033[0m"
        echo -e "\033[31m$RUNNING_OR_QUEUED" | jq -r '. | "\(.name) - Status: \(.status) - Event: \(.event)"'"\033[0m"
        echo -e "\033[31mWe cannot safely verify PROD deployment while actions are still running. Please wait until they are finished and try again.\033[0m"
        exit 1
    fi

    # Check if "AuditCompleted" label is present
    if echo "$PR_LABELS" | grep -wq "AuditCompleted"; then
      echo -e "\033[32mPR #$PR_NUMBER ($PR_TITLE) is audited and ready for deployment.\033[0m"
    else
      echo -e "\033[31mPR #$PR_NUMBER ($PR_TITLE) is NOT audited. Deployment is not allowed.\033[0m"
      FAILED=1
    fi
  done

  # Final decision based on checks
  if [ $FAILED -eq 1 ]; then
    echo -e "\033[31mERROR: One or more PRs do not have the 'AuditCompleted' label. Deployment is not allowed.\033[0m"
    exit 1
  else
    echo -e "\033[32mAll PRs are audited. Proceeding with deployment.\033[0m"
  fi

  echo "---------------------------"
}


verifyProdDeployment "NewFacet"
