// backend/openaiHandler.js
const WebSocket = require('ws');
const { OPENAI_CONFIG, OPENAI_API_KEY } = require('./config');

// Simple in-memory log (replace with proper logging/DB if needed)
const conversationLog = [];

/**
 * Handles a new WebSocket client connection, bridging it to the OpenAI Realtime API.
 * @param {WebSocket} wsClient The WebSocket connection from the frontend client.
 * @param {string} clientIp The IP address of the client for logging.
 */
function handleNewClientConnection(wsClient, clientIp) {
    console.log(`[Handler:${clientIp}] New client connected. Initiating OpenAI connection...`);

    let wsOpenAI = null;
    let clientClosed = false;
    let openAIConnected = false;
    let openAISessionId = null;
    let turnInProgress = false; // Track if we are waiting for OpenAI response

    conversationLog.push({ timestamp: Date.now(), type: 'connect', ip: clientIp });

    // --- Establish WebSocket connection to OpenAI ---
    try {
        const headers = {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
        };
        wsOpenAI = new WebSocket(OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL, { headers });
        console.log(`[Handler:${clientIp}] Attempting connection to OpenAI: ${OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL}`);
    } catch (error) {
        console.error(`[Handler:${clientIp}] Error creating OpenAI WebSocket:`, error);
        safeCloseClient(wsClient, 1011, 'Failed to initiate OpenAI connection');
        return;
    }

    // --- Utility Functions ---
    function safeCloseClient(client, code, reason) { /* ... (no changes needed) ... */
        if (client && client.readyState === WebSocket.OPEN) {
            console.log(`[Handler:${clientIp}] Closing client connection: ${code} - ${reason}`);
            client.close(code, reason);
        }
        clientClosed = true;
    }
    function safeCloseOpenAI(openaiWs, code, reason) { /* ... (no changes needed) ... */
        if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
             console.log(`[Handler:${clientIp}] Closing OpenAI connection: ${code} - ${reason}`);
            openaiWs.close(code, reason);
        }
        openAIConnected = false;
        wsOpenAI = null;
    }

    // --- Handle OpenAI WebSocket Events ---
    wsOpenAI.on('open', () => {
        if (clientClosed) { /* ... (no changes needed) ... */
            console.log(`[Handler:${clientIp}] Client disconnected before OpenAI connection opened. Closing OpenAI.`);
            safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
            return;
        }
        openAIConnected = true;
        console.log(`[Handler:${clientIp}] Connected to OpenAI Realtime API.`);

        // --- Configure the Session (PCM16, server_vad, Default Auto-Response) ---
        const sessionUpdateEvent = {
            type: "session.update",
            session: {
                instructions: "You are a helpful voice assistant. Respond ONLY in English.",
                output_audio_format: "pcm16", // Required based on errors
                input_audio_format: "pcm16",  // Required based on errors
                turn_detection: {
                    type: "server_vad"
                    // create_response: true, // Default is true, no need to explicitly set
                    // interrupt_response: true // Default is true
                },
                // --- *** CHANGE VOICE *** ---
                voice: "shimmer", // Or nova
            },
            event_id: `session_config_${Date.now()}`
        };

        try {
             if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
                wsOpenAI.send(JSON.stringify(sessionUpdateEvent));
                console.log(`[Handler:${clientIp}] Sent session configuration to OpenAI (pcm16, server_vad auto-response).`);
             }
        } catch(e) { /* ... (no changes needed) ... */
            console.error(`[Handler:${clientIp}] Error sending session config:`, e);
            safeCloseClient(wsClient, 1011, 'Failed to configure OpenAI session');
            safeCloseOpenAI(wsOpenAI, 1011, 'Failed to send session config');
        }
    });

    wsOpenAI.on('message', (messageBuffer) => {
        if (clientClosed || !openAIConnected) return;
        try {
            const messageString = messageBuffer.toString();
            const data = JSON.parse(messageString);
            // console.log(`[Handler:${clientIp}] OpenAI RAW Message:`, JSON.stringify(data, null, 2));

            switch (data.type) {
                // -- Session Events --
                case 'session.created': /* ... (no changes needed) ... */
                    openAISessionId = data.session?.id;
                    console.log(`[Handler:${clientIp}] OpenAI session created: ${openAISessionId}`);
                    conversationLog.push({ timestamp: Date.now(), type: 'session_created', sessionId: openAISessionId });
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AIConnected', sessionId: openAISessionId }));
                    }
                    break;
                case 'session.updated': /* ... (no changes needed) ... */
                    console.log(`[Handler:${clientIp}] OpenAI session updated.`, data.session);
                    break;
                case 'session.closed': /* ... (no changes needed) ... */
                    console.log(`[Handler:${clientIp}] OpenAI session closed by server.`);
                    conversationLog.push({ timestamp: Date.now(), type: 'openai_closed_by_server' });
                    safeCloseClient(wsClient, 1000, 'OpenAI session closed');
                    safeCloseOpenAI(wsOpenAI, 1000, 'Session closed by server');
                    break;

                // -- Response Lifecycle --
                case 'response.created': /* ... (no changes needed) ... */
                    console.log(`[Handler:${clientIp}] OpenAI response generation started. Response ID: ${data.response?.id}`);
                    turnInProgress = true;
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseStart' }));
                    }
                    break;

                // --- HANDLE AUDIO DELTA (Will be PCM16) ---
                case 'response.audio.delta':
                    if (data.delta) {
                        const audioBuffer = Buffer.from(data.delta, 'base64');
                        console.log(`[Handler:${clientIp}] Received OpenAI audio chunk (PCM16): ${audioBuffer.length} bytes`);
                        if (wsClient.readyState === WebSocket.OPEN) {
                            wsClient.send(audioBuffer); // Send raw PCM16 Buffer
                        }
                    }
                    break;

                 // --- HANDLE TEXT DELTA ---
                 case 'response.text.delta': /* ... (no changes needed) ... */
                    if (data.delta) {
                         if (wsClient.readyState === WebSocket.OPEN) {
                            wsClient.send(JSON.stringify({ type: 'textDelta', text: data.delta }));
                         }
                    }
                    break;

                case 'response.audio_transcript.delta': break; // Mark as handled

                // --- FINAL TEXT EXTRACTION IN response.done ---
                case 'response.done': /* ... (no changes needed) ... */
                    console.log(`[Handler:${clientIp}] OpenAI response generation finished. Status: ${data.response?.status}`);
                    turnInProgress = false; // Allow new response trigger if needed (though VAD handles it)
                    let finalAssistantText = '';
                    if (data.response?.output?.[0]?.type === 'message') {
                        const contentArray = data.response.output[0].content || [];
                        const textPart = contentArray.find(part => part.type === 'output_text');
                        if (textPart?.text) { finalAssistantText = textPart.text; }
                        else { const audioPart = contentArray.find(part => part.type === 'audio' && part.transcript); if (audioPart?.transcript) { finalAssistantText = audioPart.transcript; } }
                    }
                    if (finalAssistantText) {
                         console.log(`[Handler:${clientIp}] Extracted Final Assistant Text: ${finalAssistantText}`);
                         conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: finalAssistantText });
                    } else {
                         console.warn(`[Handler:${clientIp}] Could not extract final assistant text from response.done event.`);
                         conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: '[No text extracted]' });
                    }
                    if (wsClient.readyState === WebSocket.OPEN) {
                         wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseEnd', finalText: finalAssistantText }));
                    }
                    break;

                // -- Input Handling Events --
                case 'input_audio_buffer.speech_started': /* ... (no changes needed) ... */
                    console.log(`[Handler:${clientIp}] OpenAI detected speech start.`);
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechDetected' }));
                    }
                    break;
                 case 'input_audio_buffer.speech_stopped': /* ... (no changes needed - REMOVED manual trigger) ... */
                    console.log(`[Handler:${clientIp}] OpenAI detected speech stop.`);
                     if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechEnded' }));
                    }
                    // VAD with create_response=true will trigger the response automatically
                    break;

                 // -- Other Handled Events --
                 case 'input_audio_buffer.committed':
                 case 'conversation.item.created':
                 case 'response.output_item.added':
                 case 'response.content_part.added':
                 case 'response.audio.done':
                 case 'response.text.done':
                 case 'response.audio_transcript.done':
                 case 'response.content_part.done':
                 case 'response.output_item.done':
                 case 'rate_limits.updated':
                     break; // Mark as handled

                 // -- Error Handling --
                 case 'error':
                 case 'invalid_request_error': /* ... (no changes needed - keep detailed logging) ... */
                    console.error(`[Handler:${clientIp}] RAW Error Data from OpenAI:`, JSON.stringify(data, null, 2));
                    let errMsg = 'Unknown OpenAI error';
                    if (typeof data.message === 'string') { errMsg = data.message; }
                    else if (typeof data.error === 'string') { errMsg = data.error; }
                    else if (data.message && typeof data.message === 'object') { errMsg = data.message.message || JSON.stringify(data.message); }
                    else if (data.error && typeof data.error === 'object') { errMsg = data.error.message || JSON.stringify(data.error); }
                    else { errMsg = JSON.stringify(data); }
                    const errCode = data.code || data.error?.code || 'UnknownCode';
                    const errEventId = data.event_id || data.error?.event_id || 'N/A';
                    console.error(`[Handler:${clientIp}] Parsed Error from OpenAI: Code=${errCode}, Message='${errMsg}', ClientEventID=${errEventId}`);
                    conversationLog.push({ timestamp: Date.now(), type: 'openai_error', code: errCode, message: errMsg, rawData: data });
                    safeCloseClient(wsClient, 1011, `OpenAI Error: ${errMsg.substring(0, 100)}`);
                    safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errMsg.substring(0, 100)}`);
                    break;

                default:
                    console.warn(`[Handler:${clientIp}] Received unhandled message type from OpenAI: ${data.type}`, data);
            }
        } catch (error) { /* ... (no changes needed) ... */
             if (messageBuffer instanceof Buffer && messageBuffer.length > 0) { console.warn(`[Handler:${clientIp}] Received non-JSON message from OpenAI (length ${messageBuffer.length}).`); }
             else { console.error(`[Handler:${clientIp}] Error processing message from OpenAI:`, error); console.error(`[Handler:${clientIp}] Original OpenAI message content:`, messageBuffer.toString()); }
        }
    });

    // --- OpenAI Error/Close Handlers ---
    wsOpenAI.on('error', (error) => { /* ... (no changes needed) ... */
        if (clientClosed) return;
        console.error(`[Handler:${clientIp}] OpenAI WebSocket Error:`, error);
        conversationLog.push({ timestamp: Date.now(), type: 'openai_ws_error', message: error.message });
        safeCloseClient(wsClient, 1011, 'OpenAI connection error');
        safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
    });
    wsOpenAI.on('close', (code, reason) => { /* ... (no changes needed) ... */
        if (!openAIConnected && wsOpenAI === null) return;
        const reasonString = reason ? reason.toString() : 'N/A';
        console.log(`[Handler:${clientIp}] OpenAI WebSocket closed: Code=${code}, Reason=${reasonString}`);
        conversationLog.push({ timestamp: Date.now(), type: 'openai_closed', code, reason: reasonString });
        safeCloseClient(wsClient, 1000, `OpenAI session ended (${code})`);
        openAIConnected = false;
        wsOpenAI = null;
    });

    // --- Handle Frontend Client WebSocket Events ---
    wsClient.on('message', (message) => { /* ... (no changes needed) ... */
        // console.log(`[Handler:${clientIp}] Received message from client. Type: ${typeof message}, IsBuffer: ${Buffer.isBuffer(message)}, Length: ${message?.length}`);
        if (clientClosed) return;
        if (Buffer.isBuffer(message)) { // Audio data
            if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
                const base64Audio = message.toString('base64');
                const appendEvent = { type: 'input_audio_buffer.append', audio: base64Audio };
                try { wsOpenAI.send(JSON.stringify(appendEvent)); conversationLog.push({ timestamp: Date.now(), type: 'user_audio_chunk_sent', size: message.length }); }
                catch (error) { console.error(`[Handler:${clientIp}] Error sending audio chunk to OpenAI:`, error); }
            } else { console.warn(`[Handler:${clientIp}] Received client audio, but OpenAI WebSocket is not ready.`); }
        } else if (typeof message === 'string') { /* ... (no changes needed) ... */ }
        else { console.warn(`[Handler:${clientIp}] Received unexpected message type from client:`, typeof message); }
    });
    wsClient.on('close', (code, reason) => { /* ... (no changes needed) ... */
        if (clientClosed) return;
        const reasonString = reason ? reason.toString() : 'N/A';
        console.log(`[Handler:${clientIp}] Frontend client disconnected: Code=${code}, Reason=${reasonString}`);
        conversationLog.push({ timestamp: Date.now(), type: 'client_disconnected', code, reason: reasonString });
        clientClosed = true;
        safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
    });
    wsClient.on('error', (error) => { /* ... (no changes needed) ... */
        if (clientClosed) return;
        console.error(`[Handler:${clientIp}] Frontend client WebSocket Error:`, error);
        conversationLog.push({ timestamp: Date.now(), type: 'client_ws_error', message: error.message });
        clientClosed = true;
        safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
    });
}

module.exports = {
    handleNewClientConnection,
};

// // backend/openaiHandler.js
// const WebSocket = require('ws');
// const { OPENAI_CONFIG, OPENAI_API_KEY } = require('./config');

// // Simple in-memory log (replace with proper logging/DB if needed)
// const conversationLog = [];

// /**
//  * Handles a new WebSocket client connection, bridging it to the OpenAI Realtime API.
//  * @param {WebSocket} wsClient The WebSocket connection from the frontend client.
//  * @param {string} clientIp The IP address of the client for logging.
//  */
// function handleNewClientConnection(wsClient, clientIp) {
//     console.log(`[Handler:${clientIp}] New client connected. Initiating OpenAI connection...`);

//     let wsOpenAI = null;
//     let clientClosed = false;
//     let openAIConnected = false;
//     let openAISessionId = null;
//     let turnInProgress = false; // Track if we are waiting for OpenAI response

//     conversationLog.push({ timestamp: Date.now(), type: 'connect', ip: clientIp });

//     // --- Establish WebSocket connection to OpenAI ---
//     try {
//         const headers = {
//             "Authorization": `Bearer ${OPENAI_API_KEY}`,
//             "OpenAI-Beta": "realtime=v1",
//         };
//         // Use the URL with the model query parameter
//         wsOpenAI = new WebSocket(OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL, { headers });
//         console.log(`[Handler:${clientIp}] Attempting connection to OpenAI: ${OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL}`);
//     } catch (error) {
//         console.error(`[Handler:${clientIp}] Error creating OpenAI WebSocket:`, error);
//         safeCloseClient(wsClient, 1011, 'Failed to initiate OpenAI connection');
//         return;
//     }

//     // --- Utility Functions for safe closing ---
//     function safeCloseClient(client, code, reason) {
//         if (client && client.readyState === WebSocket.OPEN) {
//             console.log(`[Handler:${clientIp}] Closing client connection: ${code} - ${reason}`);
//             client.close(code, reason);
//         }
//         clientClosed = true;
//     }

//     function safeCloseOpenAI(openaiWs, code, reason) {
//         if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
//              console.log(`[Handler:${clientIp}] Closing OpenAI connection: ${code} - ${reason}`);
//             openaiWs.close(code, reason);
//         }
//         openAIConnected = false; // Mark as disconnected
//         wsOpenAI = null;
//     }

//     // --- Handle OpenAI WebSocket Events ---
//     wsOpenAI.on('open', () => {
//         if (clientClosed) {
//             console.log(`[Handler:${clientIp}] Client disconnected before OpenAI connection opened. Closing OpenAI.`);
//             safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
//             return;
//         }
//         openAIConnected = true;
//         console.log(`[Handler:${clientIp}] Connected to OpenAI Realtime API.`);

//         // --- Configure the Session (Strictly follow error message values) ---
//         const sessionUpdateEvent = {
//             type: "session.update",
//             session: {
//                 instructions: "You are a helpful voice assistant. Be concise.",
//                 // --- Use strictly allowed format strings for session.update ---
//                 output_audio_format: "pcm16",
//                 input_audio_format: "pcm16",
//                 // --- END FORMATS ---
//                 turn_detection: {
//                     type: "server_vad" // Use one of the supported values from the error message
//                 },
//             },
//             event_id: `session_config_${Date.now()}`
//         };

//         try {
//              if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
//                 wsOpenAI.send(JSON.stringify(sessionUpdateEvent));
//                 console.log(`[Handler:${clientIp}] Sent session configuration to OpenAI (using pcm16 formats).`);
//              }
//         } catch(e) {
//             console.error(`[Handler:${clientIp}] Error sending session config:`, e);
//             safeCloseClient(wsClient, 1011, 'Failed to configure OpenAI session');
//             safeCloseOpenAI(wsOpenAI, 1011, 'Failed to send session config');
//         }
//     });

//     wsOpenAI.on('message', (messageBuffer) => {
//         if (clientClosed || !openAIConnected) return;

//         try {
//             const messageString = messageBuffer.toString();
//             const data = JSON.parse(messageString);

//             // console.log(`[Handler:${clientIp}] OpenAI RAW Message:`, JSON.stringify(data, null, 2)); // Verbose Debug

//             switch (data.type) {
//                 // -- Session Events --
//                 case 'session.created':
//                     openAISessionId = data.session?.id;
//                     console.log(`[Handler:${clientIp}] OpenAI session created: ${openAISessionId}`);
//                     conversationLog.push({ timestamp: Date.now(), type: 'session_created', sessionId: openAISessionId });
//                     // Inform client connection is fully ready
//                     if (wsClient.readyState === WebSocket.OPEN) {
//                         wsClient.send(JSON.stringify({ type: 'event', name: 'AIConnected', sessionId: openAISessionId }));
//                     }
//                     break;
//                 case 'session.updated':
//                     console.log(`[Handler:${clientIp}] OpenAI session updated.`, data.session); // Keep this log
//                     break;
//                 case 'session.closed':
//                     console.log(`[Handler:${clientIp}] OpenAI session closed by server.`);
//                     conversationLog.push({ timestamp: Date.now(), type: 'openai_closed_by_server' });
//                     safeCloseClient(wsClient, 1000, 'OpenAI session closed');
//                     safeCloseOpenAI(wsOpenAI, 1000, 'Session closed by server');
//                     break;

//                 // -- Response Lifecycle Events --
//                 case 'response.created':
//                     console.log(`[Handler:${clientIp}] OpenAI response generation started. Response ID: ${data.response?.id}`);
//                     turnInProgress = true;
//                     if (wsClient.readyState === WebSocket.OPEN) {
//                         wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseStart' }));
//                     }
//                     break;

//                 // --- *** HANDLE AUDIO DELTA *** ---
//                 case 'response.audio.delta':
//                     if (data.delta) {
//                         const audioBuffer = Buffer.from(data.delta, 'base64');
//                         // --- ADD LOG ---
//                         console.log(`[Handler:${clientIp}] Received OpenAI audio chunk (PCM16): ${audioBuffer.length} bytes`);
//                         // --- END LOG ---
//                         if (wsClient.readyState === WebSocket.OPEN) {
//                             wsClient.send(audioBuffer);
//                         }
//                     }
//                     break;
//                  // --- *** END HANDLE AUDIO DELTA *** ---

//                  // --- *** HANDLE TEXT DELTA *** ---
//                  case 'response.text.delta':
//                     if (data.delta) {
//                          // Forward text delta to client
//                          if (wsClient.readyState === WebSocket.OPEN) {
//                             wsClient.send(JSON.stringify({ type: 'textDelta', text: data.delta }));
//                          }
//                     }
//                     break;
//                 // --- *** END HANDLE TEXT DELTA *** ---

//                 case 'response.audio_transcript.delta':
//                     // Optional: Log or forward if needed for separate display
//                     // console.log(`[Handler:${clientIp}] Partial transcript delta: ${data.delta?.text}`);
//                     break; // Mark as handled

//                 // --- *** FIX FINAL TEXT EXTRACTION IN response.done *** ---
//                 case 'response.done':
//                     console.log(`[Handler:${clientIp}] OpenAI response generation finished. Status: ${data.response?.status}`);
//                     turnInProgress = false;

//                     let finalAssistantText = '';
//                     // Try to extract final text from the response object
//                     if (data.response?.output?.[0]?.type === 'message') {
//                         const contentArray = data.response.output[0].content || [];
//                         // Look for an explicit text part first
//                         const textPart = contentArray.find(part => part.type === 'output_text');
//                         if (textPart?.text) {
//                             finalAssistantText = textPart.text;
//                         } else {
//                             // Fallback: look for an audio part with a transcript
//                             const audioPart = contentArray.find(part => part.type === 'audio' && part.transcript);
//                             if (audioPart?.transcript) {
//                                 finalAssistantText = audioPart.transcript;
//                             }
//                         }
//                     }

//                     if (finalAssistantText) {
//                          console.log(`[Handler:${clientIp}] Extracted Final Assistant Text: ${finalAssistantText}`);
//                          conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: finalAssistantText });
//                     } else {
//                          console.warn(`[Handler:${clientIp}] Could not extract final assistant text from response.done event.`);
//                          conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: '[No text extracted]' });
//                     }

//                     // Inform client that the response is fully complete
//                     if (wsClient.readyState === WebSocket.OPEN) {
//                          wsClient.send(JSON.stringify({
//                             type: 'event',
//                             name: 'AIResponseEnd',
//                             finalText: finalAssistantText // Send the extracted text
//                         }));
//                     }
//                     break;
//                 // --- *** END FIX FINAL TEXT EXTRACTION *** ---

//                 // -- Input Handling Events (Informational) --
//                 case 'input_audio_buffer.speech_started':
//                     console.log(`[Handler:${clientIp}] OpenAI detected speech start.`);
//                     if (wsClient.readyState === WebSocket.OPEN) {
//                         wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechDetected' }));
//                     }
//                     break;
//                 case 'input_audio_buffer.speech_stopped':
//                     console.log(`[Handler:${clientIp}] OpenAI detected speech stop.`);
//                      if (wsClient.readyState === WebSocket.OPEN) {
//                         wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechEnded' }));
//                     }
//                     break;
//                 case 'input_audio_buffer.committed':
//                     // Informational: OpenAI has processed a chunk/turn of user audio
//                     // console.log(`[Handler:${clientIp}] OpenAI committed audio input item: ${data.item_id}`);
//                     break; // Mark as handled

//                  // -- Other Events (Mark as Handled or Log) --
//                  case 'conversation.item.created':
//                      // Informational: An item (user message, AI response) was added to the conversation state
//                      // console.log(`[Handler:${clientIp}] OpenAI created conversation item: ${data.item?.id} (${data.item?.role})`);
//                      break; // Mark as handled
//                  case 'response.output_item.added':
//                  case 'response.content_part.added':
//                  case 'response.audio.done': // Contains no audio bytes, just signals end of audio stream
//                  case 'response.text.done': // Signals end of text stream
//                  case 'response.audio_transcript.done': // Signals end of *this specific* transcript part
//                  case 'response.content_part.done':
//                  case 'response.output_item.done':
//                      // These are lifecycle events, often don't need client forwarding
//                      // console.log(`[Handler:${clientIp}] Received lifecycle event: ${data.type}`);
//                      break; // Mark as handled
//                  case 'rate_limits.updated':
//                     // Informational
//                     // console.log(`[Handler:${clientIp}] Rate limits updated.`);
//                     break; // Mark as handled


//                  // -- Error Handling --
//                  case 'error':
//                  case 'invalid_request_error':
//                     console.error(`[Handler:${clientIp}] RAW Error Data from OpenAI:`, JSON.stringify(data, null, 2)); // Log the full object

//                     // Attempt to get a meaningful message
//                     let errMsg = 'Unknown OpenAI error';
//                     if (typeof data.message === 'string') {
//                         errMsg = data.message;
//                     } else if (typeof data.error === 'string') {
//                         errMsg = data.error;
//                     } else if (data.message && typeof data.message === 'object') { // Check if nested error object
//                         errMsg = data.message.message || JSON.stringify(data.message);
//                     } else if (data.error && typeof data.error === 'object') {
//                          errMsg = data.error.message || JSON.stringify(data.error);
//                     } else {
//                          errMsg = JSON.stringify(data); // Fallback
//                     }

//                     const errCode = data.code || data.error?.code || 'UnknownCode';
//                     const errEventId = data.event_id || data.error?.event_id || 'N/A';

//                     console.error(`[Handler:${clientIp}] Parsed Error from OpenAI: Code=${errCode}, Message='${errMsg}', ClientEventID=${errEventId}`);
//                     conversationLog.push({ timestamp: Date.now(), type: 'openai_error', code: errCode, message: errMsg, rawData: data });

//                     // Use the potentially stringified message for closing
//                     safeCloseClient(wsClient, 1011, `OpenAI Error: ${errMsg.substring(0, 100)}`); // Limit length
//                     safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errMsg.substring(0, 100)}`);
//                     break;

