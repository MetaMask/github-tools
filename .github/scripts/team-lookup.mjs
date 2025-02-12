import { WebClient } from '@slack/web-api';

// Create a new instance of the WebClient class with the token read from your environment variables
const token = process.env.SLACK_TOKEN; // Ensure you have your Slack bot token in your environment variables
const web = new WebClient(token);

let groupMap = null; // This will store the mapping of team names to IDs

async function initializeGroupMap() {
    try {
        const response = await web.usergroups.list({ include_disabled: false });

        if (response.ok && response.usergroups) {
            groupMap = response.usergroups.reduce((map, group) => {
                map[group.name] = group.id;
                return map;
            }, {});
        } else {
            throw new Error(`Failed to load user groups: ${response.error}`);
        }
    } catch (error) {
        console.error('Error initializing group map:', error);
    }

    console.log('Group map initialized with size of', Object.keys(groupMap).length);
}

function getGroupIdByName(groupName) {
    if (!groupMap) {
        console.error('Group map is not initialized.');
        return null;
    }
    return groupMap[groupName] || null;
}


console.log(`Token: ${token}`);
// The name of the channel you want to send the message to
const channel = '#release-mobile-7-38-1';



async function getSlackTeamId(teamName) {
    if (!groupMap) {
        console.error('Group map is not initialized.');
        return null;
    }
    return groupMap[teamName] || null;
}

await initializeGroupMap();

// Example message
const teamId = await getSlackTeamId('assets-team');
console.log(`Team ID for 'assets-team': ${teamId}`);
