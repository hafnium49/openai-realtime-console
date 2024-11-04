// If using a .env file, uncomment the line below
import 'dotenv/config';

import { RealtimeClient } from '@openai/realtime-api-beta';

const client = new RealtimeClient({ apiKey: process.env.OPENAI_API_KEY });

// Set parameters for the session
client.updateSession({ instructions: 'You are a great, upbeat friend.' });
client.updateSession({ voice: 'alloy' });
client.updateSession({
  turn_detection: { type: 'none' }, // Change to 'server_vad' if desired
  input_audio_transcription: { model: 'whisper-1' },
});

// Set up event handling
client.on('conversation.updated', (event) => {
  const { item, delta } = event;
  const items = client.conversation.getItems();
  console.log('Conversation updated:', event);
});

// Asynchronous function to run the client
async function run() {
  try {
    // Connect to the Realtime API
    await client.connect();
    console.log('Connected to Realtime API');

    // Send a user message to start the conversation
    client.sendUserMessageContent([{ type: 'input_text', text: 'How are you?' }]);

    // Keep the connection open for a while to receive responses
    setTimeout(() => {
      client.disconnect();
      console.log('Disconnected from Realtime API');
    }, 10000); // Adjust the timeout as needed
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

run();
