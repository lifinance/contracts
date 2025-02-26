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
REQUIRED_PACKAGES=("jq" "bc" "gum")

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
