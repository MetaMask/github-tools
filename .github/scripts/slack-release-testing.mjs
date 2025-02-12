import { google } from 'googleapis';
import { WebClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';

// Clients
const sheets = google.sheets('v4');
const token = process.env.SLACK_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const slackClient = new WebClient(token);
const octokit = new Octokit({
    auth: githubToken
  });

let slackTeamsMap = null; // This will store the mapping of slack team names to IDs


  /**
 * Retrieves and returns a Google authentication client.
 *
 * This function initializes a GoogleAuth object with a specific key file
 * and predefined scopes necessary for accessing Google Sheets API. It 
 * returns a client instance that can be used to authenticate API requests.
 *
 * @returns {Promise<google.auth.OAuth2Client>} Returns a promise that resolves 
 *          to an instance of OAuth2Client which can be used to authenticate 
 *          Google API requests.
 */
async function getGoogleAuth() {

    // Decode base64 string from the environment variable
    const credentialsJson = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf8');
    
    // Parse the JSON string to an object
    const credentials = JSON.parse(credentialsJson);

    // Initialize GoogleAuth with credentials object directly
    const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return auth.getClient();
}

/**
 * Initializes the group map by fetching user groups from Slack and mapping their names to IDs.
 */
async function initializeSlackTeams() {
    try {
        const response = await slackClient.usergroups.list({ include_disabled: false });

        if (response.ok && response.usergroups) {
            slackTeamsMap = response.usergroups.reduce((map, group) => {
                map[group.name] = group.id;
                return map;
            }, {});
        } else {
            throw new Error(`Failed to load user groups: ${response.error}`);
        }
    } catch (error) {
        console.error('Error initializing group map:', error);
        throw error;
    }

    console.log('Slack Teams initialized with size of', Object.keys(slackTeamsMap).length);
}

/**
 * Parses release update data from a structured text input into a structured JSON array.
 * The expected line format is:
 * Emoji: *Team Name* - @SlackHandle There are X total changes. *Pending validation:* Y. *Status:* Z
 *
 * @param {string} data Multiline string containing release update information for multiple teams.
 * @returns {Array<Object>} An array of objects, each representing the parsed data of a team's release update.
 *          Each object includes properties for emoji, team name, Slack handle, changes, pending validations,
 *          and status, all extracted and converted from the string data.
 */
function parseReleaseUpdates(data) {
    const lines = data.split('\n');
    const result = [];

    const regex = /(.*?):\s+\*(.*?)\*\s+-\s+@(.*?)\s+There (?:is|are) (\d+) .*? changes\. \*Pending validation:\* (\d+)\. \*Status:\* (.*)/;

    lines.forEach(line => {
        const match = line.match(regex);
        if (match) {
            const [_, emoji, team, slackHandle, changes, pendingValidations, status] = match;
            result.push({
                emoji: emoji.trim(),
                team: team.trim(),
                slackHandle: slackHandle.trim(),
                changes: parseInt(changes),
                pendingValidations: parseInt(pendingValidations),
                status: status.trim()
            });
        }
    });

    return result;
}


/**
 * Determines the release branch for a given platform/version
 * @param {string} platform 'mobile' or 'extension'
 * @param {string} version semantic version
 * @returns 
 */
function getReleaseBranchName(platform, version) {
    let releaseBranchName;

    if (platform === "mobile") {
        releaseBranchName = `release/${version}`;
    } else if (platform === "extension") {
        releaseBranchName = `Version-v${version}`;
    } else {
        throw new Error(`Unknown platform '${platform}'. Must be 'mobile' or 'extension'.`);
    }

    return releaseBranchName;
}

/**
 * Retrieves the URL of the first pull request for a given branch in a specified GitHub repository.
 *
 * @param {string} owner - The GitHub username or organization name that owns the repository.
 * @param {string} repo - The name of the repository.
 * @param {string} branchName - The name of the branch for which to find pull requests.
 * @returns {Promise<string>} A promise that resolves to the URL of the first pull request matching the branch name.
 * @throws {Error} Throws an error if no pull requests are found for the branch or if there is a problem fetching pull requests.
 */
async function findPullRequestUrlByBranch(owner, repo, branchName) {
    try {
      // Fetch pull requests that match the branch name
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`, // Ensure to include the owner prefix if needed
        state: 'all' 
      });
  
      // Check if there are any pull requests returned
      if (data.length > 0) {
        // Assuming you want the first PR that matches
        return data[0].html_url; // Return the URL of the first matching PR
      } else {
        throw new Error(`No pull requests found for branch ${branchName}`);
      }
    } catch (error) {
      console.error('Error fetching pull requests:', error);
      throw error;
    }
  }

  /**
 * retrieves a list of active releases from a Google Sheets document.
 * Each sheet in the document represents a different release. Only sheets with visible
 * titles containing a semantic version and optionally a platform within parentheses
 * are considered. Each active release is identified by parsing the sheet's title
 * for semantic versioning and platform details.
 *
 * @param {string} documentId - The ID of the Google Sheets document to query.
 * @returns {Promise<Object[]>} A promise that resolves to an array of objects, each representing
 * an active release with properties for the document ID, semantic version, platform,
 * sheet ID, and the testing status.
 * @throws {Error} Throws an error if there is an issue retrieving data from the spreadsheet.
 *
 */
async function GetActiveReleases(documentId) {
    const authClient = await getGoogleAuth();

    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: documentId,
            auth: authClient,
            fields: 'sheets(properties(title,sheetId,hidden))',
        });

        const sheetsData = response.data.sheets;
        if (!sheetsData) {
            console.log('No sheets found in the spreadsheet.');
            return [];
        }

        // Create a list of promises for each sheet using map
        const promises = sheetsData.filter(sheet => !sheet.properties.hidden).map(async (sheet) => {
            const { title } = sheet.properties;
            const versionMatch = title.match(/v(\d+\.\d+\.\d+)/);
            const platformMatch = title.match(/\(([^)]+)\)/);

            if (!versionMatch) {
                console.log(`Skipping sheet: ${title} - Semantic version not found.`);
                return null; // Skip this sheet because we couldn't determine the semantic version
            }

            // Await inside async map callback
            const testingStatusData = await readSheetData(documentId, title, 'J1:J1');

            return {
                DocumentId: documentId,
                SemanticVersion: versionMatch[1],
                Platform: platformMatch ? platformMatch[1] : 'extension',
                sheetId: sheet.properties.sheetId,
                testingStatus: testingStatusData ? testingStatusData[0][0] : 'Unknown'
            };
        });

        // Filter out null values (sheets that were skipped) and resolve all promises
        const results = await Promise.all(promises);
        return results.filter(result => result !== null);

    } catch (err) {
        console.error('Failed to retrieve spreadsheet data:', err);
        throw err;
    }
}

/**
 * Reads data from a specified cell or range in a single sheet within a Google Spreadsheet.
 * @param {string} spreadsheetId - The ID of the Google Spreadsheet.
 * @param {string} sheetName - The name of the sheet within the spreadsheet.
 * @param {string} cellRange - The A1 notation of the range to read (e.g., 'A1', 'A1:B2').
 * @returns {Promise<string[][]>} The data read from the specified range, or undefined if no data.
 */
async function readSheetData(spreadsheetId, sheetName, cellRange) {
    const authClient = await getGoogleAuth();

    try {
        const range = `${sheetName}!${cellRange}`;
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range,
            auth: authClient,
        });

        return result.data.values;

    } catch (err) {
        console.error('Failed to read data from the sheet:', err);
        throw err;
    }
}

/**
 * fetches the count and details of GitHub issues marked as release blockers
 * for a specific version and team. This function queries GitHub issues that are tagged with
 * specific labels related to the release version, team, and a "release-blocker" label.
 *
 * @param {Object} release - An object representing the release
 * @param{Object} team - An object representing the team
 * @returns {Promise<Object>} A promise that resolves to an object containing the count of open release-blocking issues,
 * a URL to view these issues on GitHub, and optionally an array of issue objects.
 * @throws {Error} Throws an error if the GitHub API call fails.
 *
 */
async function getReleaseBlockers(release, team) {

    const versionLabel = `regression-RC-${release.SemanticVersion}`;

    const teamLabel = `team-${team}`.toLowerCase();
    const owner = 'MetaMask'; // Replace with the GitHub owner
    const repo = `metamask-${release.Platform}`

    const labels = `${versionLabel},${teamLabel},release-blocker`;
    try {
        const { data } = await octokit.rest.issues.listForRepo({
            owner,
            repo,
            labels: labels,
            state: 'open' // Optionally, filter by state (open, closed, all)
        });

        const issuesCount = data.length;
        const issuesUrl = `https://github.com/${owner}/${repo}/issues?q=is:issue+is:open+label:${encodeURIComponent(versionLabel)}+label:${encodeURIComponent(teamLabel)}+label:release-blocker`;

        return {
            count: issuesCount,
            url: issuesUrl,
            issues: data // Optionally include this if you want the issue data
        };
        
    } catch (error) {
        console.error('Failed to fetch issues:', error);
        return error;
    }
}

/**
 * Determine the Slack channel name to publish to based on the release
 * @param {*} release 
 */
async function getPublishChannelName(release) {

    // convert the version to a format that can be used in a channel name
    const formattedVersion = release.SemanticVersion.replace(/\./g, '-'); 

    const channel = `#release-${release.Platform}-${formattedVersion}`;

    // Allows for local testing without publishing actual release channels
    if (testOnly()) {
        return `${channel}-testonly`;
    } else {
        return channel;
    }

}

async function fmtSlackHandle(team) {

    //Notify if they have pending validations or have not completed signoff
    const shouldNotify = team.pendingValidations > 0 || team.status.trim().toLowerCase() !== 'completed';
    //Don't notify teams when in testOnly mode
    if (testOnly()) {
      return shouldNotify ? ` - @${team.slackHandle}` : '';  
    }

    //Lookup Slack Team Id for real notifications
    const slackTeamId = slackTeamsMap[teamName];
    return shouldNotify ? ` - <!subteam^${slackTeamId}>` : '';
}

/**
 * Publishes the testing status for a release to the appropriate Slack channel
 * @param {Object} release represents a release
 */
async function publishReleaseTestingStatus(release) {

    const fmtPlatform = formatTitle(release.Platform);
    const teamResults = parseReleaseUpdates(release.testingStatus);
    const releasePrUrl = await findPullRequestUrlByBranch('MetaMask', `metamask-${release.Platform}`, getReleaseBranchName(release.Platform, release.SemanticVersion));
    const channel = await getPublishChannelName(release);

    console.log(`Publishing testing status for release ${release.SemanticVersion} on platform ${release.Platform} to channel ${channel}`);

    //Determine notification counts for this release
    const testingDocumentLink = createSheetUrl(release.DocumentId, release.sheetId);


    var header = `:blablablocker:* [${fmtPlatform}] - ${release.SemanticVersion} Release Validation.*\n`
    + `_*Testing Plan and Progress Tracker Summary*_ (<https://docs.google.com/spreadsheets/d/${release.DocumentId}/edit#gid=${release.sheetId}|${release.SemanticVersion}>):`;

    var body = `*Teams Sign Off ${release.SemanticVersion} Release on <${releasePrUrl}|GH>:*\n`

    const hasPendingSignoffs = teamResults.some(team => team.status !== "Completed");

    let releaseBlockerCount = 0;

    for (const team of teamResults) {
        let slackHandlePart = await fmtSlackHandle(team);
        //Grab RCs for a specific team/release
        const releaseBlockers = await getReleaseBlockers(release, team.team);
        //Accumulate the total release blocker count
        releaseBlockerCount += releaseBlockers.count;
        let releaseBlockerParts = releaseBlockers.count > 0 ? ` - <${releaseBlockers.url}|${releaseBlockers.count} Release Blockers>` : '';
    
        body += `${team.emoji}: *${team.team}*${slackHandlePart}${releaseBlockerParts}\n`;
    }

    if (hasPendingSignoffs) {
        header += `\n:bell: *Status Update*: Several Release Signs Offs are still Pending. There are ${releaseBlockerCount} open Release Blockers.\n`;
    }

    const footer = `*Important Reminder:*\nPlease be aware of the importance of starting your testing immediately to ensure there is sufficient time to address any unexpected defects. This proactive approach will help prevent release delays and minimize the impact on other teams’ deliveries.`;

    const slackMessage = `${header}\n${body}\n${footer}`;


    try {
        await slackClient.chat.postMessage({
          channel: channel,
          text: slackMessage,
          unfurl_links: false,
            unfurl_media: false,
        });
    
        console.log(`Message successfully sent to channel ${channel} for release ${release.SemanticVersion} on platform ${release.Platform}.`);
        
      } catch (error) {
        console.error('API error:', error);
        throw error;
      }
}


/**
 * publishes the testing status for a list of releases. 
 *
 * @param {Object[]} releases - An array of release objects. Each release object should be suitable
 * for use with the `publishReleaseTestingStatus` function.
 * @throws {Error} Throws an error if the publishing process fails for one or more releases.
 *
 */
async function publishReleasesTestingStatus(releases) {

    console.log('Publishing testing status for all active releases...');

    try {
        const promises = releases.map(release => publishReleaseTestingStatus(release));
        await Promise.all(promises);
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
}

async function main() {

    const documentId = process.env.GOOG_DOCUMENT_ID; 

    if (!documentId) {
        console.error("Document ID is not set. Please set the GOOG_DOCUMENT_ID environment variable.");
        return;
    }

    const platform = process.env.PLATFORM;

    if (!platform) {
        console.error("Platform is not set. Please set the PLATFORM environment variable.");
        return;
    }

    await initializeSlackTeams();

    const activeReleases = await GetActiveReleases(documentId);

    // Filter active releases based on the platform
    const filteredReleases = activeReleases.filter(release => release.Platform === platform);

    filteredReleases.forEach(release => {
        console.log(`Version: ${release.SemanticVersion}, Platform: ${release.Platform}, Sheet ID: ${release.sheetId}`);
    });

    await publishReleasesTestingStatus(filteredReleases);
}

//Entrypoint
main();


// Helper functions
function formatTitle(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function testOnly() {
    return process.env.TEST_ONLY === 'true';
}

function createSheetUrl(documentId, sheetId) {
    return `https://docs.google.com/spreadsheets/d/${documentId}/edit#gid=${sheetId}`;
}
