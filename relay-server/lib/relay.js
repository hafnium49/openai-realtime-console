// relay.js
import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { createServer } from 'http';
import express from 'express';
import wav from 'wav';
import { PassThrough } from 'stream';
import { parse } from 'url';

// Import instructions and function schemas
import { instructions } from '../utils/conversation_config.js';
import { functionSchemas } from '../utils/schemas.js';

export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.wss = null; // WebSocketServer for React UI
    this.chemistry3dWss = null; // WebSocketServer for Chemistry3D
    this.client = null; // Shared RealtimeClient instance
    this.connectedClients = new Set(); // Set of connected WebSocket clients (React UI)
    this.app = express();
    this.chemistry3dMessageQueue = []; // Message queue for Chemistry3D
    this.chemistry3dConnected = false; // Track if Chemistry3D is connected
    this.audioChunks = new Map(); // Store audio chunks per client
    this.logs = []; // Store logs for index.pug
    this.server = null; // HTTP server
    this.monitorWss = null; // WebSocketServer for Monitor clients
  }

  listen(port) {
    // Set up Express with Pug
    this.app.set('view engine', 'pug');
    this.app.set('views', './relay-server/views');

    // Serve the index page
    this.app.get('/', (req, res) => {
      res.render('index', { logs: this.logs }); // Pass logs to index.pug
    });

    // Create an HTTP server and attach Express app
    this.server = createServer();
    this.server.on('request', this.app);

    // Initialize WebSocket servers with noServer option
    this.wss = new WebSocketServer({ noServer: true });
    this.chemistry3dWss = new WebSocketServer({ noServer: true });
    this.monitorWss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests for WebSocket connections
    this.server.on('upgrade', (request, socket, head) => {
      const { pathname } = parse(request.url);

      if (pathname === '/ws') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else if (pathname === '/chemistry3d') {
        this.chemistry3dWss.handleUpgrade(request, socket, head, (ws) => {
          this.chemistry3dWss.emit('connection', ws, request);
        });
      } else if (pathname === '/monitor') {
        this.monitorWss.handleUpgrade(request, socket, head, (ws) => {
          this.monitorWss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Set up WebSocket connection handlers
    this.wss.on('connection', async (ws, req) => {
      this.logEvent('system', 'ws_connection', 'New WebSocket client connected');
      await this.reactConnectionHandler(ws, req);
    });

    this.chemistry3dWss.on('connection', this.chemistry3dConnectionHandler.bind(this));
    this.monitorWss.on('connection', this.monitorConnectionHandler.bind(this));

    // Set up periodic status updates
    setInterval(this.broadcastStatus.bind(this), 5000);

    this.server.listen(port, () => {
      this.log(`Listening on port ${port}`);
    });
  }

  async reactConnectionHandler(ws, req) {
    this.connectedClients.add(ws);
    this.logEvent('react', 'connected', {
      remoteAddress: req.socket.remoteAddress,
      timestamp: new Date().toISOString(),
    });

    this.audioChunks.set(ws, []);

    if (!this.client) {
      await this.initializeOpenAIClient(ws);
    }

    // Single message handler for both binary and text
    ws.on('message', (data, isBinary) => {
      this.log(
        `Received message: isBinary=${isBinary}, size=${
          data.byteLength || data.length
        } bytes`
      );
      try {
        if (isBinary) {
          // Handle binary data
          const buffer = data; // data is already a Buffer

          // Convert buffer to Int16Array
          const audioData = new Int16Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength / Int16Array.BYTES_PER_ELEMENT
          );

          this.log(`Processing audio chunk: ${audioData.length} samples`);

          // Store audio chunk
          const chunks = this.audioChunks.get(ws) || [];
          chunks.push(audioData);
          this.audioChunks.set(ws, chunks);

          // Send to OpenAI and log the event
          if (this.client) {
            this.client.appendInputAudio(audioData);
            this.logEvent('client', 'audio_chunk_received', {
              size: audioData.length,
              totalChunks: chunks.length,
              byteLength: buffer.byteLength,
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          // Handle text messages (JSON)
          const event = JSON.parse(data.toString());
          this.logEvent('react', 'received', { type: event.type, data: event });
          this.log(`Received event from React UI: ${event.type}`);

          if (event.type === 'audio_commit') {
            // Create audio log from accumulated chunks
            const chunks = this.audioChunks.get(ws) || [];
            if (chunks.length > 0) {
              // Combine all audio chunks into a single Buffer
              const allAudioData = Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk.buffer))
              );

              // Create WAV file with proper headers
              const writer = new wav.Writer({
                channels: 1,
                sampleRate: 24000,
                bitDepth: 16,
              });

              // Use PassThrough stream to collect data
              const passThrough = new PassThrough();
              const wavBuffers = [];

              passThrough.on('data', (data) => {
                wavBuffers.push(data);
              });

              passThrough.on('finish', () => {
                const wavData = Buffer.concat(wavBuffers);
                const audioBase64 = wavData.toString('base64');

                // Log the audio recording
                this.logEvent('client', 'audio_recording', { audioBase64 });
                this.log('Audio recording logged on backend relay server.');

                // Clear chunks
                this.audioChunks.set(ws, []);
              });

              // Pipe writer to passThrough
              writer.pipe(passThrough);

              // Write data and end the writer
              writer.end(allAudioData);
            } else {
              this.log('No audio chunks to process.');
            }

            // Create response
            if (this.client) {
              this.client.createResponse();
            }
          } else if (event.type === 'conversation.item.create') {
            // Send message to OpenAI
            this.client.sendUserMessageContent([
              { type: 'text', text: event.item.text },
            ]);
          } else if (event.type === 'session.update') {
            // Update session parameters
            this.client.updateSession(event.session);
          } else {
            this.log(`Unhandled event type: ${event.type}`);
          }
        }
      } catch (e) {
        this.logEvent('react', 'error', {
          error: e.message,
          data: isBinary ? 'binary data' : data.toString(),
        });
        console.error(e.message);
        this.log(`Error parsing event from React UI: ${data}`);
      }
    });

    ws.on('close', () => {
      this.logEvent('react', 'disconnected', 'React client disconnected');
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
    this.log(
      `Connecting to OpenAI Realtime API with key "${this.apiKey.slice(
        0,
        3
      )}..."`
    );
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
        this.chemistry3dWss.clients.forEach((client) => {
          client.send(JSON.stringify(item));
        });
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

    // Wrap original send method to log outgoing messages
    const originalSend = this.client.realtime.send.bind(this.client.realtime);
    this.client.realtime.send = (eventName, payload) => {
      this.logEvent('openai', 'sent', { eventName, payload });
      originalSend(eventName, payload);
    };

    // Listen for incoming events
    this.client.realtime.on('message', (message) => {
      this.logEvent('openai', 'received', { message });
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

  chemistry3dConnectionHandler(ws) {
    this.chemistry3dConnected = true;
    this.log('Chemistry3D connected via WebSocket.');

    // Handle messages from Chemistry3D
    ws.on('message', (message) => {
      // Process messages from Chemistry3D
      const event = JSON.parse(message);
      this.logEvent('chemistry3d', 'received', { event });

      if (!this.client || !this.client.isConnected()) {
        // Queue message if client isn't connected
        this.chemistry3dMessageQueue.push(event);
        this.log('OpenAI client not connected, message queued');
        return;
      }

      // Send message to OpenAI
      if (event.type === 'message') {
        this.client.sendUserMessageContent([{ type: 'text', text: event.text }]);
        this.logEvent('openai', 'sent', { type: 'user_message', content: event.text });
      } else if (event.type === 'function_call_output') {
        this.client.realtime.send('conversation.item.create', {
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: event.output,
          },
        });
        // Trigger the assistant to generate the next response
        this.client.realtime.send('response.create', {});
      } else {
        this.log(`Unhandled event type from Chemistry3D: ${event.type}`);
      }
    });

    ws.on('close', () => {
      this.chemistry3dConnected = false;
      this.log('Chemistry3D disconnected.');
      this.logEvent('system', 'chemistry3d_disconnected', 'Chemistry3D disconnected');
      if (this.connectedClients.size === 0 && !this.chemistry3dConnected) {
        // Disconnect from OpenAI when no clients are connected
        this.client.disconnect();
        this.client = null;
      }
    });
  }

  monitorConnectionHandler(ws) {
    this.log('Monitor client connected via WebSocket.');

    ws.on('close', () => {
      this.log('Monitor client disconnected.');
    });
  }

  processQueuedMessages() {
    while (
      this.chemistry3dMessageQueue.length > 0 &&
      this.client?.isConnected()
    ) {
      const event = this.chemistry3dMessageQueue.shift();
      // Process the queued event
      if (event.type === 'message') {
        this.client.sendUserMessageContent([{ type: 'text', text: event.text }]);
        this.logEvent('openai', 'sent', { type: 'user_message', content: event.text });
      } else if (event.type === 'function_call_output') {
        this.client.realtime.send('conversation.item.create', {
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: event.output,
          },
        });
        this.client.realtime.send('response.create', {});
      }
    }
  }

  broadcastStatus() {
    const status = {
      isConnected: !!this.client,
      connectedClients: this.connectedClients.size,
      chemistry3dConnected: this.chemistry3dConnected,
      timestamp: new Date().toISOString(),
    };
    const statusEvent = {
      type: 'status',
      ...status,
    };
    // Send status to React clients
    for (const clientWs of this.connectedClients) {
      clientWs.send(JSON.stringify(statusEvent));
    }
    // Send status to Chemistry3D clients
    this.chemistry3dWss.clients.forEach((client) => {
      client.send(JSON.stringify(statusEvent));
    });
    // Send status to Monitor clients
    this.monitorWss.clients.forEach((client) => {
      client.send(JSON.stringify(statusEvent));
    });
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }

  logEvent(source, type, data) {
    const logMessage = {
      source,
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    
    // Send logs to Monitor clients
    this.monitorWss.clients.forEach((client) => {
      client.send(JSON.stringify(logMessage));
    });
    
    // Store logs for index.pug
    this.logs.push(logMessage);

    // Also log to console for backend visibility
    this.log(`[${source}] ${type}:`, data);
  }
}
