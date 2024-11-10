import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sockets = new WeakMap();
    this.wss = null;
    this.io = null; // Socket.IO server
  }

  listen(port) {
    // Create an HTTP server
    const server = createServer();

    // Set up WebSocketServer for React UI on path '/ws'
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', this.connectionHandler.bind(this));

    // Set up Socket.IO server for Chemistry3D extension (default path '/socket.io')
    this.io = new SocketIOServer(server);
    this.io.on('connection', this.socketConnectionHandler.bind(this));

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

    // Instantiate new client
    this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: this.apiKey });

    // Relay: OpenAI Realtime API Event -> Browser Event
    client.realtime.on('server.*', (event) => {
      this.log(`Relaying "${event.type}" to Client`);
      ws.send(JSON.stringify(event));
    });
    client.realtime.on('close', () => ws.close());

    // Relay: Browser Event -> OpenAI Realtime API Event
    // We need to queue data waiting for the OpenAI connection
    const messageQueue = [];
    const messageHandler = (data) => {
      try {
        const event = JSON.parse(data);
        this.log(`Relaying "${event.type}" to OpenAI`);
        client.realtime.send(event.type, event);
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from client: ${data}`);
      }
    };
    ws.on('message', (data) => {
      if (!client.isConnected()) {
        messageQueue.push(data);
      } else {
        messageHandler(data);
      }
    });
    ws.on('close', () => client.disconnect());

    // Connect to OpenAI Realtime API
    try {
      this.log(`Connecting to OpenAI...`);
      await client.connect();
    } catch (e) {
      this.log(`Error connecting to OpenAI: ${e.message}`);
      ws.close();
      return;
    }
    this.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
      messageHandler(messageQueue.shift());
    }
  }

  socketConnectionHandler(socket) {
    this.log('Chemistry3D extension connected');

    // Handle messages from Chemistry3D extension
    socket.on('message', (msg) => {
      this.log(`Received message from Chemistry3D: ${msg}`);
      // Process the message and optionally send a response
    });

    // Optionally send messages to Chemistry3D extension
    // socket.emit('message', 'Hello Chemistry3D');
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }
}
