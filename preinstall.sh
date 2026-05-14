#!/bin/bash

echo "Setting up the development environment..."

install_package_linux() {
  local PACKAGE=$1

  # try to use apt-get (default package manager for Debian/Ubuntu) 
  if command -v apt-get &> /dev/null; then
    echo "Installing $PACKAGE using apt-get..."
    sudo apt-get update -y
    sudo apt-get install -y "$PACKAGE"

  # try to use dnf (default package manager for Fedora/RedHat) 
  elif command -v dnf &> /dev/null; then
    echo "Installing $PACKAGE using dnf..."
    sudo dnf install -y "$PACKAGE"

  else
    echo "No recognized package manager found."
    echo "Please install $PACKAGE manually."
    exit 1
  fi
}

install_package_mac() {
  local PACKAGE=$1

  echo "Installing $PACKAGE on macOS..."
  if ! brew install "$PACKAGE"; then
    echo "Failed to install $PACKAGE"
    exit 1
  fi
}

# Detect the operating system
OS=$(uname -s)

# List of required packages
REQUIRED_PACKAGES=("jq" "bc" "gum" "mongosh")

for PACKAGE in "${REQUIRED_PACKAGES[@]}"; do
  if ! command -v "$PACKAGE" &> /dev/null; then
    echo "$PACKAGE is missing. Proceeding with installation..."
    if [[ "$OS" == "Linux" ]]; then
      if ! command -v sudo &> /dev/null; then
        echo "sudo is required but not available"
        exit 1
      fi
      echo "Detected Linux. Using apt or dnf package manager."
      install_package_linux "$PACKAGE"
    elif [[ "$OS" == "Darwin" ]]; then
      echo "Detected macOS. Using Homebrew package manager."

      # Check if Homebrew is installed
      if ! command -v brew &> /dev/null; then
        echo "Homebrew is not installed. Installing Homebrew..."
        BREW_SCRIPT=$(mktemp)
        if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$BREW_SCRIPT"; then
          echo "Failed to download Homebrew install script"
          rm -f "$BREW_SCRIPT"
          exit 1
        fi
        if ! /bin/bash "$BREW_SCRIPT"; then
          echo "Failed to install Homebrew"
          rm -f "$BREW_SCRIPT"
          exit 1
        fi
        rm -f "$BREW_SCRIPT"
        eval "$("$(brew --prefix)/bin/brew" shellenv)"
      fi
      install_package_mac "$PACKAGE"
    else
      echo "Unsupported operating system: $OS"
      echo "Please install $PACKAGE manually."
      exit 1
    fi
  else
    echo "$PACKAGE is already installed."
  fi
done

echo "All necessary packages are installed."

# install_coderabbit_cli: Install CodeRabbit CLI for local /pr-ready reviews.
#   - Skipped on CI (the cloud CodeRabbit GitHub app handles CI reviews).
#   - Soft-fail: never blocks `bun install`; warns and continues on any error.
#   - Per-developer auth (browser flow) is left to the dev to run once.
#
# Usage: install_coderabbit_cli
# Returns: always 0 (intentionally non-blocking)
function install_coderabbit_cli() {
  if [[ -n "${CI:-}" ]]; then
    echo "CI environment detected — skipping CodeRabbit CLI install."
    return 0
  fi

  if command -v coderabbit &> /dev/null; then
    echo "CodeRabbit CLI is already installed: $(coderabbit --version 2>/dev/null || echo 'unknown version')."
  else
    echo "CodeRabbit CLI is missing. Installing (used by /pr-ready)..."
    local CR_INSTALL_SCRIPT
    CR_INSTALL_SCRIPT=$(mktemp)
    if ! curl -fsSL https://cli.coderabbit.ai/install.sh -o "$CR_INSTALL_SCRIPT"; then
      echo "WARNING: Failed to download CodeRabbit CLI install script. Run /pr-ready setup instructions manually before opening a PR."
      rm -f "$CR_INSTALL_SCRIPT"
      return 0
    fi
    if ! bash "$CR_INSTALL_SCRIPT"; then
      echo "WARNING: CodeRabbit CLI install did not complete cleanly. Run 'curl -fsSL https://cli.coderabbit.ai/install.sh | sh' manually."
      rm -f "$CR_INSTALL_SCRIPT"
      return 0
    fi
    rm -f "$CR_INSTALL_SCRIPT"
  fi

  # Auth is interactive (browser flow); we can only nudge.
  if command -v coderabbit &> /dev/null; then
    if ! coderabbit auth status &> /dev/null; then
      echo ""
      echo "================================================================"
      echo "CodeRabbit CLI is installed but not authenticated."
      echo "Run this once before opening a PR:"
      echo ""
      echo "    coderabbit auth login"
      echo ""
      echo "See .agents/commands/pr-ready.md for the full /pr-ready workflow."
      echo "================================================================"
    fi
  else
    echo "WARNING: CodeRabbit CLI not on PATH after install. Ensure ~/.local/bin (or the installer's printed path) is in your PATH, then re-run 'bun install'."
  fi

  return 0
}

install_coderabbit_cli