//                 default: // Keep this for genuinely unknown types
//                     console.warn(`[Handler:${clientIp}] Received unhandled message type from OpenAI: ${data.type}`, data);
//             }
//         } catch (error) {
//             // Handle cases where the message isn't valid JSON
//             if (messageBuffer instanceof Buffer && messageBuffer.length > 0) {
//                  console.warn(`[Handler:${clientIp}] Received non-JSON message from OpenAI (length ${messageBuffer.length}).`);
//                  // Don't forward unexpected binary data
//             } else {
//                 console.error(`[Handler:${clientIp}] Error processing message from OpenAI:`, error);
//                 console.error(`[Handler:${clientIp}] Original OpenAI message content:`, messageBuffer.toString());
//             }
//         }
//     });

//     wsOpenAI.on('error', (error) => {
//         if (clientClosed) return;
//         console.error(`[Handler:${clientIp}] OpenAI WebSocket Error:`, error);
//         conversationLog.push({ timestamp: Date.now(), type: 'openai_ws_error', message: error.message });
//         safeCloseClient(wsClient, 1011, 'OpenAI connection error');
//         safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
//     });

//     wsOpenAI.on('close', (code, reason) => {
//         // Avoid duplicate actions if already closed by error/session end
//         if (!openAIConnected && wsOpenAI === null) return;

