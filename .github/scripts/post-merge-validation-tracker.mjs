import { google } from 'googleapis';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';

const githubToken = process.env.GITHUB_TOKEN;
const outputCsvPath = process.env.OUTPUT_CSV_PATH || '';
const spreadsheetId = process.env.SHEET_ID;
const googleApplicationCredentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

const REPOS = [
  'MetaMask/metamask-mobile',
  // 'MetaMask/metamask-extension',
];

const RELEASE_LABEL_PATTERN = /^release-(v?\d+\.\d+\.\d+)$/i;
const TEAM_LABEL_PREFIX = 'team-';
const SIZE_LABEL_PREFIX = 'size-';
const LOOKBACK_DAYS = 1;

if (!githubToken) throw new Error('Missing GITHUB_TOKEN env var');
// Only require Sheets envs when OUTPUT_CSV_PATH is not set
if (!outputCsvPath) {
  if (!spreadsheetId) throw new Error('Missing SHEET_ID env var');
  if (!googleApplicationCredentialsBase64)
    throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64 env var');
}

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
  return `${repoType(repo)} ${releaseLabel}`;
}

function headerRow() {
  return [
    'PR', // HYPERLINK to PR with text: `${title} (#${number})`
    'PR #',
    'Size',
    'Merged At', // YYYY-MM-DD HH:mm (UTC)
    'Author',
    'Team',
    'Validated',
  ];
}

async function ensureSheetExists(authClient, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    auth: authClient,
  });

  const existing = (meta.data.sheets || []).find(
    (s) => s.properties?.title === title,
  );

  if (existing) return existing.properties.sheetId;

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

  const sheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  // write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    auth: authClient,
    range: `${title}!A1:G1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow()] },
  });

  return sheetId;
}

async function readRows(authClient, title) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      auth: authClient,
      range: `${title}!A2:G`,
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
    range: `${title}!A:G`,
    valueInputOption: 'RAW',
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

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  // Use date-only to align with GitHub search granularity
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchMergedPRsSince(owner, repo, sinceDateISO) {
  // Avoid Search API; list closed PRs by updated desc and break early when older than window
  const since = new Date(sinceDateISO);
  const enriched = [];
  let page = 1;
  const per_page = 100;

  /* eslint-disable no-constant-condition */
  while (true) {
    console.log(`Fetching PR page ${page} for ${owner}/${repo}...`);
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      per_page,
      page,
      sort: 'updated',
      direction: 'desc',
    });

    if (!data.length) break;

    let shouldBreak = false;
    for (const pr of data) {
      // Only consider PRs merged into main
      const baseRef = pr.base?.ref || '';
      if (baseRef !== 'main') {
        continue;
      }
      const updatedAt = new Date(pr.updated_at);
      if (updatedAt < since) {
        shouldBreak = true;
        break;
      }

      if (pr.merged_at && new Date(pr.merged_at) >= since) {
        let labels = [];
        try {
          const { data: issue } = await octokit.rest.issues.get({
            owner,
            repo,
            issue_number: pr.number,
          });
          labels = issue.labels || [];
        } catch (e) {
          console.log(`Warn: failed to load labels for #${pr.number}: ${e.message}`);
          labels = [];
        }

        enriched.push({
          number: pr.number,
          title: pr.title,
          html_url: pr.html_url,
          user: { login: pr.user?.login || '' },
          labels,
          closed_at: pr.merged_at,
          base_ref: baseRef,
        });
      }
    }

    if (shouldBreak) break;
    page += 1;
  }

  console.log(`Found ${enriched.length} merged PR(s) since ${sinceDateISO} for ${owner}/${repo}`);
  return enriched;
}

