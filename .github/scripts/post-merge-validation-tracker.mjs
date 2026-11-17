import { Octokit } from '@octokit/rest';
import { google } from 'googleapis';

const githubToken = process.env.GITHUB_TOKEN;
// can be found in the excel url e.g. https://docs.google.com/spreadsheets/d/1uSERA-Mczy0pjlrr1vv../
const spreadsheetId = process.env.SHEET_ID; // 1uSERA-Mczy0pjlrr1vv...
// GOOGLE_APPLICATION_CREDENTIALS_BASE64 can be found in MM QA 1pasword vault
const googleApplicationCredentialsBase64 =
  process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
const targetRepo = process.env.REPO || 'MetaMask/metamask-extension';
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '1', 10);
const START_HOUR_UTC = parseInt(process.env.START_HOUR_UTC ?? '7', 10);

const START_MINUTE_UTC = 0;
const RELEVANT_TITLE_REGEX =
  /^(feat|perf|fix|chore|refactor)\s*(\(|:|!|\/)|\bbump\b/iu;
const TEAM_LABEL_PREFIX = 'team-';
const SIZE_LABEL_PREFIX = 'size-';
const AUTOMATED_TEST_PATTERNS = [
  /\.test\.(js|ts|tsx)$/u,
  /\.spec\.(js|ts|tsx)$/u,
  /\.(test|spec)\.(js|ts|tsx)\.snap$/u,
  /(^|\/)test\//u,
  /(^|\/)e2e\//u,
  /(^|\/)wdio\//u,
];
const SKIP_RELEASE_VALIDATION_LABEL = 'skip-release-validation';

if (!githubToken) {
  throw new Error('Missing GITHUB_TOKEN env var');
}
if (!spreadsheetId) {
  throw new Error('Missing SHEET_ID env var');
}
if (!googleApplicationCredentialsBase64) {
  throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64 env var');
}
if (!targetRepo) {
  throw new Error('Missing REPO env var');
}

const octokit = new Octokit({ auth: githubToken });
const sheets = google.sheets('v4');

async function getGoogleAuth() {
  const credentials = JSON.parse(
    Buffer.from(googleApplicationCredentialsBase64, 'base64').toString('utf8'),
  );
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

function parseRepo() {
  const [owner, repoName] = targetRepo.split('/');
  if (!owner || !repoName) {
    throw new Error(
      `Invalid repo format "${targetRepo}". Expected format: "owner/repo"`,
    );
  }
  return { owner, repo: repoName };
}

function repoType(repo) {
  if (repo.endsWith('-extension')) {
    return 'extension';
  }
  if (repo.endsWith('-mobile')) {
    return 'mobile';
  }
  return repo;
}

function tabTitleFor(repo, releaseLabel) {
  return `pre-${releaseLabel} (${repoType(repo)})`;
}

function platformLabelFor(type) {
  const typeLower = String(type).toLowerCase();
  if (typeLower === 'mobile') {
    return '📱 Mobile - Pull requests';
  }
  if (typeLower === 'extension') {
    return '🔌 Extension - Pull requests';
  }
  return typeLower;
}

function headerRowFor(type) {
  const typeLower = String(type).toLowerCase();
  const isMobile = typeLower === 'mobile';
  const colG = isMobile ? 'Validated (Android)' : 'Validated (Chrome)';
  const colH = isMobile ? 'Validated (iOS)' : 'Validated (Firefox)';
  return [
    platformLabelFor(type),
    'Merged Time (UTC)',
    'Author',
    'PR Size',
    'Tests changes?',
    'Team Responsible',
    colG,
    colH,
  ];
}

async function ensureSheetExists(authClient, title, platformType) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    auth: authClient,
    fields: 'sheets(properties(sheetId,title))',
  });

  const sheetsList = meta.data.sheets || [];

  // First, try to find the exact title (with "pre-" prefix)
  let existing = sheetsList.find((sheet) => sheet.properties?.title === title);
  if (existing) {
    return {
      sheetId: existing.properties.sheetId,
      actualTitle: title,
      isNew: false,
    };
  }

  // If not found and title starts with "pre-", try without the "pre-" prefix
  if (title.startsWith('pre-')) {
    const titleWithoutPrefix = title.replace(/^pre-/u, '');
    existing = sheetsList.find(
      (sheet) => sheet.properties?.title === titleWithoutPrefix,
    );
    if (existing) {
      console.log(
        `Found renamed tab: "${titleWithoutPrefix}" (originally looking for "${title}")`,
      );
      return {
        sheetId: existing.properties.sheetId,
        actualTitle: titleWithoutPrefix,
        isNew: false,
      };
    }
  }

  const result = await createSheetFromTemplateOrBlank(
    authClient,
    sheetsList,
    title,
    platformType,
  );
  return { ...result, actualTitle: title };
}

