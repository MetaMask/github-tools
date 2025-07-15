#!/usr/bin/env bash

# SAFE test script for functions from create-platform-release-pr.sh
# This script uses mocking to prevent any real git/GitHub operations
set -e

echo "SAFE Testing for Individual Functions"
echo "====================================="
echo "⚠️  This test uses mocking to prevent real operations"
echo ""

# Set test mode to prevent real operations
export TEST_ONLY="true"
export GITHUB_REPOSITORY_URL="https://github.com/MetaMask/test-repo"

# Source the functions from the main script by setting dummy parameters
# We use 'set --' to temporarily set positional parameters while sourcing
set -- extension v1.4.0 1.5.3 100
source ./.github/scripts/create-platform-release-pr.sh
set --  # Clear positional parameters after sourcing

echo "Testing individual functions..."
echo "================================"
echo ""

# Test get_next_version function (safe - no external calls)
echo "Testing get_next_version (SAFE):"
echo "  Input: 1.5.3 -> Output: $(get_next_version "1.5.3")"
echo "  Input: 2.10.15 -> Output: $(get_next_version "2.10.15")"
echo "  Input: 10.0.0 -> Output: $(get_next_version "10.0.0")"

# Test invalid version
echo "  Testing invalid version (should fail):"
if (get_next_version "invalid.version" 2>/dev/null); then
    echo "  ✗ Should have rejected invalid version"
else
    echo "  ✓ Correctly rejected invalid version"
fi

echo ""

# Test get_release_branch_name function (safe - no external calls)
echo "Testing get_release_branch_name (SAFE):"
export TEST_ONLY="false"
echo "  Mobile (prod): $(get_release_branch_name "mobile" "1.5.3")"
echo "  Extension (prod): $(get_release_branch_name "extension" "1.5.3")"

export TEST_ONLY="true"
echo "  Mobile (test): $(get_release_branch_name "mobile" "1.5.3")"
echo "  Extension (test): $(get_release_branch_name "extension" "1.5.3")"

echo ""

# Test get_version_bump_branch_name function (safe - no external calls)
echo "Testing get_version_bump_branch_name (SAFE):"
export TEST_ONLY="false"
echo "  Production mode: $(get_version_bump_branch_name "1.6.0")"

export TEST_ONLY="true"
echo "  Test mode: $(get_version_bump_branch_name "1.6.0")"

echo ""

# Test get_expected_changed_files function (safe - no external calls)
echo "Testing get_expected_changed_files (SAFE):"
echo "  Mobile files: $(get_expected_changed_files "mobile")"
echo "  Extension files: $(get_expected_changed_files "extension")"

echo ""

# Test workflow functions with comprehensive mocking
echo "Testing workflow functions (MOCKED - SAFE):"
echo "============================================"
echo "🛡️  All external commands are mocked for safety"
echo ""

# Comprehensive mocking of ALL external commands to prevent real operations
git() {
    echo "MOCK git: $*"
    return 0
}

gh() {
    echo "MOCK gh: $*"
    return 0
}

npx() {
    echo "MOCK npx: $*"
    return 0
}

yarn() {
    echo "MOCK yarn: $*"
    return 0
}

corepack() {
    echo "MOCK corepack: $*"
    return 0
}

cd() {
    echo "MOCK cd: $*"
    return 0
}

ls() {
    echo "MOCK ls: $*"
    return 0
}

pwd() {
    echo "/mock/current/directory"
    return 0
}

# Export functions for subshells to ensure mocking works everywhere
export -f git gh npx yarn corepack cd ls pwd

echo "Testing configure_git (mocked):"
configure_git

echo ""
echo "Testing helper functions (mocked):"
echo "  Testing checkout_or_create_branch (mocked):"
checkout_or_create_branch "test-branch" "main"

echo "  Testing push_branch_with_handling (mocked):"
push_branch_with_handling "test-branch"

echo "  Testing create_pr_if_not_exists (mocked):"
create_pr_if_not_exists "test-branch" "Test PR" "Test PR body" "main" "test"

echo ""
echo "✅ All function tests completed SAFELY!"
echo ""
echo "To test the full script in safe test mode:"
echo "  TEST_ONLY=true ./.github/scripts/create-platform-release-pr.sh extension v1.4.0 1.5.3 100"
echo ""
echo "⚠️  NEVER run without TEST_ONLY=true in a real repository!"
echo "With TEST_ONLY mode (SAFE):"
echo "  TEST_ONLY=true ./.github/scripts/create-platform-release-pr.sh extension v1.4.0 1.5.3 100"
