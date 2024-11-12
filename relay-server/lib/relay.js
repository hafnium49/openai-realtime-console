// relay.js
import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import express from 'express';

// Import instructions and function schemas
import { instructions } from '../utils/conversation_config.js';
import { functionSchemas } from '../utils/schemas.js';

export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.wss = null; // WebSocketServer for React UI
    this.io = null; // Socket.IO server for Chemistry3D
    this.client = null; // Shared RealtimeClient instance
    this.connectedClients = new Set(); // Set of connected WebSocket clients (React UI)
    this.app = express();
    this.chemistry3dMessageQueue = []; // Message queue for Chemistry3D
    this.chemistry3dConnected = false; // Track if Chemistry3D is connected
    this.audioChunks = new Map(); // Store audio chunks per client
    this.logs = []; // Store logs for index.pug
  }

  listen(port) {
    // Set up Express with Pug
    this.app.set('view engine', 'pug');
    this.app.set('views', './relay-server/views');

    // Serve the index page
    this.app.get('/', (req, res) => {
      res.render('index');
    });

    // Create an HTTP server with Express
    const server = createServer(this.app);

    // Set up WebSocketServer for React UI on path '/ws'
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', async (ws, req) => {
      this.logEvent('system', 'ws_connection', 'New WebSocket client connected');
      await this.reactConnectionHandler(ws, req);
    });

    // Set up Socket.IO server for Chemistry3D extension (default path '/socket.io')
    this.io = new SocketIOServer(server);
    this.io.on('connection', this.chemistry3dConnectionHandler.bind(this));

    // Set up periodic status updates
    setInterval(this.broadcastStatus.bind(this), 5000);

    server.listen(port, () => {
      this.log(`Listening on port ${port}`);
    });
  }

  async reactConnectionHandler(ws, req) {
    // Add the WebSocket connection to the set
    this.connectedClients.add(ws);

    // Initialize audioChunks for this ws
    this.audioChunks.set(ws, []);

    // Instantiate the client if not already connected
    if (!this.client) {
      await this.initializeOpenAIClient(ws);
    }

    // Handle both binary and text messages
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          // Handle binary audio data
          const audioData = new Int16Array(data.buffer);
          this.log(`Received binary audio chunk: ${audioData.length} samples`);
          
          // Store audio chunk
          const chunks = this.audioChunks.get(ws) || [];
          chunks.push(audioData);
          this.audioChunks.set(ws, chunks);

          // Send to OpenAI
          if (this.client) {
            this.client.appendInputAudio(audioData);
          }

          // Log the audio event
          this.logEvent('client', 'audio_chunk', { 
            size: audioData.length,
            timestamp: new Date().toISOString()
          });
        } else {
          // Handle text messages (JSON)
          const event = JSON.parse(data.toString());
          this.log(`Received event from React UI: ${event.type}`);

          if (event.type === 'audio_commit') {
            // Create audio log from accumulated chunks
            const chunks = this.audioChunks.get(ws) || [];
            if (chunks.length > 0) {
              const allAudioData = chunks.reduce((acc, chunk) => {
                const newData = new Int16Array(acc.length + chunk.length);
                newData.set(acc);
                newData.set(chunk, acc.length);
                return newData;
              }, new Int16Array());

              // Convert to Base64 for logging
              const audioBuffer = Buffer.from(allAudioData.buffer);
              const audioBase64 = audioBuffer.toString('base64');
              this.logEvent('client', 'audio_recording', { audioBase64 });
              
              // Clear chunks
              this.audioChunks.set(ws, []);
            }

            // Create response
            if (this.client) {
              this.client.createResponse();
            }
          } else if (event.type === 'conversation.item.create') {
            // Send message to OpenAI
            this.client.sendUserMessageContent([{ type: 'text', text: event.item.text }]);
          } else if (event.type === 'session.update') {
            // Update session parameters
            this.client.updateSession(event.session);
          } else {
            this.log(`Unhandled event type: ${event.type}`);
          }
        }
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from React UI: ${data}`);
      }
    });

    ws.on('close', () => {
      this.audioChunks.delete(ws);
      this.connectedClients.delete(ws);
      if (this.connectedClients.size === 0 && !this.chemistry3dConnected) {
        // Disconnect from OpenAI when no clients are connected
        this.client.disconnect();
        this.client = null;
      }
    });
  }

  async initializeOpenAIClient(ws) {
    this.log(`Connecting to OpenAI Realtime API with key "${this.apiKey.slice(0, 3)}..."`);
    this.client = new RealtimeClient({ apiKey: this.apiKey });

    // Set instructions and other session configurations
    this.client.updateSession({
      instructions: instructions,
      input_audio_transcription: { model: 'whisper-1' },
      input_audio_format: 'pcm16', // Ensure audio format is set correctly
    });

    // Add function tools from functionSchemas
    functionSchemas.forEach((tool) => {
      this.client.addTool(tool, async (args) => {
        // Implement function handler
        const functionName = tool.name;
        switch (functionName) {
          case 'add_pickmove_task':
            this.log('Executing add_pickmove_task with args:', args);
            // Simulate processing
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return { message: 'PickMove task added successfully.' };
          case 'add_pour_task':
            this.log('Executing add_pour_task with args:', args);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return { message: 'Pour task added successfully.' };
          case 'add_return_task':
            this.log('Executing add_return_task with args:', args);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return { message: 'Return task added successfully.' };
          default:
            return { error: `Unknown function: ${functionName}` };
        }
      });
    });

    // Relay OpenAI events to React UI and Chemistry3D
    this.client.on('conversation.updated', ({ item, delta }) => {
      // Serialize delta.audio if present
      if (delta?.audio) {
        // Convert Int16Array to Buffer
        const audioBuffer = Buffer.from(delta.audio.buffer);
        // Convert Buffer to Base64 string
        delta.audio = audioBuffer.toString('base64');
      }

      const event = {
        type: 'conversation.item.update',
        item,
        delta,
      };
      for (const clientWs of this.connectedClients) {
        clientWs.send(JSON.stringify(event));
      }
    });

    this.client.on('conversation.created', ({ item }) => {
      const event = {
        type: 'conversation.item.create',
        item,
      };
      for (const clientWs of this.connectedClients) {
        clientWs.send(JSON.stringify(event));
      }
      // Forward function calls to Chemistry3D
      if (item.type === 'function_call') {
        this.io.emit('function_call', item);
      }
    });

    this.client.on('error', (error) => {
      this.log('OpenAI Realtime API error:', error);
      const errorEvent = {
        type: 'error',
        error,
      };
      for (const clientWs of this.connectedClients) {
        clientWs.send(JSON.stringify(errorEvent));
      }
    });

    this.client.realtime.on('close', () => {
      this.log('OpenAI Realtime API connection closed');
      this.client = null;
    });

    // Connect to OpenAI Realtime API
    try {
      this.log('Connecting to OpenAI Realtime API...');
      await this.client.connect();
      this.log('Connected to OpenAI Realtime API successfully!');

      // Process any queued messages
      this.processQueuedMessages();
    } catch (e) {
      this.log(`Error connecting to OpenAI Realtime API: ${e.message}`);
      ws.close();
    }
  }

  chemistry3dConnectionHandler(socket) {
    this.log('Chemistry3D extension connected');
    this.logEvent('system', 'chemistry3d_connection', 'Chemistry3D extension connected');
    this.chemistry3dConnected = true;

    // Handle messages from Chemistry3D
    socket.on('message', (msg) => {
      this.log(`Received message from Chemistry3D: ${msg}`);
      if (!this.client || !this.client.isConnected()) {
        // Queue message if client isn't connected
        this.chemistry3dMessageQueue.push(msg);
        this.log('OpenAI client not connected, message queued');
        return;
      }

      // Send message to OpenAI
      this.client.sendUserMessageContent([{ type: 'text', text: msg }]);
    });

    // Handle function call outputs from Chemistry3D
    socket.on('function_call_output', (data) => {
      this.log('Received function call output from Chemistry3D');
      if (!this.client || !this.client.isConnected()) {
        this.log('No OpenAI client connected');
        return;
      }

      this.client.realtime.send('conversation.item.create', {
        item: {
          type: 'function_call_output',
          call_id: data.call_id,
          output: data.output,
        },
      });
      // Trigger the assistant to generate the next response
      this.client.realtime.send('response.create', {});
    });

    socket.on('disconnect', () => {
      this.log('Chemistry3D extension disconnected');
      this.chemistry3dConnected = false;
      if (this.connectedClients.size === 0 && !this.chemistry3dConnected) {
        // Disconnect from OpenAI when no clients are connected
        this.client.disconnect();
        this.client = null;
      }
    });
  }

  processQueuedMessages() {
    while (this.chemistry3dMessageQueue.length > 0 && this.client?.isConnected()) {
      const msg = this.chemistry3dMessageQueue.shift();
      this.client.sendUserMessageContent([{ type: 'text', text: msg }]);
    }
  }

  broadcastStatus() {
    const status = {
      isConnected: !!this.client,
      connectedClients: this.connectedClients.size,
      timestamp: new Date().toISOString(),
    };
    this.io.emit('status', status);
    // Broadcast status to React UI via WebSocket
    const statusEvent = {
      type: 'status',
      ...status,
    };
    for (const clientWs of this.connectedClients) {
      clientWs.send(JSON.stringify(statusEvent));
    }
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }

  logEvent(source, type, data) {
    this.io.emit('log', {
      source,
      type,
      data,
      timestamp: new Date().toISOString(),
    });
    // Store logs for index.pug
    this.logs.push({
      source,
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}