async function createSheetFromTemplateOrBlank(
  authClient,
  sheetsList,
  title,
  platformType,
) {
  // Try to duplicate from a template tab (single template name: 'template')
  const templateCandidates = ['template'];
  const template = sheetsList.find((sheet) =>
    templateCandidates.includes(sheet.properties?.title || ''),
  );

  const templateSheetId = template?.properties?.sheetId;
  if (templateSheetId !== null && templateSheetId !== undefined) {
    const duplicateRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      auth: authClient,
      requestBody: {
        requests: [
          {
            duplicateSheet: {
              sourceSheetId: template.properties.sheetId,
              newSheetName: title,
            },
          },
        ],
      },
    });
    const newSheetId =
      duplicateRes.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
    // Write all platform-specific column headers into row 1 (preserves template cell formatting)
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      auth: authClient,
      range: `${title}!A1:H1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headerRowFor(platformType)] },
    });
    // Insert a blank row at index 1 (0-based) so data can start at row 3
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      auth: authClient,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: newSheetId, hidden: false },
              fields: 'hidden',
            },
          },
          {
            insertDimension: {
              range: {
                sheetId: newSheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 2,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
    console.log(
      `Duplicated template '${template.properties.title}' → '${title}' and set platform label for type '${platformType}'`,
    );
    return { sheetId: newSheetId, isNew: true };
  }

  // No template found: log fail message and create a blank tab
  console.log(
    `❌ Template not found for new tab '${title}'. Candidates tried: ${templateCandidates.join(', ')}. Falling back to blank sheet.`,
  );
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    auth: authClient,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title },
          },
        },
      ],
    },
  });
  const sheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
  // Write all column headers into row 1 (no template to provide them)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A1:H1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headerRowFor(platformType)] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    auth: authClient,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, hidden: false },
            fields: 'hidden',
          },
        },
      ],
    },
  });
  console.log(`Created new sheet tab (no template found): ${title}`);
  return { sheetId, isNew: true };
}

async function readRows(authClient, title) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      auth: authClient,
      range: `${title}!A2:J`,
    });
    return res.data.values || [];
  } catch {
    // If the sheet or range doesn't exist yet
    return [];
  }
}

async function appendRows(authClient, title, rows) {
  if (!rows.length) {
    return;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A3:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

function uniqKey(number) {
  return String(number);
}

function formatDateHumanUTC(iso) {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function makePrHyperlinkCell(url, title, number) {
  const label = `${title} (#${number})`;
  // Sheets formula
  const escapedUrl = url.replace(/"/gu, '');
  const escapedLabel = label.replace(/"/gu, '');
  return `=HYPERLINK("${escapedUrl}","${escapedLabel}")`;
}

function extractTeam(labels) {
  const found = labels.find((label) =>
    label.name?.startsWith(TEAM_LABEL_PREFIX),
  );
  return found ? found.name : 'unknown';
}

function extractSize(labels) {
  const found = labels.find((label) =>
    label.name?.startsWith(SIZE_LABEL_PREFIX),
  );
  return found ? found.name : 'unknown';
}

function isoSinceAtUTC(days, hour = 2, minute = 0) {
  // Returns an ISO timestamp at (today - days) with specific UTC hour:minute, e.g., 02:00Z
  const now = new Date();
  const targetDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  targetDate.setUTCDate(targetDate.getUTCDate() - days);
  targetDate.setUTCHours(hour, minute, 0, 0);
  return targetDate.toISOString();
}

async function fetchMergedPRsSince(owner, repo, sinceDateISO) {
  // Strategy: use fast GitHub search API, then add package.json version detection
  const since = new Date(sinceDateISO);
  const sinceDate = since.toISOString().split('T')[0];
  const prs = [];
  let page = 1;

  while (true) {
    console.log(
      `Fetching merged PRs page ${page} for ${owner}/${repo} (since ${sinceDateISO})...`,
    );

    try {
      const query = `repo:${owner}/${repo} is:pr is:merged base:main merged:>=${sinceDate}`;

      const { data } = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page,
        advanced_search: true,
      });

      if (!data.items.length) {
        break;
      }
      console.log(`Found ${data.items.length} PRs on page ${page}`);

      for (const item of data.items) {
        if (item.pull_request && item.closed_at) {
          const mergedAt = new Date(item.closed_at);
          if (mergedAt >= since) {
            prs.push({
              number: item.number,
              title: item.title,
              html_url: item.html_url,
              user: { login: item.user?.login || '' },
              labels: item.labels || [], // Basic labels from search
              closed_at: item.closed_at,
              base_ref: 'main',
            });
          }
        }
      }

      if (data.items.length < 100) {
        break;
      }
      page += 1;
      await sleep(200);
    } catch (error) {
      console.log(`❌ Search API error: ${error.message}`);
      break;
    }
  }

  console.log(
    `Found ${prs.length} merged PRs since ${sinceDateISO} for ${owner}/${repo}`,
  );
  return prs;
}

