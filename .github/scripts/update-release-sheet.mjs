import { google } from 'googleapis';

import fs from 'fs';
import { parse } from 'csv-parse/sync';

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
  const credentialsJson = Buffer.from(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64,
    'base64',
  ).toString('utf8');

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
 * Creates a new release sheet by duplicating an existing template sheet and then overwriting
 * specific data rows in the new sheet.
 *
 * @param {string} documentId - The ID of the Google Spreadsheet.
 * @param {string} platform - The platform for which the release is being prepared.
 * @param {string} semanticVersion - The semantic version of the release.
 * @param {number} templateSheetId - The sheet ID of the template to be duplicated.
 * @returns {Promise<void>} A promise that resolves when the sheet has been created and modified.
 */
async function createReleaseSheet(
  documentId,
  platform,
  semanticVersion,
  templateSheetId,
  sheetData,
) {
  const authClient = await getGoogleAuth();
  const sheetTitle = `v${semanticVersion} (${platform})`;

  const existingSheetCount = await getTotalSheetCount(documentId);

  console.log(`Existing sheet count: ${existingSheetCount}`);

  try {
    // Step 1: Duplicate the template sheet
    const duplicateSheetResponse = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: documentId,
      resource: {
        requests: [
          {
            duplicateSheet: {
              sourceSheetId: templateSheetId,
              newSheetName: sheetTitle,
            },
          },
        ],
      },
      auth: authClient,
    });

    const newSheetId =
      duplicateSheetResponse.data.replies[0].duplicateSheet.properties.sheetId;

    console.log(`Sheet duplicated successfully. New sheet ID: ${newSheetId}`);

    // Step 2. Make the new sheet the active sheet
    const sheetActivationResponse = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: documentId,
      resource: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: newSheetId,
                hidden: false,
                index: existingSheetCount,
              },
              fields: 'hidden',
            },
          },
        ],
      },
      auth: authClient,
    });

    console.log(`Sheet activated successfully.`);

    const dataStartRow = 3;
    const dataEndRow = dataStartRow + sheetData.length - 1;
    const columnStart = 'A';
    const columnEnd = 'G';

    const valueRange = `${sheetTitle}!${columnStart}${dataStartRow}:${columnEnd}${dataEndRow}`;

    console.log(`Updating newly provisioned sheet with commit data.`);

    sheets.spreadsheets.values.update({
      spreadsheetId: documentId,
      range: valueRange,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: sheetData,
      },
      auth: authClient,
    });

    console.log('Sheet duplicated and updated successfully.');

    const newSheetCount = await getTotalSheetCount(documentId);

    console.log(`New sheet count: ${newSheetCount}`);
  } catch (error) {
    console.error('Error creating release sheet:', error);
    throw error;
  }
}

/**
 * Retriev1es the total number of sheets in a given Google Sheets document.
 *
 * @param {string} documentId - The ID of the Google Sheets document from which to retrieve the sheet count.
 * @returns {Promise<number>} A promise that resolves with the number of sheets in the specified document.
 * @throws {Error} Throws an error if the Google Sheets API call fails or if the authentication process fails.
 */
async function getTotalSheetCount(documentId) {
  const authClient = await getGoogleAuth();

  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId: documentId,
      auth: authClient,
      fields: 'sheets(properties(title,sheetId))',
    });

    const sheetsData = response.data.sheets;

    if (!sheetsData) {
      console.log('No sheets found in the spreadsheet.');
      return 0;
    }

    return sheetsData.length;
  } catch (err) {
    console.error('Failed to retrieve spreadsheet data:', err);
    throw err;
  }
}

/**
 * retrieves a list of all releases from a Google Sheets document.
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
async function getAllReleases(documentId) {
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
        console.log(
          `Skipping sheet: ${title} with id ${sheet.properties.sheetId} - Semantic version not found.`,
        );
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
    return results.filter((result) => result !== null);
  } catch (err) {
    console.error('Failed to retrieve spreadsheet data:', err);
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 7) {
    console.error(
      'Incorrect argument count. Example Usage: node update-release-sheet.mjs mobile 7.10.0 documentId ./commits.csv .',
    );
    console.error('Received:', args, ' with length:', args.length);
    process.exit(1);
  }

  const platform = args[0];
  const semanticVersion = args[1];
  const documentId = args[2];
  const commitsFile = args[3];
  const gitDir = args[4];
  const mobileTemplateSheetId = args[5];
  const extensionTemplateSheetId = args[6];

  // Change the working directory to the git repository path
  // Since this is invoked by a shared workflow, the working directory is not guaranteed to be the repository root
  process.chdir(gitDir);

  if (!documentId) {
    console.error('Document ID is not set.');
    return;
  }

  if (!platform) {
    console.error('Platform is not set.');
    return;
  }

  if (!commitsFile) {
    console.error('Commits file is not set.');
    return;
  }

  if (!semanticVersion) {
    console.error('Semantic version is not set.');
    return;
  }

  if (!mobileTemplateSheetId) {
    console.error('Mobile template sheet ID is not set.');
    return;
  }

  if (!extensionTemplateSheetId) {
    console.error('Extension template sheet ID is not set.');
    return;
  }

  const commits = parseCSVv2(commitsFile);

  const releases = await getAllReleases(documentId);

  var sheetExists = false;

  releases.forEach((release) => {
    console.log(
      `Version: ${release.SemanticVersion}, Platform: ${release.Platform}, Sheet ID: ${release.sheetId} Title: ${release.title}`,
    );
    if (
      release.SemanticVersion === semanticVersion &&
      release.Platform === platform
    ) {
      sheetExists = true;
    }
  });

  console.log(
    `Release sheets exists for platform: ${platform}: version: ${semanticVersion} -  ${sheetExists}`,
  );

  if (sheetExists) {
    return;
  }

  const templateSheetId = determineTemplateId(
    platform,
    mobileTemplateSheetId,
    extensionTemplateSheetId,
  );

  createReleaseSheet(
    documentId,
    platform,
    semanticVersion,
    templateSheetId,
    commits,
  );
}

function determineTemplateId(
  platform,
  mobileTemplateSheetId,
  extensionTemplateSheetId,
) {
  switch (platform) {
    case 'mobile':
      return mobileTemplateSheetId;
    case 'extension':
      return extensionTemplateSheetId;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

// Function to parse a CSV file into a 2D array with specific modifications
function parseCSVv2(filePath) {
  try {
    console.log(`Parsing CSV file: ${filePath}`);

    // Read the entire file content
    const fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
    // Split the content into lines
    const lines = fileContent.split('\n');

    // Initialize the 2D array to hold our processed data
    const data2D = [];

    // Start from the second line to skip headers
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue; // Skip empty lines

      // Split the line into columns based on commas
      const columns = lines[i].split(',');

      const modifiedColumns = [
        columns[0], // Commit Message
        columns[1], // Author
        columns[2], // PR Link
        '', // Blank string 'd'
        '', // Blank string 'e'
        columns[3], // Team
        columns[4], // Change Type
      ];

      // Add this row to the 2D array
      data2D.push(modifiedColumns);
    }

    return data2D;
  } catch (error) {
    console.error('Failed to parse CSV:', error);
    return []; // Return an empty array in case of error
  }
}

await main();
