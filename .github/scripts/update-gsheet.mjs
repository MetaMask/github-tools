import { google } from 'googleapis';
import { WebClient } from '@slack/web-api';


const sheets = google.sheets('v4');
const token = process.env.SLACK_TOKEN;
const slackClient = new WebClient(token);

async function getGoogleAuth() {
    const auth = new google.auth.GoogleAuth({
        keyFile: '/Users/jakeperkins/Documents/AtomDocs/metamask-wallet-platform-f56ae6b41931.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return auth.getClient();

}

async function GetActiveReleases(spreadsheetId) {
    const authClient = await getGoogleAuth();

    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
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
            const testingStatusData = await readSheetData(spreadsheetId, title, 'J1:J1');

            return {
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
        return [];
    }
}


async function listSheets(spreadsheetId) {
    const authClient = await getGoogleAuth();

    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
            auth: authClient,
            fields: 'sheets.properties', // Correctly specify the fields to fetch properties of sheets
        });

        // Extract and log the names of all sheets (tabs)
        const sheetData = response.data.sheets;
        if (sheetData) {
            console.log('List of sheets (tabs) in the spreadsheet:');
            sheetData.forEach((sheet, index) => { // Use sheetData here, not sheets
                const hidden = sheet.properties.hidden ? "Hidden" : "Visible";
                console.log(`${index + 1}: ${sheet.properties.title} (Sheet ID: ${sheet.properties.sheetId}) - ${hidden}`);
            });
        } else {
            console.log('No sheets found in the spreadsheet.');
        }
    } catch (err) {
        console.error('Failed to retrieve spreadsheet data:', err);
    }
}

/**
 * Reads data from a specified cell or range in a single sheet within a Google Spreadsheet.
 * @param {string} spreadsheetId - The ID of the Google Spreadsheet.
 * @param {string} sheetName - The name of the sheet within the spreadsheet.
 * @param {string} cellRange - The A1 notation of the range to read (e.g., 'A1', 'A1:B2').
 * @returns {Promise<string[][] | undefined>} The data read from the specified range, or undefined if no data.
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
        return undefined;
    }
}

async function publishReleaseTestingStatus(release) {

    // convert the version to a format that can be used in a channel name
    const formattedVersion = release.SemanticVersion.replace(/\./g, '-');

    // TODO : Remove -testonly from channel name
    const channel = `#release-${release.Platform}-${formattedVersion}-testonly`;

    console.log(`Publishing testing status for release ${release.SemanticVersion} on platform ${release.Platform} to channel ${channel}`);


    // Construct the message
    const message = `[${release.Platform}] - ${release.SemanticVersion} Release Validation.
    Release Cut: ${release.ReleaseCut}
    Release Tracker Available: ${release.TrackerAvailable}
    Target Date for Release Sign-Off: ${release.SignOffTarget}
    Deadline Date for Release Submission: ${release.SubmissionDeadline}
    :bell: Status Update: ${release.StatusUpdate}
    Testing Plan and Progress Tracker Summary (${release.SemanticVersion}):
    Teams Sign Off ${release.SemanticVersion} Release on GH: ${release.TeamsSignOffDetails}
    Important Reminder:
    Please be aware of the importance of starting your testing immediately to ensure there is sufficient time to address any unexpected defects. This proactive approach will help prevent release delays and minimize the impact on other teams’ deliveries.
    cc 
    ${ccHandles}`;



    try {
        // Use the `chat.postMessage` method to send a message to the channel
        const response = await slackClient.chat.postMessage({
          channel: channel,
          text: release.testingStatus,
        });
    
        console.log(`Message successfully sent to channel ${channel} for release ${release.SemanticVersion} on platform ${release.Platform}.`);
      } catch (error) {
        console.error('API error:', error);
      }
}

async function publishReleasesTestingStatus(activeReleases) {

    console.log('Publishing testing status for all active releases...');

    try {
        const promises = activeReleases.map(release => publishReleaseTestingStatus(release));
        await Promise.all(promises);
    } catch (error) {
        console.error('An error occurred:', error);
        throw error;
    }
}



async function main() {
    //REAL SHEET
    const spreadsheetId = "1tsoodlAlyvEUpkkcNcbZ4PM9HuC9cEM80RZeoVv5OCQ"; // Use the environment variable
    //const spreadsheetId = "1G-9A3cYVQbsE0z5FJUNMkKi5E4tPBoaUuvZmJn3LsVE"; // Example spreadsheet ID
    if (!spreadsheetId) {
        console.error("Spreadsheet ID is not set. Please set the GOOG_SHEET_ID environment variable.");
        return;
    }

    await listSheets(spreadsheetId);

    const activeReleases = await GetActiveReleases(spreadsheetId);
    console.log('Active Releases:');

    activeReleases.forEach(release => {
        console.log(`Version: ${release.SemanticVersion}, Platform: ${release.Platform}, Sheet ID: ${release.sheetId}`);
    });

    await publishReleasesTestingStatus(activeReleases);
}

main();