function isRelevantTitle(title) {
  if (!title) {
    return false;
  }
  return RELEVANT_TITLE_REGEX.test(String(title));
}

function extractLabelText(formulaOrText) {
  const text = String(formulaOrText || '');
  // If it's a HYPERLINK formula like =HYPERLINK("url","Label") extract Label
  const match = text.match(/HYPERLINK\([^,]+,\s*"([^"]+)"\)/iu);
  if (match) {
    return match[1];
  }
  return text;
}

function parsePrNumberFromCell(cell) {
  const text = extractLabelText(cell);
  const match = String(text).match(/#(\d+)/u);
  return match ? Number(match[1]) : null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitByReleaseAndTitle(items) {
  const relevant = [];
  let skippedByTitle = 0;

  for (const item of items) {
    if (isRelevantTitle(item.title)) {
      relevant.push(item);
    } else {
      skippedByTitle += 1;
    }
  }

  return { relevant, skippedByTitle };
}

function getAutoSkipLabelsForPR(labels, repoName) {
  const labelNames = (labels || []).map((label) => label.name).filter(Boolean);
  const hasSkipAll = labelNames.includes(SKIP_RELEASE_VALIDATION_LABEL);

  const granularLabels = labelNames.filter((name) =>
    /^skip-release-validation\[(android|ios|design|chrome|firefox)\]$/iu.test(
      name,
    ),
  );

  const lowerRepoName = String(repoName || '').toLowerCase();
  const isMobile = lowerRepoName.endsWith('-mobile');
  const isExtension = lowerRepoName.endsWith('-extension');

  const validGranularLabels = granularLabels.filter((name) => {
    const target = name.toLowerCase();
    if (
      isMobile &&
      (target.includes('[chrome]') || target.includes('[firefox]'))
    ) {
      return false;
    }
    if (
      isExtension &&
      (target.includes('[android]') || target.includes('[ios]'))
    ) {
      return false;
    }
    return true;
  });

  return {
    hasSkipAll,
    validLabels: validGranularLabels,
  };
}

function applyAutoSkipToRow(row, labels, repoName) {
  const { hasSkipAll, validLabels } = getAutoSkipLabelsForPR(labels, repoName);
  if (!hasSkipAll && validLabels.length === 0) {
    return row;
  }

  const updatedRow = [...row];
  const validLabelSet = new Set(
    validLabels.map((label) => label.toLowerCase()),
  );
  const isMobile = String(repoName || '')
    .toLowerCase()
    .endsWith('-mobile');

  const shouldSkipFirstValidated =
    hasSkipAll ||
    validLabelSet.has('skip-release-validation[design]') ||
    validLabelSet.has(
      isMobile
        ? 'skip-release-validation[android]'
        : 'skip-release-validation[chrome]',
    );
  const shouldSkipSecondValidated =
    hasSkipAll ||
    validLabelSet.has('skip-release-validation[design]') ||
    validLabelSet.has(
      isMobile
        ? 'skip-release-validation[ios]'
        : 'skip-release-validation[firefox]',
    );

  if (shouldSkipFirstValidated) {
    updatedRow[6] = 'Skipped';
  }
  if (shouldSkipSecondValidated) {
    updatedRow[7] = 'Skipped';
  }

  const labelsForComment = hasSkipAll
    ? [SKIP_RELEASE_VALIDATION_LABEL, ...validLabels]
    : validLabels;

  if (shouldSkipFirstValidated || shouldSkipSecondValidated) {
    updatedRow[9] = `Release validation automatically skipped due to PR labels: ${labelsForComment.join(', ')}`;
  }

  return updatedRow;
}

// Add efficient version detection with caching
const versionCache = new Map(); // Cache version bumps per repo

// Automated test detection cache
const automatedTestCache = new Map(); // Cache automated test results per PR: "owner/repo/prNumber" -> "Yes"|"No"|"Unknown"

async function getVersionTimelineForRepo(owner, repo, sinceDateISO) {
  const cacheKey = `${owner}/${repo}`;
  if (versionCache.has(cacheKey)) {
    return versionCache.get(cacheKey);
  }

  console.log(`🔍 Analyzing version timeline for ${owner}/${repo}...`);

  // Get current version from package.json
  const currentVersion = await getCurrentPackageVersion(owner, repo);
  if (!currentVersion) {
    console.log(`⚠️ Could not determine current version for ${owner}/${repo}`);
    return { currentVersion: null, versionBumps: [] };
  }

  // Find version bumps in lookback period
  const versionBumps = await findVersionBumpCommits(owner, repo, sinceDateISO);

  // Create timeline: [newest bump, older bump, ..., oldest bump]
  const timeline = {
    currentVersion: normalizeVersion(currentVersion),
    versionBumps, // Already sorted newest first
    sinceDate: new Date(sinceDateISO),
  };

  console.log(`📊 Version timeline for ${owner}/${repo}:`);
  console.log(`   Current: ${timeline.currentVersion}`);

  if (versionBumps.length === 0) {
    console.log(
      `   No version bumps in lookback period - all PRs → ${timeline.currentVersion}`,
    );
  } else {
    for (const bump of versionBumps) {
      console.log(
        `   ${bump.oldVersion} → ${bump.newVersion} at ${formatDateHumanUTC(bump.date)}`,
      );
    }
  }

  versionCache.set(cacheKey, timeline);
  return timeline;
}

async function getCurrentPackageVersion(owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'package.json',
      ref: 'main',
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const packageJson = JSON.parse(content);
    return packageJson.version;
  } catch (error) {
    console.log(`⚠️ Failed to fetch package.json version: ${error.message}`);
    return null;
  }
}

function parseVersionFromPatch(patch) {
  const lines = patch.split('\n');
  let oldVersion = null;
  let newVersion = null;

  for (const line of lines) {
    if (line.startsWith('-') && line.includes('"version":')) {
      const match = line.match(/"version":\s*"([^"]+)"/u);
      if (match) {
        oldVersion = match[1];
      }
    }
    if (line.startsWith('+') && line.includes('"version":')) {
      const match = line.match(/"version":\s*"([^"]+)"/u);
      if (match) {
        newVersion = match[1];
      }
    }
  }

  if (oldVersion && newVersion && oldVersion !== newVersion) {
    return { oldVersion, newVersion };
  }
  return null;
}

