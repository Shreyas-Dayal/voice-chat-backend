// server.js

// 1. Import necessary libraries
const express = require('express'); // For creating the HTTP server
const http = require('http');     // Node's built-in module to create an HTTP server
const WebSocket = require('ws');   // For the WebSocket server functionality

// 2. Initialize Express app
const app = express();

// 3. Create an HTTP server using the Express app - 'ws' library needs an existing HTTP server to attach the WebSocket server to
const server = http.createServer(app);

// 4. Create a WebSocket server instance, attached to the HTTP server
const wss = new WebSocket.Server({ server });

// 5. Define the port the server will listen on
// We'll make this configurable later using environment variables
const PORT = 8080;

// 6. Basic HTTP route (optional, just to check if the HTTP server is running)
app.get('/', (req, res) => {
    res.send('Voice Chat Backend is running!');
});

// 7. Start the HTTP server (which also allows the WebSocket server to accept connections)
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`WebSocket server ready at ws://localhost:${PORT}`);
});

// --- WebSocket connection logic will go here later ---
wss.on('connection', (wsClient) => {
    console.log('Frontend client connected!'); // Log when a browser connects

    // Handle messages from the client
    wsClient.on('message', (message) => {
        console.log('Received message from client:', message);
        // We will process audio data here later
    });

    // Handle client disconnection
    wsClient.on('close', (code, reason) => {
        console.log(`Frontend client disconnected: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
        // Cleanup related OpenAI connection later
    });

    // Handle client errors
    wsClient.on('error', (error) => {
        console.error('Frontend client WebSocket Error:', error);
        // Cleanup related OpenAI connection later
    });
});