import { google } from 'googleapis';
import { Octokit } from '@octokit/rest';

const githubToken = process.env.GITHUB_TOKEN;
const spreadsheetId = process.env.SHEET_ID;
const googleApplicationCredentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

const REPOS = [
  'MetaMask/metamask-mobile',
  'MetaMask/metamask-extension'
];

const RELEASE_LABEL_PATTERN = /^release-(v?\d+\.\d+\.\d+)$/i;
const RELEVANT_TITLE_REGEX = /^(feat|perf)(\(|:|!)/i;
const TEAM_LABEL_PREFIX = 'team-';
const SIZE_LABEL_PREFIX = 'size-';
const LOOKBACK_DAYS = 1;

// When the window starts each day (UTC)
const START_HOUR_UTC = 7;
const START_MINUTE_UTC = 0;

if (!githubToken) throw new Error('Missing GITHUB_TOKEN env var');
if (!spreadsheetId) throw new Error('Missing SHEET_ID env var');
if (!googleApplicationCredentialsBase64)
  throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64 env var');

const octokit = new Octokit({ auth: githubToken });
const sheets = google.sheets('v4');

async function getGoogleAuth() {
  const credentials = JSON.parse(Buffer.from(googleApplicationCredentialsBase64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

function getRepos() {
  return REPOS.map((p) => {
    const [owner, repo] = p.split('/');
    if (!owner || !repo) throw new Error(`Invalid repo "${p}"`);
    return { owner, repo };
  });
}

function repoType(repo) {
  if (repo.endsWith('-extension')) return 'extension';
  if (repo.endsWith('-mobile')) return 'mobile';
  return repo;
}

function tabTitleFor(repo, releaseLabel) {
  return `pre-${releaseLabel} (${repoType(repo)})`;
}

function headerRowFor(type) {
  const isMobile = String(type).toLowerCase() === 'mobile';
  const colF = isMobile ? 'Validated (Android)' : 'Validated (Chrome)';
  const colG = isMobile ? 'Validated (iOS)' : 'Validated (Firefox)';
  return [
    'Pull Request',
    'Merged Time (UTC)',
    'Author',
    'PR Size',
    'Team Responsible',
    colF,
    colG,
    'Comments',
  ];
}

function platformLabelFor(type) {
  const t = String(type).toLowerCase();
  if (t === 'mobile') return '📱 Mobile';
  if (t === 'extension') return '🔌 Extension';
  return t;
}

async function ensureSheetExists(authClient, title, platformType) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    auth: authClient,
    fields: 'sheets(properties(sheetId,title))',
  });

  const sheetsList = meta.data.sheets || [];
  const existing = sheetsList.find((s) => s.properties?.title === title);
  if (existing) return { sheetId: existing.properties.sheetId, isNew: false };

  return createSheetFromTemplateOrBlank(authClient, sheetsList, title, platformType);
}

async function createSheetFromTemplateOrBlank(authClient, sheetsList, title, platformType) {
  // Try to duplicate from a template tab (single template name: 'template')
  const templateCandidates = ['template'];
  const template = sheetsList.find((s) => templateCandidates.includes(s.properties?.title || ''));

  if (template?.properties?.sheetId != null) {
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
    const newSheetId = duplicateRes.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
    // Write platform label in A1 and platform-specific labels; keep row 2 headers from template to preserve formatting
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      auth: authClient,
      range: `${title}!A1:A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[platformLabelFor(platformType)]] },
    });
    // Overwrite entire row 2 with headerRowFor(type)
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      auth: authClient,
      range: `${title}!A2:H2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headerRowFor(platformType)] },
    });
    // Insert a blank row at index 2 (0-based) so data can start at row 4
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
              range: { sheetId: newSheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
    console.log(`Duplicated template '${template.properties.title}' → '${title}' and set platform label for type '${platformType}'`);
    return { sheetId: newSheetId, isNew: true };
  }

  // No template found: log fail message and create a blank tab
  console.log(`❌ Template not found for new tab '${title}'. Candidates tried: ${templateCandidates.join(', ')}. Falling back to blank sheet.`);
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
  // Write platform label in A1 and dynamic headers in row 2
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A1:A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[platformLabelFor(platformType)]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A2:H2`,
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
      range: `${title}!A3:H`,
    });
    return res.data.values || [];
  } catch (e) {
    // If the sheet or range doesn't exist yet
    return [];
  }
}

async function appendRows(authClient, title, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A4:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

function uniqKey(number) {
  return String(number);
}

function formatDateHumanUTC(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function makePrHyperlinkCell(url, title, number) {
  const label = `${title} (#${number})`;
  // Sheets formula
  const escapedUrl = url.replace(/"/g, '');
  const escapedLabel = label.replace(/"/g, '');
  return `=HYPERLINK("${escapedUrl}","${escapedLabel}")`;
}

function extractTeam(labels) {
  const found = labels.find((l) => l.name?.startsWith(TEAM_LABEL_PREFIX));
  return found ? found.name : 'unknown';
}

function extractSize(labels) {
  const found = labels.find((l) => l.name?.startsWith(SIZE_LABEL_PREFIX));
  return found ? found.name : 'unknown';
}

function extractReleaseVersionFromLabelName(labelName) {
  if (!labelName) return null;
  const match = labelName.match(RELEASE_LABEL_PATTERN);
  if (!match) return null;
  const raw = match[1];
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function findReleaseLabel(labels) {
  for (const l of labels || []) {
    const version = extractReleaseVersionFromLabelName(l.name || '');
    if (version) return version; // return normalized version like 'v10.4.0'
  }
  return null;
}

function isoSinceAtUTC(days, hour = 2, minute = 0) {
  // Returns an ISO timestamp at (today - days) with specific UTC hour:minute, e.g., 02:00Z
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0,
  ));
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

async function fetchMergedPRsSince(owner, repo, sinceDateISO) {
  // Strategy: list commits on main since timestamp, map commits -> associated PRs, dedupe, then fetch PR details
  const since = new Date(sinceDateISO);
  const per_page = 100;
  let page = 1;
  const commitShas = [];

  while (true) {
    console.log(`Fetching commits page ${page} for ${owner}/${repo} (since ${sinceDateISO})...`);
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: 'main',
      since: sinceDateISO,
      per_page,
      page,
    });
    if (!data.length) break;
    for (const c of data) commitShas.push(c.sha);
    if (data.length < per_page) break;
    page += 1;
  }

  // Collect unique PR numbers associated with these commits
  const prNumbers = new Set();
  console.log(`Total commits fetched on main since ${sinceDateISO}: ${commitShas.length}`);
  let commitIndex = 0;
  for (const sha of commitShas) {
    try {
      const prs = await listPRsForCommitWithRetry(owner, repo, sha);
      for (const pr of prs) {
        if (pr.base?.ref === 'main') prNumbers.add(pr.number);
      }
    } catch (e) {
      const status = e?.status || e?.response?.status || 'n/a';
      console.log(`Warn: failed to list PRs for commit ${sha}: status=${status} msg=${e?.message}`);
    }
    commitIndex += 1;
    if (commitIndex % 50 === 0 || commitIndex === commitShas.length) {
      console.log(`Processed commits: ${commitIndex}/${commitShas.length} → unique PRs: ${prNumbers.size}`);
    }
    // Gentle pacing to avoid bursts
    await sleep(100);
  }

  // Fetch PR details and labels; keep only merged since threshold
  const enriched = [];
  const prList = Array.from(prNumbers);
  console.log(`Unique PRs associated with commits: ${prList.length}`);
  for (let i = 0; i < prList.length; i += 1) {
    const number = prList[i];
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
      if (!pr.merged_at) continue;
      const mergedAt = new Date(pr.merged_at);
      if (mergedAt < since) continue;
      let labels = [];
      try {
        const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
        labels = issue.labels || [];
      } catch (e) {
        labels = [];
      }
      enriched.push({
        number,
        title: pr.title,
        html_url: pr.html_url,
        user: { login: pr.user?.login || '' },
        labels,
        closed_at: pr.merged_at,
        base_ref: pr.base?.ref || '',
      });
    } catch (e) {
      console.log(`❌ FAILED: failed to fetch PR #${number}: ${e.message}`);
    }
    if ((i + 1) % 10 === 0 || i + 1 === prList.length) {
      console.log(`Fetched PR details: ${i + 1}/${prList.length}`);
    }
    await sleep(50);
  }

  console.log(`Found ${enriched.length} merged PR(s) since ${sinceDateISO} for ${owner}/${repo}`);
  return enriched;
}