function normalizeVersion(version) {
  if (!version) {
    return null;
  }
  return version.startsWith('v') ? version : `v${version}`;
}

function determineReleaseVersionFromTimeline(mergedAt, versionTimeline) {
  const { currentVersion, versionBumps } = versionTimeline;
  const mergedDate = new Date(mergedAt);

  // If no version bumps in our lookback period, everything goes to current version
  if (versionBumps.length === 0) {
    return currentVersion;
  }

  // Find the appropriate version based on merge time vs version bump times
  // versionBumps are sorted newest first
  for (const bump of versionBumps) {
    const bumpDate = new Date(bump.date);

    // If PR was merged after this version bump, it belongs to the new version
    if (mergedDate >= bumpDate) {
      return normalizeVersion(bump.newVersion);
    }
  }

  // If PR was merged before all version bumps in our period,
  // it belongs to the version that existed before the oldest bump
  const oldestBump = versionBumps[versionBumps.length - 1];
  return normalizeVersion(oldestBump.oldVersion);
}

// Optimized buildTabGrouping
async function buildTabGrouping(owner, repo, relevantItems, sinceDateISO) {
  const tabToRows = new Map();
  const platformType = repoType(repo);

  // Get version timeline once for this repo
  const versionTimeline = await getVersionTimelineForRepo(
    owner,
    repo,
    sinceDateISO,
  );

  if (!versionTimeline.currentVersion) {
    console.log(`❌ Cannot determine versions for ${owner}/${repo} - skipping`);
    return tabToRows;
  }

  // Group PRs by determined release version
  const prsByVersion = new Map();

  for (const pr of relevantItems) {
    const releaseVersion = determineReleaseVersionFromTimeline(
      pr.closed_at,
      versionTimeline,
    );
    if (!releaseVersion) {
      continue;
    }

    if (!prsByVersion.has(releaseVersion)) {
      prsByVersion.set(releaseVersion, []);
    }
    prsByVersion.get(releaseVersion).push(pr);
  }

  // Create tabs only for versions that have PRs
  for (const [version, prs] of prsByVersion.entries()) {
    const title = tabTitleFor(repo, version);
    console.log(`📋 Tab: ${title} - ${prs.length} PRs`);

    if (!tabToRows.has(title)) {
      tabToRows.set(title, { entries: [], platformType });
    }

    for (const pr of prs) {
      // Check if PR modifies automated test files
      const automatedTestsModified = await checkAutomatedTestFiles(
        owner,
        repo,
        pr.number,
      );
      const validatedA = '';
      const validatedB = '';
      const designValidation = '';
      const comments = '';

      const row = [
        makePrHyperlinkCell(pr.html_url, pr.title, pr.number),
        formatDateHumanUTC(pr.closed_at || ''),
        pr.user.login,
        extractSize(pr.labels || []),
        automatedTestsModified,
        extractTeam(pr.labels || []),
        validatedA,
        validatedB,
        designValidation,
        comments,
      ];
      tabToRows.get(title).entries.push({
        row,
        mergedAtIso: pr.closed_at || '',
        labels: pr.labels || [],
      });
    }
  }

  return tabToRows;
}