//         const reasonString = reason ? reason.toString() : 'N/A';
//         console.log(`[Handler:${clientIp}] OpenAI WebSocket closed: Code=${code}, Reason=${reasonString}`);
//         conversationLog.push({ timestamp: Date.now(), type: 'openai_closed', code, reason: reasonString });
//         safeCloseClient(wsClient, 1000, `OpenAI session ended (${code})`);
//         openAIConnected = false;
//         wsOpenAI = null;
//     });

//     // --- Handle Frontend Client WebSocket Events ---
//     wsClient.on('message', (message) => {
//         // --- DEBUG LOG ---
//         // console.log(`[Handler:${clientIp}] Received message from client. Type: ${typeof message}, IsBuffer: ${Buffer.isBuffer(message)}, Length: ${message?.length}`);
//         // --- END DEBUG LOG ---

//         if (clientClosed) return;

//         // Expecting raw audio binary data (Buffer) from the client
//         if (Buffer.isBuffer(message)) {
//             if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
//                 // console.log(`[Handler:${clientIp}] Received client audio chunk (${message.length} bytes)`); // Verbose

//                 // --- FORWARD AUDIO TO OPENAI ---
//                 // Encode the raw PCM buffer to Base64
//                 const base64Audio = message.toString('base64');
//                 const appendEvent = {
//                     type: 'input_audio_buffer.append',
//                     audio: base64Audio,
//                     // event_id: `audio_chunk_${Date.now()}` // Optional: Add event ID for tracing
//                 };

