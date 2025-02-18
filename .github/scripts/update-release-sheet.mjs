import { google } from 'googleapis';

// Clients
const sheets = google.sheets('v4');

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
 * Creates a new release sheet by duplicating an existing template sheet and then overwriting
 * specific data rows in the new sheet.
 * 
 * @param {string} documentId - The ID of the Google Spreadsheet.
 * @param {string} platform - The platform for which the release is being prepared.
 * @param {string} semanticVersion - The semantic version of the release.
 * @param {number} templateSheetId - The sheet ID of the template to be duplicated.
 * @returns {Promise<void>} A promise that resolves when the sheet has been created and modified.
 */
async function createReleaseSheet(documentId, platform, semanticVersion, templateSheetId) {
    const authClient = await getGoogleAuth();
    const sheetTitle = `v${semanticVersion} (${platform})`;

    try {
        // Step 1: Duplicate the template sheet
        const duplicateSheetResponse = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: documentId,
            resource: {
                requests: [{
                    duplicateSheet: {
                        sourceSheetId: templateSheetId,
                        newSheetName: sheetTitle,
                    },
                }],
            },
            auth: authClient,
        });

        const newSheetId = duplicateSheetResponse.data.replies[0].duplicateSheet.properties.sheetId;

        console.log(`Sheet duplicated successfully. New sheet ID: ${newSheetId}`);


        // Optionally, make the new sheet the active sheet
        const sheetActivationResponse = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: documentId,
            resource: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: {
                                sheetId: newSheetId,
                                hidden: false,
                            },
                            fields: 'hidden',
                        },
                    }
                ],
            },
            auth: authClient,
        });

        console.log(`Sheet activated successfully.`);

        // Step 3: Update the necessary rows in the new sheet
        const values = [
            // Assuming you want to update the first row; adjust range and values as necessary
            ["Updated Data 1", "Updated Data 2", "Updated Data 3"],
        ];
        const valueRange = `${sheetTitle}!A1:C1`; // Adjust the range according to your needs

        await sheets.spreadsheets.values.update({
            spreadsheetId: documentId,
            range: valueRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: values,
            },
            auth: authClient,
        });

        console.log('Sheet duplicated and updated successfully.');

    } catch (error) {
        console.error('Error creating release sheet:', error);
        throw error;
    }
}




  async function GetAllReleases(documentId) {
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
        const promises = sheetsData.map(async (sheet) => {
            const { title } = sheet.properties;
            const versionMatch = title.match(/v(\d+\.\d+\.\d+)/);
            const platformMatch = title.match(/\(([^)]+)\)/);

            if (!versionMatch) {
                console.log(`Skipping sheet: ${title} - Semantic version not found.`);
                return null; // Skip this sheet because we couldn't determine the semantic version
            }


            return {
                DocumentId: documentId,
                SemanticVersion: versionMatch[1],
                Platform: platformMatch ? platformMatch[1] : 'extension',
                sheetId: sheet.properties.sheetId,
                title: sheet.properties.title,
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

  async function main() {

    const args = process.argv.slice(2);
    if (args.length !== 4) {
      console.error(
        'Usage: node update-release-sheet.mjs mobile 7.10.0 documentId ./commits.csv .',
      );
      console.error('Received:', args, ' with length:', args.length);
      process.exit(1);
    }
  
    const platform = args[0];
    const semanticVersion = args[1];
    const documentId = args[2];
    const commitsFile = args[3];
    const gitDir = args[4];
  
    // Change the working directory to the git repository path
    // Since this is invoked by a shared workflow, the working directory is not guaranteed to be the repository root
    process.chdir(gitDir);

    if (!documentId) {
        console.error("Document ID is not set.");
        return;
    }

    if (!platform) {
        console.error("Platform is not set.");
        return;
    }

    if (!commitsFile) {
        console.error("Commits file is not set.");
        return;
    }


    if (!semanticVersion) {
        console.error("Semantic version is not set.");
        return;
    }

    const releases = await GetAllReleases(documentId);

    var sheetExists = false;
    releases.forEach(release => {
        console.log(`Version: ${release.SemanticVersion}, Platform: ${release.Platform}, Sheet ID: ${release.sheetId} Title: ${release.title}`);
        if (release.SemanticVersion === semanticVersion && release.Platform === platform) {
            sheetExists = true;
        }
    });
    
    console.log(`Release sheets exists for platform: ${platform}: version: ${semanticVersion} -  ${sheetExists}`);


    if (sheetExists){
        console.log(`Release sheet already exists for platform: ${platform}: version: ${semanticVersion}`);
        return;
    }

    const templateSheetId = "1885469311";

    createReleaseSheet(documentId, platform, semanticVersion, templateSheetId);



  }

  await main()