// Enhanced version bump detection with better error handling
async function findVersionBumpCommits(owner, repo, sinceDateISO) {
  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: 'main',
      since: sinceDateISO,
      path: 'package.json',
      per_page: 50, // Should be enough for e.g. 15 days lookback
    });

    const versionBumps = [];

    // Process commits in parallel for better performance
    const commitPromises = commits.map(async (commit) => {
      try {
        const { data: commitData } = await octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: commit.sha,
        });

        const packageJsonFile = commitData.files?.find(
          (file) => file.filename === 'package.json',
        );
        if (packageJsonFile?.patch) {
          const versionChange = parseVersionFromPatch(packageJsonFile.patch);
          if (versionChange) {
            return {
              sha: commit.sha,
              date: commit.commit.committer.date,
              message: commit.commit.message,
              ...versionChange,
            };
          }
        }
      } catch (error) {
        console.log(
          `⚠️ Failed to analyze commit ${commit.sha}: ${error.message}`,
        );
      }
      return null;
    });

    const results = await Promise.all(commitPromises);
    versionBumps.push(...results.filter(Boolean));

    // Sort by date (newest first)
    return versionBumps.sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch (error) {
    console.log(`⚠️ Failed to find version bumps: ${error.message}`);
    return [];
  }
}

// Automated test detection functions
async function fetchPRFiles(owner, repo, prNumber) {
  try {
    const allFiles = [];
    let page = 1;

    while (true) {
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      allFiles.push(...files);

      // If we got less than 100 files, we've reached the end
      if (files.length < 100) {
        break;
      }

      page += 1;
      await sleep(100);
    }

    return allFiles.map((file) => file.filename);
  } catch (error) {
    console.log(
      `⚠️ Failed to fetch files for PR #${prNumber}: ${error.message}`,
    );
    return null; // Return null to indicate API failure
  }
}