//                 try {
//                     wsOpenAI.send(JSON.stringify(appendEvent));
//                     conversationLog.push({ timestamp: Date.now(), type: 'user_audio_chunk_sent', size: message.length });
//                 } catch (error) {
//                     console.error(`[Handler:${clientIp}] Error sending audio chunk to OpenAI:`, error);
//                     // Handle potential backpressure or errors
//                 }
//             } else {
//                 console.warn(`[Handler:${clientIp}] Received client audio, but OpenAI WebSocket is not ready.`);
//             }
//         } else if (typeof message === 'string') {
//             // Handle potential control messages from client if needed
//             try {
//                 const controlMsg = JSON.parse(message.toString());
//                  console.log(`[Handler:${clientIp}] Received control message from client:`, controlMsg);
//                  // Example: Client explicitly sending text input
//                  if (controlMsg.type === 'clientText' && controlMsg.text) {
//                      console.log(`[Handler:${clientIp}] User Text: ${controlMsg.text}`);
//                      conversationLog.push({ timestamp: Date.now(), type: 'user_text', text: controlMsg.text });

//                      if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
//                         // Create a conversation item for the text
//                         const textItemEvent = {
//                             type: "conversation.item.create",
//                             item: {
//                                 type: "message",
//                                 role: "user",
//                                 content: [{ type: "input_text", text: controlMsg.text }]
//                             }
//                         };
//                         wsOpenAI.send(JSON.stringify(textItemEvent));

//                         // Trigger a response immediately after sending text
//                         const responseEvent = { type: "response.create" };
//                          wsOpenAI.send(JSON.stringify(responseEvent));
//                          console.log(`[Handler:${clientIp}] Sent user text and requested response from OpenAI.`);
//                      }
//                  } else {
//                      console.warn(`[Handler:${clientIp}] Received unknown/unhandled control message:`, controlMsg.type);
//                  }
//             } catch(e) {
//                 console.warn(`[Handler:${clientIp}] Received non-JSON string from client:`, message.toString());
//             }
//         } else {
//             console.warn(`[Handler:${clientIp}] Received unexpected message type from client:`, typeof message);
//         }
//     });

//     wsClient.on('close', (code, reason) => {
//         if (clientClosed) return;
//         const reasonString = reason ? reason.toString() : 'N/A';
//         console.log(`[Handler:${clientIp}] Frontend client disconnected: Code=${code}, Reason=${reasonString}`);
//         conversationLog.push({ timestamp: Date.now(), type: 'client_disconnected', code, reason: reasonString });
//         clientClosed = true;
//         // Close the corresponding OpenAI connection
//         safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
//     });

//     wsClient.on('error', (error) => {
//         if (clientClosed) return;
//         console.error(`[Handler:${clientIp}] Frontend client WebSocket Error:`, error);
//         conversationLog.push({ timestamp: Date.now(), type: 'client_ws_error', message: error.message });
//         clientClosed = true;
//         safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
//     });
// }

// // Export the handler function
// module.exports = {
//     handleNewClientConnection,
// };


// /////////////////////////////////////////////////////////////

// // // backend/openAIHandler.js
// // const WebSocket = require('ws');
// // const { OPENAI_CONFIG, OPENAI_API_KEY } = require('./config');

// // // Simple in-memory log (replace with proper logging/DB if needed)
// // const conversationLog = [];

// // /**
// //  * Handles a new WebSocket client connection, bridging it to the OpenAI Realtime API.
// //  * @param {WebSocket} wsClient The WebSocket connection from the frontend client.
// //  * @param {string} clientIp The IP address of the client for logging.
// //  */
// // function handleNewClientConnection(wsClient, clientIp) {
// //     console.log(`[Handler:${clientIp}] New client connected. Initiating OpenAI connection...`);

// //     let wsOpenAI = null;
// //     let clientClosed = false;
// //     let openAIConnected = false;
// //     let openAISessionId = null;
// //     let turnInProgress = false; // Track if we are waiting for OpenAI response

// //     conversationLog.push({ timestamp: Date.now(), type: 'connect', ip: clientIp });

// //     // --- Establish WebSocket connection to OpenAI ---
// //     try {
// //         const headers = {
// //             "Authorization": `Bearer ${OPENAI_API_KEY}`,
// //             "OpenAI-Beta": "realtime=v1",
// //         };
// //         // Use the URL with the model query parameter
// //         wsOpenAI = new WebSocket(OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL, { headers });
// //         console.log(`[Handler:${clientIp}] Attempting connection to OpenAI: ${OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL}`);
// //     } catch (error) {
// //         console.error(`[Handler:${clientIp}] Error creating OpenAI WebSocket:`, error);
// //         safeCloseClient(wsClient, 1011, 'Failed to initiate OpenAI connection');
// //         return;
// //     }

// //     // --- Utility Functions for safe closing ---
// //     function safeCloseClient(client, code, reason) {
// //         if (client && client.readyState === WebSocket.OPEN) {
// //             console.log(`[Handler:${clientIp}] Closing client connection: ${code} - ${reason}`);
// //             client.close(code, reason);
// //         }
// //         clientClosed = true;
// //     }

