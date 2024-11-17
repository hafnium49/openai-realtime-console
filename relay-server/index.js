// relay-server/index.js

import express from 'express';
import path from 'path';
import { createServer } from 'http';
import { RealtimeRelay } from './lib/relay.js';

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

// Initialize the RealtimeRelay
const apiKey = process.env.OPENAI_API_KEY;
const relay = new RealtimeRelay(apiKey);
relay.listen(server);
