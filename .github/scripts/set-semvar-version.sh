#!/usr/bin/env bash

# Script to update semantic versioning across MetaMask platform files
# This script handles version updates for both mobile and extension platforms
# For mobile: Updates package.json, Android build.gradle, Bitrise config, and iOS project files
# For extension: Updates package.json only

set -e
set -u
set -o pipefail

# Input validation
if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <new_semvar_version> <platform>"
    exit 1
fi

# Script parameters
SEMVER_VERSION=$1
PLATFORM=$2

# Regular expression patterns for semantic version validation
NAT='0|[1-9][0-9]*'                    # Non-negative integer
ALPHANUM='[0-9]*[A-Za-z-][0-9A-Za-z-]*' # Alphanumeric identifier
IDENT="$NAT|$ALPHANUM"                 # Identifier (number or alphanumeric)
FIELD='[0-9A-Za-z-]+'                  # Field (alphanumeric with hyphens)

# Full semantic version regex pattern
# Matches: v1.2.3-alpha.1+build.123
SEMVER_REGEX="\
^[vV]?\
($NAT)\\.($NAT)\\.($NAT)\
(\\-(${IDENT})(\\.(${IDENT}))*)?\
(\\+${FIELD}(\\.${FIELD})*)?$"

# File paths for version updates
PACKAGE_JSON_FILE=package.json
ANDROID_BUILD_GRADLE_FILE=android/app/build.gradle
BITRISE_YML_FILE=bitrise.yml
IOS_PROJECT_FILE=ios/MetaMask.xcodeproj/project.pbxproj

# Helper Functions
# ---------------

# Converts semantic version to numeric format (e.g., 1.2.3 -> 123)
semver_to_nat () {
  echo "${1//./}"
}

# Logs error message and exits with status code 1
log_and_exit () {
  echo "$1" && exit 1
}

# Updates version in package.json using jq
package_json() {
  # Create temporary file for jq operation
  tmp="${PACKAGE_JSON_FILE}_temp"
  jq ".version = \"$SEMVER_VERSION\"" $PACKAGE_JSON_FILE > "$tmp"
  mv "$tmp" $PACKAGE_JSON_FILE
  echo "- $PACKAGE_JSON_FILE updated"
}

# Updates version in mobile-specific files
# Handles both macOS and Linux environments
update_mobile_files () {
  # Check operating system and execute platform-specific sed commands
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS specific updates
    
    # Update Android version in build.gradle
    echo "Updating Android build.gradle file..."
    sed -i '' 's/\(\s*versionName \)".*"/\1"'"$SEMVER_VERSION"'"/' "$ANDROID_BUILD_GRADLE_FILE"
    echo "- $ANDROID_BUILD_GRADLE_FILE successfully updated"

    # Update version in Bitrise configuration
    echo "Updating Bitrise configuration files..."
    sed -i '' 's/\(\s*VERSION_NAME: \).*/\1'"$SEMVER_VERSION"'/' "$BITRISE_YML_FILE"
    echo "- $BITRISE_YML_FILE successfully updated"

    # Update iOS marketing version
    echo "Updating iOS project settings..."
    sed -i '' 's/\(\s*MARKETING_VERSION = \).*/\1'"$SEMVER_VERSION;"'/' "$IOS_PROJECT_FILE"
    echo "- $IOS_PROJECT_FILE successfully updated"

  else
    # Linux specific updates
    
    # Update Android version in build.gradle
    echo "Updating Android build.gradle file..."
    sed -i 's/\(\s*versionName \)".*"/\1"'"$SEMVER_VERSION"'"/' "$ANDROID_BUILD_GRADLE_FILE"
    echo "- $ANDROID_BUILD_GRADLE_FILE updated"

    # Update version in Bitrise configuration
    echo "Updating Bitrise configuration files..."
    sed -i 's/\(\s*VERSION_NAME: \).*/\1'"$SEMVER_VERSION"'/' "$BITRISE_YML_FILE"
    echo "- $BITRISE_YML_FILE updated"

    # update ios/MetaMask.xcodeproj/project.pbxproj
    echo "Updating iOS project settings..."
    sed -i 's/\(\s*MARKETING_VERSION = \).*/\1'"$SEMVER_VERSION;"'/' "$IOS_PROJECT_FILE"
    echo "- $IOS_PROJECT_FILE updated"
  fi

  # Print summary of updates
  echo "- $ANDROID_BUILD_GRADLE_FILE updated"
  echo "- $BITRISE_YML_FILE updated"
  echo "- $IOS_PROJECT_FILE updated"

  echo "-------------------"
  echo "Files updated with:"
  echo "SEMVER version: $SEMVER_VERSION"
}

# Main Script
# ----------

# Validate input parameters
if [[ -z $SEMVER_VERSION ]]; then
  log_and_exit "SEMVER_VERSION not specified, aborting!"
fi

# Validate semantic version format
if ! [[ $SEMVER_VERSION =~ $SEMVER_REGEX ]]; then
  log_and_exit "$SEMVER_VERSION is invalid semver!"
fi

echo "SEMVER_VERSION is valid."
echo -e "-------------------"
echo "Updating files:"


# Update the version in the package.json file
package_json

# Platform-specific updates
if [[ $PLATFORM == "mobile" ]]; then
  update_mobile_files
fi

if [[ $PLATFORM == "extension" ]]; then
  echo "No extension specific files to update."
fi