// //     function safeCloseOpenAI(openaiWs, code, reason) {
// //         if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
// //              console.log(`[Handler:${clientIp}] Closing OpenAI connection: ${code} - ${reason}`);
// //             openaiWs.close(code, reason);
// //         }
// //         openAIConnected = false; // Mark as disconnected
// //         wsOpenAI = null;
// //     }

// //     // --- Handle OpenAI WebSocket Events ---
// //     wsOpenAI.on('open', () => {
// //         if (clientClosed) {
// //             console.log(`[Handler:${clientIp}] Client disconnected before OpenAI connection opened. Closing OpenAI.`);
// //             safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
// //             return;
// //         }
// //         openAIConnected = true;
// //         console.log(`[Handler:${clientIp}] Connected to OpenAI Realtime API.`);

// //         // --- Configure the Session (Optional but Recommended) ---
// //         // --- Configure the Session (Use supported VAD type) ---
// //         const sessionUpdateEvent = {
// //             type: "session.update",
// //             session: {
// //                 instructions: "You are a helpful voice assistant. Be concise.",
// //                 // Use a valid output audio format string (e.g., 'pcm16', 'g711_ulaw', or 'g711_alaw')
// //                 output_audio_format: 'pcm16',  // Change to one of the valid options
// //                 input_audio_format: 'pcm16',  // This remains 'pcm16' as before
// //                 turn_detection: {
// //                     type: "server_vad"  // Make sure 'server_vad' is valid for your OpenAI model
// //                 },
// //             },
// //             event_id: `session_config_${Date.now()}`,
// //         };

// //         try {
// //              if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
// //                 wsOpenAI.send(JSON.stringify(sessionUpdateEvent));
// //                 console.log(`[Handler:${clientIp}] Sent session configuration to OpenAI (using string formats).`); // Updated log
// //              }
// //         } catch(e) {
// //             console.error(`[Handler:${clientIp}] Error sending session config:`, e);
// //             safeCloseClient(wsClient, 1011, 'Failed to configure OpenAI session');
// //             safeCloseOpenAI(wsOpenAI, 1011, 'Failed to send session config');
// //         }
// //     });

// //     wsOpenAI.on('message', (messageBuffer) => {
// //         if (clientClosed || !openAIConnected) return;

// //         try {
// //             const messageString = messageBuffer.toString();
// //             const data = JSON.parse(messageString);

// //             // console.log(`[Handler:${clientIp}] OpenAI Message Received: Type=${data.type}`); // Debug: Log all types

// //             switch (data.type) {
// //                 // -- Session Events --
// //                 case 'session.created':
// //                     openAISessionId = data.session?.id;
// //                     console.log(`[Handler:${clientIp}] OpenAI session created: ${openAISessionId}`);
// //                     conversationLog.push({ timestamp: Date.now(), type: 'session_created', sessionId: openAISessionId });
// //                     // Inform client connection is fully ready
// //                     if (wsClient.readyState === WebSocket.OPEN) {
// //                         wsClient.send(JSON.stringify({ type: 'event', name: 'AIConnected', sessionId: openAISessionId }));
// //                     }
// //                     break;
// //                 case 'session.updated':
// //                     console.log(`[Handler:${clientIp}] OpenAI session updated.`, data.session);
// //                     break;
// //                 case 'session.closed':
// //                     console.log(`[Handler:${clientIp}] OpenAI session closed by server.`);
// //                     safeCloseClient(wsClient, 1000, 'OpenAI session closed');
// //                     safeCloseOpenAI(wsOpenAI, 1000, 'Session closed by server');
// //                     break;

// //                 // -- Response Lifecycle Events --
// //                 case 'response.created':
// //                     console.log(`[Handler:${clientIp}] OpenAI response generation started. Response ID: ${data.response?.id}`);
// //                     turnInProgress = true;
// //                     if (wsClient.readyState === WebSocket.OPEN) {
// //                         wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseStart' }));
// //                     }
// //                     break;

// //                 case 'response.audio.delta':
// //                     if (data.delta) {
// //                         // Audio delta is Base64 encoded string in 'delta' field
// //                         const audioBuffer = Buffer.from(data.delta, 'base64');
// //                         // console.log(`[Handler:${clientIp}] Received audio chunk (${audioBuffer.length} bytes)`); // Verbose
// //                         // Send raw binary audio buffer to the frontend client
// //                         if (wsClient.readyState === WebSocket.OPEN) {
// //                             wsClient.send(audioBuffer); // Send as Buffer
// //                         }
// //                     }
// //                     break;

// //                 case 'response.text.delta':
// //                     if (data.delta) {
// //                         // console.log(`[Handler:${clientIp}] Received text delta: '${data.delta}'`); // Verbose
// //                          // Forward text delta to client
// //                          if (wsClient.readyState === WebSocket.OPEN) {
// //                             wsClient.send(JSON.stringify({ type: 'textDelta', text: data.delta }));
// //                          }
// //                     }
// //                     break;

// //                 // Example: log transcription deltas if needed
// //                 // case 'response.audio_transcript.delta':
// //                 //     if (data.delta?.text) {
// //                 //         console.log(`[Handler:${clientIp}] Partial transcript: ${data.delta.text}`);
// //                 //     }
// //                 //     break;

// //                 case 'response.done':
// //                     console.log(`[Handler:${clientIp}] OpenAI response generation finished. Status: ${data.response?.status}`);
// //                     turnInProgress = false;
// //                     // Log final transcript from the response object
// //                     const finalOutput = data.response?.output?.[0]; // Assuming single output item
// //                     let finalAssistantText = '';
// //                     if (finalOutput?.type === 'message' && finalOutput?.role === 'assistant') {
// //                         const textContent = finalOutput.content?.find(c => c.type === 'output_text');
// //                         if (textContent) {
// //                              finalAssistantText = textContent.text;
// //                              console.log(`[Handler:${clientIp}] Final Assistant Text: ${finalAssistantText}`);
// //                              conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: finalAssistantText });
// //                         }
// //                     }
// //                     // Inform client that the response is fully complete
// //                     if (wsClient.readyState === WebSocket.OPEN) {
// //                          wsClient.send(JSON.stringify({
// //                             type: 'event',
// //                             name: 'AIResponseEnd',
// //                             finalText: finalAssistantText // Send final text if available
// //                         }));
// //                     }
// //                     break;

// //                 // -- Input Handling Events (Informational) --
// //                 case 'input_audio_buffer.speech_started':
// //                     console.log(`[Handler:${clientIp}] OpenAI detected speech start.`);
// //                     if (wsClient.readyState === WebSocket.OPEN) {
// //                         wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechDetected' }));
// //                     }
// //                     break;
// //                 case 'input_audio_buffer.speech_stopped':
// //                     console.log(`[Handler:${clientIp}] OpenAI detected speech stop.`);
// //                      if (wsClient.readyState === WebSocket.OPEN) {
// //                         wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechEnded' }));
// //                     }
// //                     break;
// //                 // case 'input_audio_buffer.committed':
// //                 //     console.log(`[Handler:${clientIp}] OpenAI committed audio input.`);
// //                 //     break;

// //                  // -- Error Handling --
// //                                  // -- Error Handling --
// //                  case 'error': // Specific error type from OpenAI schema
// //                  case 'invalid_request_error': // Other potential error types
// //                     console.error(`[Handler:${clientIp}] RAW Error Data from OpenAI:`, JSON.stringify(data, null, 2)); // Log the full object

// //                     // Attempt to get a meaningful message
// //                     let errMsg = 'Unknown OpenAI error';
// //                     if (typeof data.message === 'string') {
// //                         errMsg = data.message;
// //                     } else if (typeof data.error === 'string') {
// //                         errMsg = data.error;
// //                     } else if (data.message) {
// //                         errMsg = JSON.stringify(data.message); // Stringify if it's an object
// //                     } else if (data.error) {
// //                          errMsg = JSON.stringify(data.error); // Stringify if it's an object
// //                     } else {
// //                          errMsg = JSON.stringify(data); // Fallback to stringifying the whole thing
// //                     }

// //                     const errCode = data.code || 'UnknownCode';
// //                     const errEventId = data.event_id || 'N/A';

