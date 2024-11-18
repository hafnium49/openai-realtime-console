// relay-server/index.js

import express from 'express';
import path from 'path';
import { createServer } from 'http';
import { RealtimeRelay } from './lib/relay.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 8081;

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../build')));

// For any other requests, send back the React index.html file
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

// Create the server
const server = createServer(app);

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Function to get the OpenAI API key
async function getOpenAIApiKey() {
  // First, try to get it from the environment variable
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // If not found, try to get it from Secret Manager
  const client = new SecretManagerServiceClient();

  try {
    // Get the project ID
    const projectId = await client.getProjectId();
    const secretName = 'OPENAI_API_KEY'; // The name of your secret in Secret Manager
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;

    // Access the secret
    const [version] = await client.accessSecretVersion({ name });
    const apiKey = version.payload.data.toString('utf8');
    return apiKey;
  } catch (error) {
    console.error('Error accessing Secret Manager:', error);
    throw error;
  }
}

// Initialize the RealtimeRelay
(async () => {
  try {
    const apiKey = await getOpenAIApiKey();
    if (!apiKey) {
      throw new Error('API key is undefined.');
    }
    const relay = new RealtimeRelay(apiKey);
    relay.listen(server);
  } catch (error) {
    console.error('Failed to initialize RealtimeRelay:', error);
    process.exit(1);
  }
})();
