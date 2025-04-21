// src/server.ts
import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import cors from 'cors';
import { PORT } from './config';
// Correctly import the CommonJS module using default import
import openaiHandler from './openaiHandler';

// --- Basic Server Setup ---
const app: express.Express = express();
const server: http.Server = http.createServer(app);
const wss: WebSocketServer = new WebSocketServer({ server });

// --- CORS Configuration ---
const allowedOrigins: string[] = ['http://localhost:5173'];

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin or from allowed list
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      callback(new Error(msg), false);
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
console.log(`[Server] CORS enabled for origins: ${allowedOrigins.join(', ')}`);

// WebSocket Connection Handling
wss.on('connection', (wsClient: WebSocket, req: http.IncomingMessage) => {
    const clientIp: string | undefined = req.socket?.remoteAddress;
    const origin: string | undefined = req.headers.origin;

    // Ensure corsOptions.origin is the function before calling
    if (typeof corsOptions.origin === 'function') {
        // @ts-ignore
        corsOptions.origin(origin, (err: Error | null, allow?: boolean) => {
            if (err || !allow) {
                console.warn(`[Server] Rejected WebSocket connection from ${clientIp || 'Unknown IP'} (Origin: ${origin || 'N/A'}) due to CORS policy. Error: ${err?.message}`);
                wsClient.close(1008, 'Origin not allowed');
            } else {
                console.log(`[Server] New client connection allowed from ${clientIp || 'Unknown IP'} (Origin: ${origin || 'N/A'})`);
                // Access the imported function correctly
                openaiHandler.handleNewClientConnection(wsClient, clientIp);
            }
        });
    } else {
        // Fallback/error handling if origin is not a function (shouldn't happen with this config)
         console.error("[Server] CORS origin configuration issue: Expected a function.");
         // Decide how to handle this - reject connection as a safe default
         wsClient.close(1011, 'Server CORS configuration error');
    }
});

wss.on('error', (error: Error) => {
    console.error('[Server] Main WebSocket Server Error:', error);
});

// Basic HTTP Route
app.get('/', (req: Request, res: Response) => {
    res.send(`OpenAI Realtime Voice Backend WebSocket server is running on port ${PORT}`);
});

// Start the Server
server.listen(PORT, () => {
    console.log(`[Server] HTTP server started on port ${PORT}`);
    console.log(`[Server] WebSocket server listening on ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM signal received. Closing server...');
    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'Server shutting down');
        }
    });
    server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
    });

    setTimeout(() => {
        console.error('[Server] Could not close connections gracefully, forcing shutdown.');
        process.exit(1);
    }, 10000);
});