// //                     console.error(`[Handler:${clientIp}] Parsed Error from OpenAI: Code=${errCode}, Message='${errMsg}', ClientEventID=${errEventId}`);
// //                     conversationLog.push({ timestamp: Date.now(), type: 'openai_error', code: errCode, message: errMsg, rawData: data }); // Log raw data too

// //                     // Use the potentially stringified message for closing
// //                     safeCloseClient(wsClient, 1011, `OpenAI Error: ${errMsg.substring(0, 100)}`); // Limit length
// //                     safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errMsg.substring(0, 100)}`); // Limit length
// //                     break;

// //                 default:
// //                     console.warn(`[Handler:${clientIp}] Received unhandled message type from OpenAI: ${data.type}`, data);
// //             }
// //         } catch (error) {
// //             // Handle cases where the message isn't valid JSON
// //             if (messageBuffer instanceof Buffer && messageBuffer.length > 0) {
// //                  console.warn(`[Handler:${clientIp}] Received non-JSON message from OpenAI (length ${messageBuffer.length}). Might be binary audio?`);
// //                  // If we *unexpectedly* get raw binary, maybe try forwarding? Risky.
// //                  // if (wsClient.readyState === WebSocket.OPEN) {
// //                  //     wsClient.send(messageBuffer);
// //                  // }
// //             } else {
// //                 console.error(`[Handler:${clientIp}] Error processing message from OpenAI:`, error);
// //                 console.error(`[Handler:${clientIp}] Original OpenAI message content:`, messageBuffer.toString());
// //             }
// //         }
// //     });

// //     wsOpenAI.on('error', (error) => {
// //         if (clientClosed) return;
// //         console.error(`[Handler:${clientIp}] OpenAI WebSocket Error:`, error);
// //         conversationLog.push({ timestamp: Date.now(), type: 'openai_ws_error', message: error.message });
// //         safeCloseClient(wsClient, 1011, 'OpenAI connection error');
// //         safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
// //     });

// //     wsOpenAI.on('close', (code, reason) => {
// //         // Avoid duplicate actions if already closed by error/session end
// //         if (!openAIConnected && wsOpenAI === null) return;

// //         const reasonString = reason ? reason.toString() : 'N/A';
// //         console.log(`[Handler:${clientIp}] OpenAI WebSocket closed: Code=${code}, Reason=${reasonString}`);
// //         conversationLog.push({ timestamp: Date.now(), type: 'openai_closed', code, reason: reasonString });
// //         safeCloseClient(wsClient, 1000, `OpenAI session ended (${code})`);
// //         openAIConnected = false;
// //         wsOpenAI = null;
// //     });

// //     // --- Handle Frontend Client WebSocket Events ---
// //     wsClient.on('message', (message) => {
// //         // --- DEBUG LOG ---
// //         console.log(`[Handler:${clientIp}] Received message from client. Type: ${typeof message}, IsBuffer: ${Buffer.isBuffer(message)}, Length: ${message?.length}`);
// //         // --- END DEBUG LOG ---
// //         if (clientClosed) return;

// //         // Expecting raw audio binary data (Buffer) from the client
// //         if (Buffer.isBuffer(message)) {
// //             if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
// //                 // console.log(`[Handler:${clientIp}] Received client audio chunk (${message.length} bytes)`); // Verbose

// //                 // --- FORWARD AUDIO TO OPENAI ---
// //                 // Encode the raw PCM buffer to Base64
// //                 const base64Audio = message.toString('base64');
// //                 const appendEvent = {
// //                     type: 'input_audio_buffer.append',
// //                     audio: base64Audio,
// //                     // event_id: `audio_chunk_${Date.now()}` // Optional: Add event ID for tracing
// //                 };

// //                 try {
// //                     wsOpenAI.send(JSON.stringify(appendEvent));
// //                     // Log user audio for context (optional, can be large)
// //                     // conversationLog.push({ timestamp: Date.now(), type: 'user_audio_chunk', size: message.length });
// //                 } catch (error) {
// //                     console.error(`[Handler:${clientIp}] Error sending audio chunk to OpenAI:`, error);
// //                     // Handle potential backpressure or errors
// //                 }
// //             } else {
// //                 console.warn(`[Handler:${clientIp}] Received client audio, but OpenAI WebSocket is not ready.`);
// //             }
// //         } else if (typeof message === 'string') {
// //             // Handle potential control messages from client if needed
// //             try {
// //                 const controlMsg = JSON.parse(message.toString());
// //                  console.log(`[Handler:${clientIp}] Received control message from client:`, controlMsg);
// //                  // Example: Client explicitly sending text input
// //                  if (controlMsg.type === 'clientText' && controlMsg.text) {
// //                      console.log(`[Handler:${clientIp}] User Text: ${controlMsg.text}`);
// //                      conversationLog.push({ timestamp: Date.now(), type: 'user_text', text: controlMsg.text });

// //                      if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
// //                         // Create a conversation item for the text
// //                         const textItemEvent = {
// //                             type: "conversation.item.create",
// //                             item: {
// //                                 type: "message",
// //                                 role: "user",
// //                                 content: [{ type: "input_text", text: controlMsg.text }]
// //                             }
// //                         };
// //                         wsOpenAI.send(JSON.stringify(textItemEvent));

// //                         // Trigger a response immediately after sending text
// //                         const responseEvent = { type: "response.create" };
// //                          wsOpenAI.send(JSON.stringify(responseEvent));
// //                          console.log(`[Handler:${clientIp}] Sent user text and requested response from OpenAI.`);
// //                      }
// //                  } else {
// //                      console.warn(`[Handler:${clientIp}] Received unknown/unhandled control message:`, controlMsg.type);
// //                  }
// //             } catch(e) {
// //                 console.warn(`[Handler:${clientIp}] Received non-JSON string from client:`, message.toString());
// //             }
// //         } else {
// //             console.warn(`[Handler:${clientIp}] Received unexpected message type from client:`, typeof message);
// //         }
// //     });

// //     wsClient.on('close', (code, reason) => {
// //         if (clientClosed) return;
// //         const reasonString = reason ? reason.toString() : 'N/A';
// //         console.log(`[Handler:${clientIp}] Frontend client disconnected: Code=${code}, Reason=${reasonString}`);
// //         conversationLog.push({ timestamp: Date.now(), type: 'client_disconnected', code, reason: reasonString });
// //         clientClosed = true;
// //         // Close the corresponding OpenAI connection
// //         safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
// //     });

// //     wsClient.on('error', (error) => {
// //         if (clientClosed) return;
// //         console.error(`[Handler:${clientIp}] Frontend client WebSocket Error:`, error);
// //         conversationLog.push({ timestamp: Date.now(), type: 'client_ws_error', message: error.message });
// //         clientClosed = true;
// //         safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
// //     });
// // }

// // // Export the handler function
// // module.exports = {
// //     handleNewClientConnection,
// // };

// // // // openaiHandler.js
// // // const WebSocket = require('ws');
// // // const { OPENAI_CONVERSATIONS_CONFIG, OPENAI_API_KEY } = require('./config');

// // // // Handle new WebSocket client connections
// // // function handleNewClientConnection(wsClient) {
// // //     console.log('[OpenAI Handler] New client connected. Initiating OpenAI connection...');

// // //     let wsOpenAI = null;
// // //     let clientClosed = false;
// // //     let openAIClosed = false;
// // //     let sendEndOfStreamNext = false; // Flag to mark the next audio chunk as the last

// // //     // --- Establish WebSocket connection to OpenAI ---
// // //     try {
// // //         const headers = {
// // //             "Authorization": `Bearer ${OPENAI_API_KEY}`,
// // //             "OpenAI-Beta": "realtime=v1",
// // //         };

// // //         wsOpenAI = new WebSocket(OPENAI_CONVERSATIONS_CONFIG.WEBSOCKET_URL, { headers });

// // //         console.log(`[OpenAI Handler] Attempting connection to: ${OPENAI_CONVERSATIONS_CONFIG.WEBSOCKET_URL}`);
// // //     } catch (error) {
// // //         console.error('[OpenAI Handler] Error creating OpenAI WebSocket:', error);
// // //         safeCloseClient(wsClient, 1011, 'Failed to connect to OpenAI');
// // //         return;
// // //     }

