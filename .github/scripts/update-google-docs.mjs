import { google } from 'googleapis';

const sheets = google.sheets('v4');

async function authenticate() {
    const auth = new google.auth.GoogleAuth({
        keyFile: 'path_to_your_service_account.json', // Replace with the path to your JSON key file
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return auth.getClient();
}

async function updateSheet(spreadsheetId: string, range: string, values: any[][]) {
    const authClient = await authenticate();

    const request = {
        spreadsheetId: spreadsheetId, // TODO: Update with your spreadsheet ID
        range: range, // TODO: Update with the range in A1 notation
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: values,
        },
        auth: authClient,
    };

    try {
        const response = await sheets.spreadsheets.values.update(request);
        console.log(response.data);
        console.log('Sheet updated successfully.');
    } catch (err) {
        console.error('The API returned an error: ' + err);
    }
}

function main() {
    const spreadsheetId = process.env.GOOG_SHEET_ID; // Use the environment variable
    if (!spreadsheetId) {
        console.error("Spreadsheet ID is not set. Please set the GOOG_SHEET_ID environment variable.");
        return;
    }

    const range = 'Sheet1!A1:D1'; // Example range
    const values = [
        ['Name', 'Age', 'Position', 'Salary'] // Example row to update
    ];

    updateSheet(spreadsheetId, range, values);
}

main();
