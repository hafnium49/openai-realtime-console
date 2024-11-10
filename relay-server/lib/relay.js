import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import express from 'express';

export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.wss = null;
    this.io = null;
    this.client = null; // Shared RealtimeClient instance
    this.connectedClients = new Set(); // Set of connected WebSocket clients
    this.app = express(); // Add Express app
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
      await this.connectionHandler(ws, req);
    });

    // Set up Socket.IO server for Chemistry3D extension (default path '/socket.io')
    this.io = new SocketIOServer(server);
    this.io.on('connection', this.socketConnectionHandler.bind(this));

    // Helper function to broadcast status to web interface
    const broadcastStatus = () => {
      this.io.emit('status', {
        isConnected: !!this.client,
        connectedClients: this.connectedClients.size,
        timestamp: new Date().toISOString()
      });
    };

    // Helper function to log events to web interface
    const logEvent = (source, type, data) => {
      this.io.emit('log', {
        source,
        type,
        data,
        timestamp: new Date().toISOString()
      });
    };

    // Set up periodic status updates
    setInterval(broadcastStatus, 5000);

    server.listen(port, () => {
      this.log(`Listening on port ${port}`);
    });
  }

  async connectionHandler(ws, req) {
    if (!req.url) {
      this.log('No URL provided, closing connection.');
      ws.close();
      return;
    }

    // Remove the pathname check
    /*
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== '/') {
      this.log(`Invalid pathname: "${pathname}"`);
      ws.close();
      return;
    }
    */

    // Instantiate the client if not already connected
    if (!this.client) {
      this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
      this.client = new RealtimeClient({ apiKey: this.apiKey });

      // Relay OpenAI events to React UI and handle function calls
      this.client.realtime.on('server.*', (event) => {
        this.log(`Relaying "${event.type}" to clients`);
        // Send event to all connected WebSocket clients (React UI)
        for (const clientWs of this.connectedClients) {
          clientWs.send(JSON.stringify(event));
        }
        // Forward function calls to Chemistry3D
        if (
          event.type === 'conversation.item.create' &&
          event.item.type === 'function_call'
        ) {
          this.io.emit('function_call', event.item);
        }
        this.logEvent('openai', event.type, event);
      });
      this.client.realtime.on('close', () => {
        this.log('OpenAI Realtime API connection closed');
        this.client = null;
      });

      // Connect to OpenAI Realtime API
      try {
        this.log('Connecting to OpenAI...');
        await this.client.connect();
        this.log('Connected to OpenAI successfully!');
      } catch (e) {
        this.log(`Error connecting to OpenAI: ${e.message}`);
        ws.close();
        return;
      }
    }

    // Add the WebSocket connection to the set
    this.connectedClients.add(ws);

    // Relay events from React UI to OpenAI Realtime API
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        this.log(`Relaying "${event.type}" from React UI to OpenAI`);
        this.io.emit('log', {
          source: 'react',
          type: event.type,
          data: event,
          timestamp: new Date().toISOString()
        });
        // Allow audio interactions only from React UI
        if (event.type.startsWith('input_audio') || event.type.startsWith('input_audio_buffer')) {
          this.client.realtime.send(event.type, event);
        } else {
          this.client.realtime.send(event.type, event);
        }
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from client: ${data}`);
      }
    });
    ws.on('close', () => {
      this.connectedClients.delete(ws);
      if (this.connectedClients.size === 0) {
        // Disconnect from OpenAI when no clients are connected
        this.client.disconnect();
        this.client = null;
      }
    });
  }

  socketConnectionHandler(socket) {
    this.log('Chemistry3D extension connected');
    this.io.emit('log', {
      source: 'system',
      type: 'chemistry3d_connection',
      data: 'Chemistry3D extension connected',
      timestamp: new Date().toISOString()
    });

    // Handle messages from Chemistry3D
    socket.on('message', (msg) => {
      this.log(`Received message from Chemistry3D: ${msg}`);
      // Send messages to OpenAI as text input
      if (this.client) {
        this.client.realtime.send('conversation.item.create', {
          item: {
            type: 'user_message',
            text: msg,
          },
        });
      } else {
        this.log('No OpenAI client connected');
      }
    });

    // Handle function call outputs from Chemistry3D
    socket.on('function_call_output', (data) => {
      this.log('Received function call output from Chemistry3D');
      if (this.client) {
        this.client.realtime.send('conversation.item.create', {
          item: {
            type: 'function_call_output',
            call_id: data.call_id,
            output: data.output,
          },
        });
        // Trigger the assistant to generate the next response
        this.client.realtime.send('response.create', {});
      } else {
        this.log('No OpenAI client connected');
      }
    });
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }

  logEvent(source, type, data) {
    this.io.emit('log', {
      source,
      type,
      data,
      timestamp: new Date().toISOString()
    });
  }
}