// // //     function safeCloseClient(client, code, reason) {
// // //         if (client && client.readyState === WebSocket.OPEN) {
// // //             console.log(`[OpenAI Handler] Closing client connection: ${code} - ${reason}`);
// // //             client.close(code, reason);
// // //         }
// // //         clientClosed = true;
// // //     }

// // //     function safeCloseOpenAI(openaiWs, code, reason) {
// // //         if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
// // //             console.log(`[OpenAI Handler] Closing OpenAI connection: ${code} - ${reason}`);
// // //             openaiWs.close(code, reason);
// // //         }
// // //         openAIClosed = true;
// // //         wsOpenAI = null;
// // //     }

// // //     // --- Handle OpenAI WebSocket Events ---
// // //     wsOpenAI.on('open', () => {
// // //         if (clientClosed) {
// // //             console.log('[OpenAI Handler] Client disconnected before OpenAI connection opened.');
// // //             safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
// // //             return;
// // //         }
// // //         console.log('[OpenAI Handler] Connected to OpenAI Realtime Conversations API.');
// // //         if (wsClient.readyState === WebSocket.OPEN) {
// // //             wsClient.send(JSON.stringify({ type: 'system', message: 'AI connection ready.' }));
// // //         }
// // //     });

// // //     wsOpenAI.on('message', (message) => {
// // //         if (clientClosed || openAIClosed) return;

// // //         try {
// // //             const data = JSON.parse(message.toString());

// // //             switch (data.type) {
// // //                 case 'transcription':
// // //                     if (data.transcription?.text) {
// // //                         const { text, role = 'assistant', final = false } = data.transcription;
// // //                         console.log(`Transcript (${role}${final ? ' - Final' : ''}): ${text}`);
// // //                         if (wsClient.readyState === WebSocket.OPEN) {
// // //                             wsClient.send(JSON.stringify({ type: 'transcript', text, role, final }));
// // //                         }
// // //                     }
// // //                     break;

// // //                 case 'audio_output':
// // //                     if (data.audio) {
// // //                         const base64Audio = data.audio;
// // //                         const audioBuffer = Buffer.from(base64Audio, 'base64');
// // //                         if (wsClient.readyState === WebSocket.OPEN) {
// // //                             wsClient.send(audioBuffer);
// // //                         }
// // //                     }
// // //                     break;

// // //                 case 'error':
// // //                     console.error('[OpenAI Handler] Error from OpenAI:', data.message || data.error || 'Unknown error format');
// // //                     const errorMsg = data.message || data.error || 'Unknown OpenAI error';
// // //                     safeCloseClient(wsClient, 1011, `OpenAI Error: ${errorMsg}`);
// // //                     safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errorMsg}`);
// // //                     break;

// // //                 case 'close':
// // //                     console.log('[OpenAI Handler] OpenAI initiated connection close.');
// // //                     safeCloseClient(wsClient, 1000, 'OpenAI connection closed');
// // //                     openAIClosed = true;
// // //                     wsOpenAI = null;
// // //                     break;

// // //                 default:
// // //                     console.warn(`[OpenAI Handler] Received unknown/unhandled message type from OpenAI: ${data.type}`, data);
// // //             }
// // //         } catch (error) {
// // //             console.error('[OpenAI Handler] Error processing message from OpenAI:', error);
// // //             console.error('[OpenAI Handler] Original OpenAI message:', message.toString());
// // //         }
// // //     });

// // //     wsOpenAI.on('error', (error) => {
// // //         if (clientClosed || openAIClosed) return;
// // //         console.error('[OpenAI Handler] OpenAI WebSocket Error:', error);
// // //         safeCloseClient(wsClient, 1011, 'OpenAI connection error');
// // //         safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
// // //     });

// // //     wsOpenAI.on('close', (code, reason) => {
// // //         if (openAIClosed) return;
// // //         console.log(`[OpenAI Handler] OpenAI WebSocket closed: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
// // //         safeCloseClient(wsClient, 1000, 'OpenAI session ended');
// // //         openAIClosed = true;
// // //         wsOpenAI = null;
// // //     });

// // //     // --- Handle Frontend Client WebSocket Events ---
// // //     wsClient.on('message', (message) => {
// // //         if (clientClosed || openAIClosed) return;

// // //         if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
// // //             if (Buffer.isBuffer(message)) {
// // //                 const base64Audio = message.toString('base64');
// // //                 try {
// // //                     const audioMessage = { type: "audio_input", audio: base64Audio };
// // //                     if (sendEndOfStreamNext) {
// // //                         audioMessage.end_of_stream = true;
// // //                         console.log("[OpenAI Handler] Sending final audio chunk with end_of_stream=true");
// // //                         sendEndOfStreamNext = false;
// // //                     }
// // //                     wsOpenAI.send(JSON.stringify(audioMessage));
// // //                 } catch (error) {
// // //                     console.error('[OpenAI Handler] Error sending audio chunk to OpenAI:', error);
// // //                 }
// // //             } else if (typeof message === 'string') {
// // //                  try {
// // //                     const controlMsg = JSON.parse(message);
// // //                     console.log("[OpenAI Handler] Received control message from client:", controlMsg);
// // //                     if (controlMsg.type === 'EndOfUserAudio') {
// // //                         console.log("[OpenAI Handler] Client signaled end of audio.");
// // //                         sendEndOfStreamNext = true;
// // //                     } else {
// // //                          console.warn("[OpenAI Handler] Received unknown control message type:", controlMsg.type);
// // //                     }
// // //                  } catch (e) {
// // //                     console.warn("[OpenAI Handler] Received non-JSON string from client:", message.toString());
// // //                  }
// // //             }
// // //         }
// // //     });

// // //     wsClient.on('close', (code, reason) => {
// // //         if (clientClosed) return;
// // //         console.log(`[OpenAI Handler] Frontend client disconnected: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
// // //         clientClosed = true;
// // //         if (wsOpenAI && !openAIClosed) {
// // //             console.log('[OpenAI Handler] Closing associated OpenAI WebSocket connection due to client disconnect.');
// // //             safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
// // //         }
// // //     });

// // //     wsClient.on('error', (error) => {
// // //         if (clientClosed) return;
// // //         console.error('[OpenAI Handler] Frontend client WebSocket Error:', error);
// // //         clientClosed = true;
// // //         if (wsOpenAI && !openAIClosed) {
// // //             safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
// // //         }
// // //     });
// // // }

// // // module.exports = {
// // //     handleNewClientConnection,
// // // };



// // // // // openaiHandler.js
// // // // const WebSocket = require('ws');
// // // // // Import the specific config object and the API key
// // // // const { OPENAI_CONVERSATIONS_CONFIG, OPENAI_API_KEY } = require('./config');

// // // // /**
// // // //  * Handles a new WebSocket client connection, bridging it to the OpenAI Realtime Conversations API.
// // // //  * @param {WebSocket} wsClient The WebSocket connection from the frontend client.
// // // //  */
// // // // function handleNewClientConnection(wsClient) {
// // // //     console.log('[OpenAI Handler] New client connected. Initiating OpenAI connection...');

// // // //     let wsOpenAI = null;
// // // //     let clientClosed = false;
// // // //     let openAIClosed = false;
// // // //     let sendEndOfStreamNext = false; // Flag to mark the next audio chunk as the last

// // // //     // --- Establish WebSocket connection to OpenAI ---
// // // //     try {
// // // //         const headers = {
// // // //             "Authorization": `Bearer ${OPENAI_API_KEY}`,
// // // //             // "Accept": OPENAI_CONVERSATIONS_CONFIG.OUTPUT_ACCEPT, // Specify desired output format
// // // //             "OpenAI-Beta": "realtime=v1",
// // // //         };
// // // //         // Use the fully constructed URL from config
// // // //         wsOpenAI = new WebSocket(OPENAI_CONVERSATIONS_CONFIG.WEBSOCKET_URL, { headers });
// // // //         console.log(`[OpenAI Handler] Attempting connection to: ${OPENAI_CONVERSATIONS_CONFIG.WEBSOCKET_URL}`);
// // // //     } catch (error) {
// // // //         console.error('[OpenAI Handler] Error creating OpenAI WebSocket:', error);
// // // //         safeCloseClient(wsClient, 1011, 'Failed to connect to OpenAI');
// // // //         return;
// // // //     }

