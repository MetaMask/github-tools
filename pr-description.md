## What is the current state of things and why does it need to change?

Currently, the RCA (Root Cause Analysis) label removal process requires manual intervention across 4 MetaMask repositories. When teams submit RCAs via Google Forms, someone needs to:
- Check the Google Sheets for new RCA submissions
- Find the corresponding GitHub issues
- Manually remove the `RCA-needed` labels

This manual process is time-consuming, error-prone, and creates unnecessary overhead for teams managing post-incident workflows.

## What is the solution your changes offer and how does it work?

This PR introduces a **reusable GitHub workflow** that automates the RCA label removal process across multiple repositories.

### 📁 **Files Changed:**
- **Added:** `.github/scripts/remove-rca-needed-label-sheets.ts` - Self-contained TypeScript script (414 lines)
- **Added:** `.github/workflows/remove-rca-needed-label-sheets.yml` - Reusable workflow (76 lines)
- **Modified:** `.depcheckrc.json` - Ignore runtime dependencies

### 🎯 **Key Features:**
- **Automated Process**: Reads Google Sheets RCA submissions and removes labels from matching GitHub issues
- **Reusable Pattern**: Any MetaMask repository can consume this workflow (like `create-release-pr.yml`)
- **Safety First**: Dry-run mode, comprehensive error handling, continues on individual failures
- **Self-Contained**: No repository-specific dependencies

### 🔧 **Technical Implementation:**

**Core Functionality:**
- Connects to Google Sheets API to fetch RCA submissions
- Queries GitHub GraphQL API for issues with `RCA-needed` label
- Dynamically detects "Issue Number" column in sheets
- Removes labels via GitHub REST API

**Security & Best Practices:**
- GraphQL variables prevent injection attacks
- Exact npm version pinning (`--save-exact`)
- Defensive programming with null checking
- HTTP status codes as enum (no magic numbers)
- Fails fast on configuration errors

**Dependency Strategy:**
- Runtime packages installed locally in scripts directory during workflow execution
- Uses `npm install --no-save` to avoid modifying checked-in files
- Not in `package.json` to avoid Socket Security alerts
- `.depcheckrc.json` configured to ignore these dependencies

### 📋 **How to Use:**
Repositories can consume this workflow by creating a simple workflow file:
```yaml
name: Remove RCA-needed Label

on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Run in dry-run mode'
        required: false
        default: 'false'
        type: choice
        options: ['true', 'false']
      spreadsheet_id:
        description: 'Google Spreadsheet ID (optional - for testing)'
        required: false
        default: ''  # Empty means use repo's default

jobs:
  remove-rca-labels:
    uses: MetaMask/github-tools/.github/workflows/remove-rca-needed-label-sheets.yml@main
    with:
      dry_run: ${{ github.event.inputs.dry_run || 'false' }}
      spreadsheet_id: ${{ github.event.inputs.spreadsheet_id || 'YOUR_REPO_SHEET_ID' }}  # Required
    secrets:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      google-application-creds-base64: ${{ secrets.GCP_RLS_SHEET_ACCOUNT_BASE64 }}
```

**Note:** Replace `YOUR_REPO_SHEET_ID` with your repository's Google Sheet ID. The input allows override for testing purposes.

## Testing & Quality

✅ **Validated through:**
- Mock testing for workflow behavior
- Dry-run mode for safe testing
- All linting and dependency checks passing
- No Socket Security blocking alerts

✅ **Live testing in fork repository:**
- **Test Run 1**: [Issue has label but is NOT in RCA sheet - label kept](https://github.com/consensys-test/metamask-extension-test-fork/actions/runs/17266390093)
  - Correctly skipped removal when RCA not found in Google Sheet
- **Test Run 2**: [Issue label removed because it IS in RCA sheet](https://github.com/consensys-test/metamask-extension-test-fork/actions/runs/17266424658/job/48999524636)
  - Successfully removed label when RCA was found in Google Sheet

✅ **Security improvements from Copilot code review:**
- GraphQL injection prevention
- Exact version pinning for supply chain security
- Comprehensive null checking and defensive programming

## Related Issues

- **JIRA**: INFRA-2864 (primary), INFRA-2406, INFRA-2510
- **Sheet**: [RCA Tracking Spreadsheet](https://docs.google.com/spreadsheets/d/1Y16QEnDwZuR3DAQIe3T5LTWy1ye07GNYqxIei_cMg24/)

## Configuration Required

Before using this workflow, repositories must:
1. Ensure the Google Sheet is shared with the service account
2. Have the `GCP_RLS_SHEET_ACCOUNT_BASE64` secret configured
3. Configure appropriate spreadsheet ID if different from the example in the PR description
