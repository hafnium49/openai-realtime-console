// index.js

// Import necessary modules
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { functionSchemas } from './schemas.js';

// Define __filename and __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize the client
const client = new RealtimeClient({ apiKey: process.env.OPENAI_API_KEY });

// Read assistant_prompt.txt
const assistantPromptPath = path.join(__dirname, 'assistant_prompt.txt');
const assistantPrompt = fs.readFileSync(assistantPromptPath, 'utf8');

// Set parameters for the session
client.updateSession({ instructions: assistantPrompt });
client.updateSession({ voice: 'alloy' });
client.updateSession({
  turn_detection: { type: 'none' },
  input_audio_transcription: { model: 'whisper-1' },
});

// Add the function schemas to the session
client.updateSession({ tools: functionSchemas });

// Set up event handling
client.on('conversation.updated', async (event) => {
  const { item, delta } = event;

  if (item.type === 'function_call') {
    if (item.status === 'completed') {
      const functionName = item.name;
      const functionArguments = JSON.parse(item.arguments);

      console.log(`Assistant called function: ${functionName}`);
      console.log('With arguments:', functionArguments);

      // Handle the function call
      let functionResult;
      try {
        functionResult = await handleFunctionCall(functionName, functionArguments);
      } catch (error) {
        functionResult = { error: error.message };
      }

      // Send the function result back to the assistant
      client.realtime.send('conversation.item.create', {
        item: {
          type: 'function_call_output',
          call_id: item.id,
          output: JSON.stringify(functionResult),
        },
      });

      // Trigger the assistant to generate the next response
      client.realtime.send('response.create');
    }
  } else if (item.type === 'message' && item.role === 'assistant') {
    if (delta && delta.text) {
      process.stdout.write(delta.text);
    } else if (item.text) {
      console.log('\nAssistant:', item.text);
    }
  }
});

// Function to handle the function calls
async function handleFunctionCall(functionName, functionArguments) {
  // Implement your function logic here
  switch (functionName) {
    case 'add_pickmove_task':
      // Call your actual function or simulate the result
      console.log('Executing add_pickmove_task...');
      // Simulate some processing delay
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {
        message: 'PickMove task added successfully.',
      };
    case 'add_pour_task':
      console.log('Executing add_pour_task...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {
        message: 'Pour task added successfully.',
      };
    case 'add_return_task':
      console.log('Executing add_return_task...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {
        message: 'Return task added successfully.',
      };
    default:
      throw new Error(`Unknown function: ${functionName}`);
  }
}

// Asynchronous function to run the client
async function run() {
  try {
    // Connect to the Realtime API
    await client.connect();
    console.log('Connected to Realtime API');

    // Send a user message that requires function calls
    client.sendUserMessageContent([
      {
        type: 'input_text',
        text: 'Please pick up the Bottle_Fecl2 and move it to beaker_Kmno4, then pour it, and return it to its original position.',
      },
    ]);
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

run();