// // // //     // --- Utility Functions for safe closing ---
// // // //     function safeCloseClient(client, code, reason) {
// // // //         if (client && client.readyState === WebSocket.OPEN) {
// // // //             console.log(`[OpenAI Handler] Closing client connection: ${code} - ${reason}`);
// // // //             client.close(code, reason);
// // // //         }
// // // //         clientClosed = true;
// // // //     }

// // // //     function safeCloseOpenAI(openaiWs, code, reason) {
// // // //         if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
// // // //              console.log(`[OpenAI Handler] Closing OpenAI connection: ${code} - ${reason}`);
// // // //             openaiWs.close(code, reason);
// // // //         }
// // // //         openAIClosed = true;
// // // //         wsOpenAI = null;
// // // //     }


// // // //     // --- Handle OpenAI WebSocket Events ---
// // // //     wsOpenAI.on('open', () => {
// // // //         if (clientClosed) {
// // // //             console.log('[OpenAI Handler] Client disconnected before OpenAI connection opened. Closing OpenAI.');
// // // //             safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
// // // //             return;
// // // //         }
// // // //         // ** No config message needed for this API endpoint **
// // // //         console.log('[OpenAI Handler] Connected to OpenAI Realtime Conversations API.');
// // // //         // Inform client connection is fully ready (optional)
// // // //         if (wsClient.readyState === WebSocket.OPEN) {
// // // //              wsClient.send(JSON.stringify({ type: 'system', message: 'AI connection ready.' }));
// // // //         }
// // // //     });

// // // //     wsOpenAI.on('message', (message) => {
// // // //         if (clientClosed || openAIClosed) return;

// // // //         try {
// // // //             const data = JSON.parse(message.toString());

// // // //             switch (data.type) {
// // // //                 case 'transcription': // Note the new type
// // // //                     if (data.transcription?.text) {
// // // //                         const { text, role = 'assistant', final = false } = data.transcription;
// // // //                         // --- CONSOLE LOGGING ---
// // // //                         console.log(`Transcript (${role}${final ? ' - Final' : ''}): ${text}`);
// // // //                         // --- FORWARD TRANSCRIPT TO CLIENT ---
// // // //                         if (wsClient.readyState === WebSocket.OPEN) {
// // // //                             wsClient.send(JSON.stringify({ type: 'transcript', text, role, final }));
// // // //                         }
// // // //                     }
// // // //                     break;

// // // //                 case 'audio_output': // Note the new type
// // // //                     if (data.audio) { // Audio is directly under 'audio' key now
// // // //                         const base64Audio = data.audio;
// // // //                         const audioBuffer = Buffer.from(base64Audio, 'base64');
// // // //                         // Send raw binary audio to the frontend client
// // // //                         if (wsClient.readyState === WebSocket.OPEN) {
// // // //                             wsClient.send(audioBuffer);
// // // //                         }
// // // //                     }
// // // //                     break;

// // // //                 case 'error':
// // // //                     console.error('[OpenAI Handler] Error from OpenAI:', data.message || data.error || 'Unknown error format');
// // // //                     const errorMsg = data.message || data.error || 'Unknown OpenAI error';
// // // //                     safeCloseClient(wsClient, 1011, `OpenAI Error: ${errorMsg}`);
// // // //                     safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errorMsg}`);
// // // //                     break;

// // // //                 // Other potential types from docs (handle if needed)
// // // //                 case 'latency':
// // // //                      console.log("[OpenAI Handler] Latency Info:", data);
// // // //                      break;
// // // //                 case 'features':
// // // //                     console.log("[OpenAI Handler] Features Info:", data);
// // // //                     break;

// // // //                 // Note: 'interaction_status'/'speech_status' might not exist or differ in this API
// // // //                 // Rely on 'close' or explicit 'error' for termination signals.

// // // //                 case 'close': // OpenAI explicitly closes the connection
// // // //                     console.log('[OpenAI Handler] OpenAI initiated connection close.');
// // // //                     safeCloseClient(wsClient, 1000, 'OpenAI connection closed');
// // // //                     openAIClosed = true;
// // // //                     wsOpenAI = null;
// // // //                     break;

// // // //                 default:
// // // //                     console.warn(`[OpenAI Handler] Received unknown/unhandled message type from OpenAI: ${data.type}`, data);
// // // //             }
// // // //         } catch (error) {
// // // //             console.error('[OpenAI Handler] Error processing message from OpenAI:', error);
// // // //             console.error('[OpenAI Handler] Original OpenAI message:', message.toString());
// // // //         }
// // // //     });

// // // //     wsOpenAI.on('error', (error) => {
// // // //         if (clientClosed || openAIClosed) return;
// // // //         console.error('[OpenAI Handler] OpenAI WebSocket Error:', error);
// // // //         safeCloseClient(wsClient, 1011, 'OpenAI connection error');
// // // //         safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
// // // //     });

// // // //     wsOpenAI.on('close', (code, reason) => {
// // // //         if (openAIClosed) return;
// // // //         console.log(`[OpenAI Handler] OpenAI WebSocket closed: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
// // // //         safeCloseClient(wsClient, 1000, 'OpenAI session ended');
// // // //         openAIClosed = true;
// // // //         wsOpenAI = null;
// // // //     });

// // // //     // --- Handle Frontend Client WebSocket Events ---
// // // //     wsClient.on('message', (message) => {
// // // //         if (clientClosed || openAIClosed) return;

// // // //         if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
// // // //             if (Buffer.isBuffer(message)) {
// // // //                 const base64Audio = message.toString('base64');
// // // //                 try {
// // // //                     // Use the 'audio_input' type
// // // //                     const audioMessage = {
// // // //                         type: "audio_input",
// // // //                         audio: base64Audio
// // // //                     };
// // // //                     // Add 'end_of_stream' if flagged by the client
// // // //                     if (sendEndOfStreamNext) {
// // // //                         audioMessage.end_of_stream = true;
// // // //                         console.log("[OpenAI Handler] Sending final audio chunk with end_of_stream=true");
// // // //                         sendEndOfStreamNext = false; // Reset flag after sending
// // // //                     }
// // // //                     wsOpenAI.send(JSON.stringify(audioMessage));
// // // //                 } catch (error) {
// // // //                     console.error('[OpenAI Handler] Error sending audio chunk to OpenAI:', error);
// // // //                 }
// // // //             } else if (typeof message === 'string') {
// // // //                  try {
// // // //                     const controlMsg = JSON.parse(message);
// // // //                     console.log("[OpenAI Handler] Received control message from client:", controlMsg);
// // // //                     // Handle specific control messages
// // // //                     if (controlMsg.type === 'EndOfUserAudio') {
// // // //                         console.log("[OpenAI Handler] Client signaled end of audio. Will mark next chunk.");
// // // //                         // We can't send end_of_stream alone. We flag that the *next* audio chunk
// // // //                         // received should be marked as the last one.
// // // //                         sendEndOfStreamNext = true;
// // // //                     } else {
// // // //                          console.warn("[OpenAI Handler] Received unknown control message type:", controlMsg.type);
// // // //                     }
// // // //                  } catch (e) {
// // // //                     console.warn("[OpenAI Handler] Received non-JSON string from client:", message.toString());
// // // //                  }
// // // //             }
// // // //         } else {
// // // //             console.warn('[OpenAI Handler] Received client message, but OpenAI WebSocket is not ready.');
// // // //         }
// // // //     });

// // // //     wsClient.on('close', (code, reason) => {
// // // //         if (clientClosed) return;
// // // //         console.log(`[OpenAI Handler] Frontend client disconnected: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);
// // // //         clientClosed = true;
// // // //         // Close the corresponding OpenAI connection
// // // //         if (wsOpenAI && !openAIClosed) {
// // // //             console.log('[OpenAI Handler] Closing associated OpenAI WebSocket connection due to client disconnect.');
// // // //             // For this API, sending end_of_stream might have already happened.
// // // //             // Just close the connection.
// // // //             safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
// // // //         }
// // // //     });

// // // //     wsClient.on('error', (error) => {
// // // //         if (clientClosed) return;
// // // //         console.error('[OpenAI Handler] Frontend client WebSocket Error:', error);
// // // //         clientClosed = true;
// // // //         if (wsOpenAI && !openAIClosed) {
// // // //             safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
// // // //         }
// // // //     });
// // // // }

// // // // // Export the handler function
// // // // module.exports = {
// // // //     handleNewClientConnection,
// // // // };