function checkFilesForAutomatedTestPatterns(filenames) {
  if (!filenames || filenames.length === 0) {
    return false;
  }

  // Debug logging to help identify pattern matching issues
  const matches = filenames.filter((filename) =>
    AUTOMATED_TEST_PATTERNS.some((pattern) => pattern.test(filename)),
  );

  return matches.length > 0;
}

async function checkAutomatedTestFiles(owner, repo, prNumber) {
  const cacheKey = `${owner}/${repo}/${prNumber}`;
  if (automatedTestCache.has(cacheKey)) {
    return automatedTestCache.get(cacheKey);
  }

  const filenames = await fetchPRFiles(owner, repo, prNumber);
  let result;

  if (filenames === null) {
    result = 'Unknown'; // API error
  } else if (checkFilesForAutomatedTestPatterns(filenames)) {
    result = 'Yes';
  } else {
    result = 'No';
  }

  automatedTestCache.set(cacheKey, result);
  return result;
}

async function removePrePrefixFromSheet(authClient, sheetTitle) {
  try {
    // Only process if the title has the "pre-" prefix
    if (!sheetTitle.startsWith('pre-')) {
      console.log(
        `ℹ️ Sheet "${sheetTitle}" doesn't have "pre-" prefix, skipping rename`,
      );
      return false;
    }

    const newTitle = sheetTitle.replace(/^pre-/u, '');

    // Get sheet metadata to find the sheetId
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      auth: authClient,
      fields: 'sheets(properties(sheetId,title))',
    });

    const sheet = meta.data.sheets?.find(
      (candidate) => candidate.properties?.title === sheetTitle,
    );
    if (!sheet) {
      console.log(`⚠️ Sheet "${sheetTitle}" not found for renaming`);
      return false;
    }

    const { sheetId } = sheet.properties;

    // Rename the sheet by removing "pre-" prefix
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      auth: authClient,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                title: newTitle,
              },
              fields: 'title',
            },
          },
        ],
      },
    });

    console.log(`✅ Renamed sheet: "${sheetTitle}" → "${newTitle}"`);
    return true;
  } catch (error) {
    console.log(`⚠️ Failed to rename "${sheetTitle}": ${error.message}`);
    return false;
  }
}