function isRelevantTitle(title) {
  if (!title) return false;
  return RELEVANT_TITLE_REGEX.test(String(title));
}

function extractLabelText(formulaOrText) {
  const s = String(formulaOrText || '');
  // If it's a HYPERLINK formula like =HYPERLINK("url","Label") extract Label
  const m = s.match(/HYPERLINK\([^,]+,\s*"([^"]+)"\)/i);
  if (m) return m[1];
  return s;
}

function parsePrNumberFromCell(cell) {
  const text = extractLabelText(cell);
  const m = String(text).match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listPRsForCommitWithRetry(owner, repo, sha, maxRetries = 3) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    try {
      const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: sha,
      });
      return data;
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status || 'n/a';
      const backoff = 200;
      console.log(`Retry ${attempt + 1}/${maxRetries} listPRsForCommit sha=${sha} status=${status} backoff=${backoff}ms`);
      await sleep(backoff);
    }
    attempt += 1;
  }
  throw lastErr;
}

function splitByReleaseAndTitle(items) {
  const candidates = items.filter((it) => findReleaseLabel(it.labels || []));
  const missing = items.filter((it) => !findReleaseLabel(it.labels || []));
  const relevant = [];
  let skippedByTitle = 0;
  for (const it of candidates) {
    if (isRelevantTitle(it.title)) relevant.push(it);
    else skippedByTitle += 1;
  }
  return { candidates, missing, relevant, skippedByTitle };
}

