import { WebClient } from '@slack/web-api';

// Create a new instance of the WebClient class with the token read from your environment variables
const token = process.env.SLACK_TOKEN; // Ensure you have your Slack bot token in your environment variables
const web = new WebClient(token);


console.log(`Token: ${token}`);
// The name of the channel you want to send the message to
const channel = '#release-mobile-7-38-1';


// DETERMINE ACTIVE RELEASES

// FOR EACH RELEASE ( MAJ/MIN )
    // Pull J Column from google spreadsheet


async function sendMessage(text) {
  try {
    // Use the `chat.postMessage` method to send a message to the channel
    const response = await web.chat.postMessage({
      channel: channel,
      text: text
    });

    console.log('Message sent: ', response.ts);
  } catch (error) {
    console.error('API error:', error);
  }
}

// Example message
sendMessage('Hello world! This is a notification about the mobile release 7.40.0.');
