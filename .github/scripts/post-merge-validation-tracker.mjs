import { google } from 'googleapis';
import { Octokit } from '@octokit/rest';

const githubToken = process.env.GITHUB_TOKEN;
const spreadsheetId = process.env.SHEET_ID;
const googleApplicationCredentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

const REPOS = [
  // 'MetaMask/metamask-mobile'
  'MetaMask/metamask-extension'
];

const RELEASE_LABEL_PATTERN = /^release-(v?\d+\.\d+\.\d+)$/i;
const RELEVANT_TITLE_REGEX = /^(feat|perf)(\(|:|!)|(\b)bump(\b)/i;
const TEAM_LABEL_PREFIX = 'team-';
const SIZE_LABEL_PREFIX = 'size-';
const LOOKBACK_DAYS = 2;

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
  // Strategy: use fast GitHub search API, then add package.json version detection
  const since = new Date(sinceDateISO);
  const sinceDate = since.toISOString().split('T')[0];
  const prs = [];
  let page = 1;

  while (true) {
    console.log(`Fetching merged PRs page ${page} for ${owner}/${repo} (since ${sinceDateISO})...`);

    try {
      const query = `repo:${owner}/${repo} is:pr is:merged base:main merged:>=${sinceDate}`;

      const { data } = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page,
        advanced_search: true  // ← This stops the deprecation warning
      });

      if (!data.items.length) break;
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
              base_ref: 'main'
            });
          }
        }
      }

      if (data.items.length < 100) break;
      page++;
      await sleep(200);
    } catch (e) {
      console.log(`❌ Search API error: ${e.message}`);
      break;
    }
  }

  console.log(`Found ${prs.length} merged PRs since ${sinceDateISO} for ${owner}/${repo}`);
  return prs;
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
  // Sort relevant items by merge time before grouping into tabs
  const sortedRelevant = relevant.slice().sort((a, b) => new Date(a.closed_at || '') - new Date(b.closed_at || ''));
  const tabToRows = buildTabGrouping(repo, sortedRelevant);
  for (const [title, group] of tabToRows.entries()) {
    const inserted = await processTab(authClient, title, group.entries, group.platformType);
    insertedThisRepo += inserted;
  }
  console.log(`✅ [${owner}/${repo}] Inserted PRs: ${insertedThisRepo}`);
  if (skippedMissingReleaseThisRepo.length) {
    console.log(`⚠️ [${owner}/${repo}] Skipped (no release label): ${skippedMissingReleaseThisRepo.length}`);
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