function isRelevantTitle(title) {
  if (!title) return false;
  // Match starts with one of the allowed types followed by (, : or !
  return /^(feat|fix|perf)(\(|:|!)/i.test(String(title));
}

async function main() {
  const authClient = outputCsvPath ? null : await getGoogleAuth();
  const repos = getRepos();
  const since = isoDaysAgo(LOOKBACK_DAYS);
  const collected = [];
  let totalInserted = 0;
  const skippedMissingRelease = [];
  console.log(
    `Starting post-merge validation tracker. Mode=${outputCsvPath ? 'CSV' : 'Sheets'}; Since=${since}; Repos=${repos
      .map((r) => `${r.owner}/${r.repo}`)
      .join(', ')}`,
  );

  for (const { owner, repo } of repos) {
    console.log(`\nScanning ${owner}/${repo}...`);
    const items = await fetchMergedPRsSince(owner, repo, since);

    // Filter to those that carry a release version label
    const candidates = items.filter((it) => findReleaseLabel(it.labels || []));
    const missing = items.filter((it) => !findReleaseLabel(it.labels || []));
    for (const it of missing) {
      if (it.html_url) skippedMissingRelease.push(it.html_url);
    }

    // Further filter by conventional commit type
    let relevant = [];
    let skippedByTitle = 0;
    for (const it of candidates) {
      const rel = isRelevantTitle(it.title);
      if (!rel) {
        skippedByTitle += 1;
        continue;
      }
      relevant.push(it);
    }

    // Group rows by tab title
    const tabToRows = new Map();
    for (const it of relevant) {
      const releaseVersion = findReleaseLabel(it.labels || []);
      if (!releaseVersion) continue;

      const title = tabTitleFor(repo, releaseVersion);
      if (!tabToRows.has(title)) tabToRows.set(title, []);

      const number = it.number;
      const row = [
        makePrHyperlinkCell(it.html_url, it.title, number),
        String(number),
        extractSize(it.labels || []),
        formatDateHumanUTC(it.closed_at || ''),
        it.user.login,
        extractTeam(it.labels || []),
        'FALSE',
      ];
      tabToRows.get(title).push(row);
    }

    // If OUTPUT_CSV_PATH set, collect for local CSV instead of writing to Sheets
    if (outputCsvPath) {
      for (const [title, newRows] of tabToRows.entries()) {
        collected.push({ title, rows: newRows });
        totalInserted += newRows.length;
      }
    } else {
      for (const [title, newRows] of tabToRows.entries()) {
        await ensureSheetExists(authClient, title);
        const existing = await readRows(authClient, title);
        // Column B contains the PR number
        const existingKeys = new Set(
          existing
            .map((r) => (r[1] ? uniqKey(Number(r[1])) : null))
            .filter(Boolean),
        );

        const deduped = newRows.filter((r) => {
          const key = r[1] ? uniqKey(Number(r[1])) : null;
          if (!key) return true;
          return !existingKeys.has(key);
        });

        if (deduped.length) {
          await appendRows(authClient, title, deduped);
          totalInserted += deduped.length;
        }
      }
    }
  }

  if (outputCsvPath && collected.length) {
    await writeCsv(outputCsvPath, collected);
  }

  // Final minimal summary
  console.log(`Inserted PRs: ${totalInserted}`);
  if (skippedMissingRelease.length) {
    console.log('Skipped (no release label):');
    for (const url of skippedMissingRelease) console.log(`- ${url}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Local testing helper: write combined CSV for all tabs
async function writeCsv(targetPath, collections) {
  const header = ['Tab', 'PR', 'Size', 'Merged At', 'Author', 'Team', 'Validated'];
  const lines = [header.join(',')];
  for (const { title, rows } of collections) {
    for (const r of rows) {
      // Strip formula in CSV label: display text only
      const label = extractLabelText(r[0]);
      const record = [title, label, r[1], r[2], r[3], r[4], r[5]];
      lines.push(record.map(escapeCsv).join(','));
    }
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, lines.join('\n'), 'utf8');
}

function extractLabelText(formulaOrText) {
  const s = String(formulaOrText || '');
  // If it's a HYPERLINK formula like =HYPERLINK("url","Label") extract Label
  const m = s.match(/HYPERLINK\([^,]+,\s*"([^"]+)"\)/i);
  if (m) return m[1];
  return s;
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}