function buildTabGrouping(repo, relevantItems) {
  const tabToRows = new Map();
  const platformType = repoType(repo);
  for (const it of relevantItems) {
    const releaseVersion = findReleaseLabel(it.labels || []);
    if (!releaseVersion) continue;
    const title = tabTitleFor(repo, releaseVersion);
    if (!tabToRows.has(title)) tabToRows.set(title, { entries: [], platformType });
    const row = [
      makePrHyperlinkCell(it.html_url, it.title, it.number),
      formatDateHumanUTC(it.closed_at || ''),
      it.user.login,
      extractSize(it.labels || []),
      extractTeam(it.labels || []),
      '',
      '',
      '',
    ];
    tabToRows.get(title).entries.push({ row, mergedAtIso: it.closed_at || '' });
  }
  return tabToRows;
}

async function processTab(authClient, title, entries, platformType) {
  const { sheetId, isNew } = await ensureSheetExists(authClient, title, platformType);
  const existing = await readRows(authClient, title);
  console.log(`Tab=${title} existingRows=${existing.length}, incomingRows=${entries.length}`);
  const existingKeys = new Set(
    existing
      .map((r) => parsePrNumberFromCell(r[0]))
      .filter((n) => n !== null)
      .map((n) => uniqKey(n)),
  );
  const sortedRows = entries
    .slice()
    .sort((a, b) => new Date(a.mergedAtIso) - new Date(b.mergedAtIso))
    .map((e) => e.row);
  const deduped = [];
  for (const r of sortedRows) {
    const num = parsePrNumberFromCell(r[0]);
    const key = num !== null ? uniqKey(num) : null;
    if (!key || !existingKeys.has(key)) {
      deduped.push(r);
      if (key) existingKeys.add(key);
    }
  }
  console.log(`Tab=${title} toInsertAfterDedup=${deduped.length}`);
  let inserted = 0;
  if (deduped.length) {
    await appendRows(authClient, title, deduped);
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
              range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
            },
          },
        ],
      },
    });
  }
  return inserted;
}

async function processRepo(authClient, owner, repo, since) {
  console.log(`\nScanning ${owner}/${repo}...`);
  let insertedThisRepo = 0;
  const skippedMissingReleaseThisRepo = [];
  const items = await fetchMergedPRsSince(owner, repo, since);
  const { candidates, missing, relevant, skippedByTitle } = splitByReleaseAndTitle(items);
  for (const it of missing) {
    if (it.html_url) skippedMissingReleaseThisRepo.push(it.html_url);
  }
  console.log(
    `[${owner}/${repo}] API items=${items.length}, candidatesWithRelease=${candidates.length}, missingRelease=${missing.length}, relevantByTitle=${relevant.length}, skippedByTitle=${skippedByTitle}`,
  );
  const tabToRows = buildTabGrouping(repo, relevant);
  for (const [title, group] of tabToRows.entries()) {
    const inserted = await processTab(authClient, title, group.entries, group.platformType);
    insertedThisRepo += inserted;
  }
  console.log(`✅ [${owner}/${repo}] Inserted PRs: ${insertedThisRepo}`);
  if (skippedMissingReleaseThisRepo.length) {
    console.log(`[${owner}/${repo}] Skipped (no release label): ${skippedMissingReleaseThisRepo.length}`);
    for (const url of skippedMissingReleaseThisRepo) console.log(`- ${url}`);
  }
  return { insertedThisRepo, skippedMissingReleaseThisRepo };
}

async function main() {
  const authClient = await getGoogleAuth();
  const repos = getRepos();
  const since = isoSinceAtUTC(LOOKBACK_DAYS, START_HOUR_UTC, START_MINUTE_UTC);
  console.log(
    `Starting post-merge validation tracker. Mode=Sheets; Since(UTC)=${since}; Repos=${repos
      .map((r) => `${r.owner}/${r.repo}`)
      .join(', ')}`,
  );

  for (const { owner, repo } of repos) {
    await processRepo(authClient, owner, repo, since);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});