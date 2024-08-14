#!/bin/bash

verifyProdDeployment() {
  # load required resources
  source .env
  source script/config.sh
  source script/helperFunctions.sh


# Get the current branch name
CURRENT_BRANCH=$(git branch --show-current)

# Fetch all PRs for this branch from GitHub
ORG_NAME="lifinance" # Replace with your GitHub organization name
REPO_NAME="contracts" # Replace with your GitHub repository name

# Use GitHub CLI to get PRs associated with the current branch
PRs=$(gh pr list --repo "$ORG_NAME/$REPO_NAME" --head "$CURRENT_BRANCH" --json number,title,labels,baseRefName)

echo "PRs:"
echo "$PRs"

# Check the "AuditCompleted" label for each PR
FAILED=0

# If no PRs found, output an error and exit
if [ -z "$PRs" ]; then
  echo -e "\033[31mERROR: No PRs found for branch $CURRENT_BRANCH. Deployment is not allowed.\033[0m"
  exit 1
fi

# go through all PRs
for row in $(echo "${PRs}" | jq -r '.[] | @base64'); do
  # function to extract PR parameters
  _extractPRParameter() {
    echo ${row} | base64 --decode | jq -r ${1}
  }

  PR_NUMBER=$(_extractPRParameter '.number')
  PR_TITLE=$(_extractPRParameter '.title')
  PR_LABELS=$(_extractPRParameter '.labels[].name')

  # Check if "AuditCompleted" label is present
  if echo "$PR_LABELS" | grep -wq "AuditCompleted"; then
    echo -e "\033[32mPR #$PR_NUMBER ($PR_TITLE) is audited and ready for deployment.\033[0m"
  else
    echo -e "\033[31mPR #$PR_NUMBER ($PR_TITLE) is NOT audited. Deployment is not allowed.\033[0m"
    FAILED=1
  fi
done

# Step 4: Final decision based on checks
if [ $FAILED -eq 1 ]; then
  echo -e "\033[31mERROR: One or more PRs do not have the 'AuditCompleted' label. Deployment is not allowed.\033[0m"
  exit 1
else
  echo -e "\033[32mAll PRs are audited. Proceeding with deployment.\033[0m"
fi


}
verifyProdDeployment