async function processTab(authClient, title, entries, platformType) {
  const { sheetId, actualTitle, isNew } = await ensureSheetExists(
    authClient,
    title,
    platformType,
  );
  const existing = await readRows(authClient, actualTitle);
  console.log(
    `Tab=${actualTitle} existingRows=${existing.length}, incomingRows=${entries.length}`,
  );
  const existingKeys = new Set(
    existing
      .map((row) => parsePrNumberFromCell(row[0]))
      .filter((number) => number !== null)
      .map((number) => uniqKey(number)),
  );
  const sortedRows = entries
    .slice()
    .sort((a, b) => new Date(a.mergedAtIso) - new Date(b.mergedAtIso))
    .map((entry) => applyAutoSkipToRow(entry.row, entry.labels, targetRepo));
  const deduped = [];
  for (const row of sortedRows) {
    const prNumber = parsePrNumberFromCell(row[0]);
    const key = prNumber === null ? null : uniqKey(prNumber);
    if (!key || !existingKeys.has(key)) {
      deduped.push(row);
      if (key) {
        existingKeys.add(key);
      }
    }
  }
  console.log(`Tab=${actualTitle} toInsertAfterDedup=${deduped.length}`);
  let inserted = 0;
  if (deduped.length) {
    await appendRows(authClient, actualTitle, deduped);
    inserted += deduped.length;
  }
  if (isNew) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      auth: authClient,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
            },
          },
        ],
      },
    });
  }
  return { inserted, isNew, actualTitle };
}

async function processRepo(authClient, owner, repo, since) {
  console.log(`\nScanning ${owner}/${repo}...`);
  let insertedThisRepo = 0;
  const items = await fetchMergedPRsSince(owner, repo, since);
  const { relevant, skippedByTitle } = splitByReleaseAndTitle(items);

  console.log(
    `[${owner}/${repo}] API items=${items.length}, relevantByTitle=${relevant.length}, skippedByTitle=${skippedByTitle}`,
  );

  // Sort relevant items by merge time before grouping into tabs
  const sortedRelevant = relevant
    .slice()
    .sort((a, b) => new Date(a.closed_at || '') - new Date(b.closed_at || ''));
  const tabToRows = await buildTabGrouping(owner, repo, sortedRelevant, since);

  // Convert tabs to array and sort by version (newest first)
  const tabsArray = Array.from(tabToRows.entries()).map(([title, group]) => ({
    title,
    group,
  }));

  // Sort tabs by extracting version numbers for proper ordering
  tabsArray.sort((a, b) => {
    const versionA = a.title.match(/v[\d.]+/u)?.[0] || '';
    const versionB = b.title.match(/v[\d.]+/u)?.[0] || '';
    return versionB.localeCompare(versionA, undefined, { numeric: true });
  });

  // Process all tabs and collect their actual titles
  const processedTabs = [];
  for (const { title, group } of tabsArray) {
    const { inserted, isNew, actualTitle } = await processTab(
      authClient,
      title,
      group.entries,
      group.platformType,
    );
    insertedThisRepo += inserted;
    processedTabs.push({ title, actualTitle, isNew });
  }

  // After processing all tabs, rename all except the newest one (remove "pre-" prefix)
  // The newest version keeps "pre-" because it's still in development
  if (processedTabs.length > 1) {
    for (let i = 1; i < processedTabs.length; i++) {
      const tab = processedTabs[i];
      console.log(
        `🔄 Removing "pre-" prefix from older version: "${tab.actualTitle}"`,
      );
      await removePrePrefixFromSheet(authClient, tab.actualTitle);
    }
  }

  console.log(`✅ [${owner}/${repo}] Inserted PRs: ${insertedThisRepo}`);
  return { insertedThisRepo };
}

async function main() {
  const authClient = await getGoogleAuth();
  const { owner, repo: repoName } = parseRepo();
  const since = isoSinceAtUTC(LOOKBACK_DAYS, START_HOUR_UTC, START_MINUTE_UTC);
  console.log(
    `Starting post-merge validation tracker. Mode=Sheets; Since(UTC)=${since}; Repo=${owner}/${repoName}`,
  );

  await processRepo(authClient, owner, repoName, since);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
