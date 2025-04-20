// backend/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { PORT } = require('./config');
const { handleNewClientConnection } = require('./openaiHandler');

// --- Basic Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- CORS Configuration ---
// Allow requests ONLY from your Vite dev server origin during development
const allowedOrigins = ['http://localhost:5173']; // Adjust port if needed

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
console.log(`[Server] CORS enabled for origins: ${allowedOrigins.join(', ')}`);

// WebSocket Connection Handling
wss.on('connection', (wsClient, req) => {
    const clientIp = req.socket.remoteAddress;
    // Check if the upgrade request origin is allowed by CORS
    // Note: The 'ws' library handles the upgrade, but we log the origin check result
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin) || !origin) {
         console.log(`[Server] New client connection allowed from ${clientIp} (Origin: ${origin || 'N/A'})`);
         handleNewClientConnection(wsClient, clientIp); // Pass IP for logging
    } else {
        console.warn(`[Server] Rejected client connection from ${clientIp} (Origin: ${origin}) due to CORS policy.`);
        wsClient.close(1008, 'Origin not allowed');
    }
});

wss.on('error', (error) => {
    console.error('[Server] Main WebSocket Server Error:', error);
});

// Basic HTTP Route
app.get('/', (req, res) => {
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
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'Server shutting down');
        }
    });
    server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
    });
});

// // server.js
// const express = require('express');
// const http = require('http');
// const WebSocket = require('ws');
// const cors = require('cors'); // <-- Import cors
// const { PORT } = require('./config');
// const { handleNewClientConnection } = require('./openaiHandler');

// // --- Basic Server Setup ---
// const app = express();

// // --- CORS Configuration ---
// // Allow requests from your specific frontend development origin
// const corsOptions = {
//   origin: 'http://localhost:5173', // <-- Adjust if your frontend runs on a different port
//   optionsSuccessStatus: 200 // Some legacy browsers choke on 204
// };
// // In production, you'd restrict this more:
// // const corsOptions = {
// //   origin: 'https://your-frontend-domain.com',
// //   optionsSuccessStatus: 200
// // };

// app.use(cors(corsOptions)); // <-- Use CORS middleware

// // --- The rest of your server setup ---
// const server = http.createServer(app);
// const wss = new WebSocket.Server({ server });

// // WebSocket Connection Handling
// wss.on('connection', (wsClient, req) => {
//     // Note: CORS headers primarily affect the initial HTTP upgrade request.
//     // The 'ws' library usually handles the upgrade correctly once permitted.
//     console.log(`[Server] New client connection from ${req.socket.remoteAddress}`);
//     handleNewClientConnection(wsClient);
// });

// wss.on('error', (error) => {
//     console.error('[Server] Main WebSocket Server Error:', error);
// });

// // Basic HTTP Route (Optional)
// app.get('/', (req, res) => {
//     res.send(`Voice Chat Backend WebSocket server is running on port ${PORT}`);
// });

// // Start the Server
// server.listen(PORT, () => {
//     console.log(`[Server] HTTP server started on port ${PORT}`);
//     console.log(`[Server] WebSocket server listening on ws://localhost:${PORT}`);
//     console.log(`[Server] Allowing CORS requests from: ${corsOptions.origin}`); // Log allowed origin
// });

// // Optional: Graceful shutdown handling (remains the same)
// process.on('SIGTERM', () => {
//     console.log('[Server] SIGTERM signal received. Closing server...');
//     wss.clients.forEach(client => {
//         if (client.readyState === WebSocket.OPEN) {
//             client.close(1001, 'Server shutting down');
//         }
//     });
//     server.close(() => {
//         console.log('[Server] HTTP server closed.');
//         process.exit(0);
//     });
// });

// // // server.js

// // // 1. Import necessary libraries
// // const express = require('express'); // For creating the HTTP server
// // const http = require('http');     // Node's built-in module to create an HTTP server
// // const WebSocket = require('ws');   // For the WebSocket server functionality

// // // 2. Initialize Express app
// // const app = express();

// // // 3. Create an HTTP server using the Express app - 'ws' library needs an existing HTTP server to attach the WebSocket server to
// // const server = http.createServer(app);

// // // 4. Create a WebSocket server instance, attached to the HTTP server
// // const wss = new WebSocket.Server({ server });

// // // 5. Define the port the server will listen on
// // // We'll make this configurable later using environment variables
// // const PORT = 8080;

// // // 6. Basic HTTP route (optional, just to check if the HTTP server is running)
// // app.get('/', (req, res) => {
// //     res.send('Voice Chat Backend is running!');
// // });

// // // 7. Start the HTTP server (which also allows the WebSocket server to accept connections)
// // server.listen(PORT, () => {
// //     console.log(`Server started on port ${PORT}`);
// //     console.log(`WebSocket server ready at ws://localhost:${PORT}`);
// // });

// // // --- WebSocket connection logic will go here later ---
// // wss.on('connection', (wsClient) => {
// //     console.log('Frontend client connected!'); // Log when a browser connects

// //     // Handle messages from the client
// //     wsClient.on('message', (message) => {
// //         console.log('Received message from client:', message);
// //         // We will process audio data here later
// //     });

// //     // Handle client disconnection
// //     wsClient.on('close', (code, reason) => {
// //         console.log(`Frontend client disconnected: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
// //         // Cleanup related OpenAI connection later
// //     });

// //     // Handle client errors
// //     wsClient.on('error', (error) => {
// //         console.error('Frontend client WebSocket Error:', error);
// //         // Cleanup related OpenAI connection later
// //     });
// // });