// src/openaiHandler.ts
import WebSocket from 'ws';
import { OPENAI_CONFIG, OPENAI_API_KEY } from './config';
import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';

// --- Interfaces for Array Elements ---
interface ContentPart {
    type: string;
    text?: string;
    transcript?: string;
    [key: string]: any; // Allow other content props
}

interface OutputItem {
    type: string; // 'message', etc.
    role?: string;
    content?: ContentPart[];
    [key: string]: any; // Allow other output props
}

// --- Interfaces for OpenAI Messages ---
interface OpenAIMessageBase {
    type: string;
    event_id?: string;
}

interface SessionEvent extends OpenAIMessageBase {
    session?: { id?: string; [key: string]: any };
}

interface ResponseEvent extends OpenAIMessageBase {
    response?: {
        id?: string;
        status?: string;
        output?: OutputItem[]; // Use the defined interface
        [key: string]: any;
    };
}

interface AudioDeltaEvent extends ResponseEvent {
    type: 'response.audio.delta';
    delta?: string; // Base64 string
}

interface TextDeltaEvent extends ResponseEvent {
    type: 'response.text.delta';
    delta?: string;
}

interface ErrorEvent extends OpenAIMessageBase {
    type: 'error' | 'invalid_request_error';
    message?: string | { message?: string; [key: string]: any };
    error?: string | { message?: string; code?: string; event_id?: string; [key: string]: any };
    code?: string;
}

// Union type for all possible messages
type OpenAIMessage = OpenAIMessageBase | SessionEvent | ResponseEvent | AudioDeltaEvent | TextDeltaEvent | ErrorEvent;

// Type for log entries
type LogEntry = {
    timestamp: number;
    type: string;
    [key: string]: any; // Allow flexible properties
};

// Create a directory for saving text files if it doesn't exist
const transcriptsDir = path.join(__dirname, '..', './openai_text_output');
if (!fs.existsSync(transcriptsDir)) {
    try {
        fs.mkdirSync(transcriptsDir, { recursive: true });
        console.log(`[Server] Created directory for saving transcripts: ${transcriptsDir}`);
    } catch (mkdirError) {
        console.error(`[Server] Failed to create directory ${transcriptsDir}:`, mkdirError);
    }
}


// Create a directory for saving audio files if it doesn't exist
const audioSaveDir = path.join(__dirname, '..', 'openai_audio_output');
if (!fs.existsSync(audioSaveDir)){
    try {
        fs.mkdirSync(audioSaveDir, { recursive: true });
        console.log(`[Server] Created directory for saving audio: ${audioSaveDir}`);
    } catch (mkdirError) {
         console.error(`[Server] Failed to create directory ${audioSaveDir}:`, mkdirError);
    }
}

// Simple in-memory log
const conversationLog: LogEntry[] = [];
let currentResponseAudioChunks: Buffer[] = [];
let currentResponseId: string | null = null;

/**
 * Handles a new WebSocket client connection, bridging it to the OpenAI Realtime API.
 * @param wsClient The WebSocket connection from the frontend client.
 * @param clientIp The IP address of the client for logging.
 */
function handleNewClientConnection(wsClient: WebSocket, clientIp: string | undefined): void {
    const logPrefix = `[Handler:${clientIp || 'UnknownIP'}]`;
    console.log(`${logPrefix} New client connected. Initiating OpenAI connection...`);

    let wsOpenAI: WebSocket | null = null;
    let clientClosed: boolean = false;
    let openAIConnected: boolean = false;
    let openAISessionId: string | null = null;
    let turnInProgress: boolean = false;

    conversationLog.push({ timestamp: Date.now(), type: 'connect', ip: clientIp });

    // --- Establish WebSocket connection to OpenAI ---
    try {
        const headers: { [key: string]: string } = {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
        };
        wsOpenAI = new WebSocket(OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL, { headers });
        console.log(`${logPrefix} Attempting connection to OpenAI: ${OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL}`);
    } catch (error: any) {
        console.error(`${logPrefix} Error creating OpenAI WebSocket:`, error);
        safeCloseClient(wsClient, 1011, 'Failed to initiate OpenAI connection');
        return;
    }

    // --- Utility Functions ---
    function safeCloseClient(client: WebSocket | null, code: number, reason: string): void {
        if (client && client.readyState === WebSocket.OPEN) {
            console.log(`${logPrefix} Closing client connection: ${code} - ${reason}`);
            try {
                client.close(code, reason);
            } catch (closeError) {
                console.error(`${logPrefix} Error closing client WS:`, closeError);
            }
        }
        clientClosed = true;
    }

    function safeCloseOpenAI(openaiWs: WebSocket | null, code: number, reason: string): void {
        if (openaiWs && (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)) {
             console.log(`${logPrefix} Closing OpenAI connection: ${code} - ${reason}`);
            try {
                openaiWs.close(code, reason);
            } catch (closeError) {
                console.error(`${logPrefix} Error closing OpenAI WS:`, closeError);
            }
        }
        openAIConnected = false;
        wsOpenAI = null;
    }

    // --- Handle OpenAI WebSocket Events ---
    wsOpenAI.on('open', () => {
        if (clientClosed) {
            console.log(`${logPrefix} Client disconnected before OpenAI connection opened. Closing OpenAI.`);
            safeCloseOpenAI(wsOpenAI, 1000, "Client disconnected during OpenAI connect");
            return;
        }
        openAIConnected = true;
        console.log(`${logPrefix} Connected to OpenAI Realtime API.`);

        const sessionUpdateEvent = {
            type: "session.update",
            session: {
                instructions: "You are a helpful voice assistant. Respond ONLY in English.",
                output_audio_format: "pcm16",
                input_audio_format: "pcm16",
                turn_detection: { type: "server_vad" },
                 voice: "shimmer",
            },
            event_id: `session_config_${Date.now()}`
        };

        try {
             if (wsOpenAI && wsOpenAI.readyState === WebSocket.OPEN) {
                wsOpenAI.send(JSON.stringify(sessionUpdateEvent));
                console.log(`${logPrefix} Sent session configuration to OpenAI (pcm16 in/out, server_vad, English only, shimmer voice).`);
             }
        } catch(e: any) {
            console.error(`${logPrefix} Error sending session config:`, e);
            safeCloseClient(wsClient, 1011, 'Failed to configure OpenAI session');
            safeCloseOpenAI(wsOpenAI, 1011, 'Failed to send session config');
        }
    });

    wsOpenAI.on('message', (messageBuffer: Buffer) => {
        if (clientClosed || !openAIConnected || !wsOpenAI) return;

        try {
            const messageString = messageBuffer.toString('utf8');
            // Parse first, then use the type in the switch
            const parsedData: any = JSON.parse(messageString); // Parse as 'any' initially
            const data = parsedData as OpenAIMessage; // Then cast to the union type

            switch (data.type) {
                case 'session.created': { // Use block scope for typed variable
                    const sessionCreatedEvent = data as SessionEvent; // Explicit cast
                    openAISessionId = sessionCreatedEvent.session?.id ?? null;
                    console.log(`${logPrefix} OpenAI session created: ${openAISessionId}`);
                    conversationLog.push({ timestamp: Date.now(), type: 'session_created', sessionId: openAISessionId });
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AIConnected', sessionId: openAISessionId }));
                    }
                    break;
                }
                case 'session.updated': {
                    const sessionUpdatedEvent = data as SessionEvent; // Explicit cast
                    console.log(`${logPrefix} OpenAI session updated.`, sessionUpdatedEvent.session);
                    break;
                }
                case 'session.closed':
                    console.log(`${logPrefix} OpenAI session closed by server.`);
                    conversationLog.push({ timestamp: Date.now(), type: 'openai_closed_by_server' });
                    safeCloseClient(wsClient, 1000, 'OpenAI session closed');
                    safeCloseOpenAI(wsOpenAI, 1000, 'Session closed by server');
                    break;

                case 'response.created': {
                    const responseCreatedEvent = data as ResponseEvent; // Explicit cast
                    console.log(`${logPrefix} OpenAI response generation started. Response ID: ${responseCreatedEvent.response?.id}`);
                    turnInProgress = true;
                    currentResponseId = responseCreatedEvent.response?.id || `resp_${Date.now()}`;
                    currentResponseAudioChunks = [];
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseStart' }));
                    }
                    break;
                }
                case 'response.audio.delta': {
                    const audioDeltaEvent = data as AudioDeltaEvent;
                    if (audioDeltaEvent.delta) {
                        const audioBuffer = Buffer.from(audioDeltaEvent.delta, 'base64');
                        console.log(`${logPrefix} Received OpenAI audio chunk (PCM16): ${audioBuffer.length} bytes`);
                        if (currentResponseId) {
                             currentResponseAudioChunks.push(audioBuffer);
                        } else {
                             console.warn(`${logPrefix} Received audio delta but no current response ID.`);
                        }
                        if (wsClient.readyState === WebSocket.OPEN) {
                            wsClient.send(audioBuffer);
                        }
                    }
                    break;
                }
                 case 'response.text.delta': {
                    const textDeltaEvent = data as TextDeltaEvent;
                    if (textDeltaEvent.delta) {
                         if (wsClient.readyState === WebSocket.OPEN) {
                            wsClient.send(JSON.stringify({ type: 'textDelta', text: textDeltaEvent.delta }));
                         }
                    }
                    break;
                 }
                case 'response.audio_transcript.delta': break;

                case 'response.done': {
                    const responseDoneEvent = data as ResponseEvent; // Explicit cast
                    console.log(`${logPrefix} OpenAI response generation finished. Status: ${responseDoneEvent.response?.status}`);
                    turnInProgress = false;

                    const responseIdToSave = currentResponseId || `resp_done_${Date.now()}`;
                    if (currentResponseAudioChunks.length > 0) {
                        try {
                            const concatenatedBackendBuffer = Buffer.concat(currentResponseAudioChunks);
                            const filename = path.join(audioSaveDir, `${responseIdToSave}_backend.raw`);
                            fs.writeFile(filename, concatenatedBackendBuffer, (err: NodeJS.ErrnoException | null) => {
                                if (err) {
                                    console.error(`${logPrefix} Error saving backend audio file ${filename}:`, err);
                                } else {
                                    console.log(`${logPrefix} Saved backend audio to ${filename} (${concatenatedBackendBuffer.length} bytes)`);
                                }
                            });
                        } catch (concatError: any) {
                            console.error(`${logPrefix} Error concatenating audio chunks for saving:`, concatError);
                        }
                    } else {
                        console.log(`${logPrefix} No audio chunks received for response ${responseIdToSave} to save.`);
                    }

                    currentResponseAudioChunks = [];
                    currentResponseId = null;

                    let finalAssistantText: string = '';
                    // Use explicit typing in find callbacks
                    const outputMessage = responseDoneEvent.response?.output?.find((o: OutputItem) => o.type === 'message');
                    if (outputMessage?.content) {
                        const textPart = outputMessage.content.find((part: ContentPart) => part.type === 'output_text');
                        if (textPart?.text) {
                            finalAssistantText = textPart.text;
                        } else {
                            const audioPart = outputMessage.content.find((part: ContentPart) => part.type === 'audio' && part.transcript);
                            if (audioPart?.transcript) {
                                finalAssistantText = audioPart.transcript;
                            }
                        }
                    }

                    if (finalAssistantText) {
                        console.log(`${logPrefix} Extracted Final Assistant Text: ${finalAssistantText}`);
                        conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: finalAssistantText });

                        // Create a timestamp for the filename
                        const now = new Date();
                        const timestamp = now.toISOString().replace(/:/g, '-').replace(/\..+/, ''); // Format: YYYY-MM-DDThh-mm-ss

                        // Save the transcript (to a file or logging service)
                        const transcriptFilePath = path.join(__dirname, '..', './openai_text_output', `${timestamp}_${responseIdToSave}_transcript.txt`);
                        fs.writeFile(transcriptFilePath, finalAssistantText, (err: NodeJS.ErrnoException | null) => {
                            if (err) {
                                console.error(`${logPrefix} Error saving transcript file ${transcriptFilePath}:`, err);
                            } else {
                                console.log(`${logPrefix} Saved transcript to ${transcriptFilePath}`);
                            }
                        });
                    } else {
                        console.warn(`${logPrefix} Could not extract final assistant text from response.done event.`);
                        conversationLog.push({ timestamp: Date.now(), type: 'assistant_text', text: '[No text extracted]' });
                    }
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AIResponseEnd', finalText: finalAssistantText }));
                    }
                    break;
                }
                case 'input_audio_buffer.speech_started':
                    console.log(`${logPrefix} OpenAI detected speech start.`);
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechDetected' }));
                    }
                    break;
                 case 'input_audio_buffer.speech_stopped':
                    console.log(`${logPrefix} OpenAI detected speech stop.`);
                     if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({ type: 'event', name: 'AISpeechEnded' }));
                    }
                    break;

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
                     break;

                 case 'error':
                 case 'invalid_request_error': {
                    const errorEvent = data as ErrorEvent;
                    console.error(`${logPrefix} RAW Error Data from OpenAI:`, JSON.stringify(errorEvent, null, 2));

                    let errMsg = 'Unknown OpenAI error';
                    const msgProp = errorEvent.message || errorEvent.error;
                    if (typeof msgProp === 'string') {
                        errMsg = msgProp;
                    } else if (typeof msgProp === 'object' && msgProp !== null && typeof msgProp.message === 'string') {
                        errMsg = msgProp.message;
                    } else {
                        errMsg = JSON.stringify(msgProp || errorEvent);
                    }
                    const errCode = errorEvent.code || (typeof errorEvent.error === 'object' ? errorEvent.error?.code : undefined) || 'UnknownCode';
                    const errEventId = errorEvent.event_id || (typeof errorEvent.error === 'object' ? errorEvent.error?.event_id : undefined) || 'N/A';

                    console.error(`${logPrefix} Parsed Error from OpenAI: Code=${errCode}, Message='${errMsg}', ClientEventID=${errEventId}`);
                    conversationLog.push({ timestamp: Date.now(), type: 'openai_error', code: errCode, message: errMsg, rawData: errorEvent });
                    safeCloseClient(wsClient, 1011, `OpenAI Error: ${errMsg.substring(0, 100)}`);
                    safeCloseOpenAI(wsOpenAI, 1011, `Reported error: ${errMsg.substring(0, 100)}`);
                    break;
                 }
                default:
                    // Use a type assertion to access 'type' if needed, or handle unknown
                    const unknownData = data as any;
                    console.warn(`${logPrefix} Received unhandled message type from OpenAI: ${unknownData.type}`, unknownData);
            }
        } catch (error: any) {
             if (messageBuffer instanceof Buffer && messageBuffer.length > 0) {
                 console.warn(`${logPrefix} Received non-JSON message from OpenAI (length ${messageBuffer.length}). Assuming audio delta?`);
                 const audioBuffer = messageBuffer;
                 console.log(`${logPrefix} Assuming non-JSON is audio chunk (PCM16): ${audioBuffer.length} bytes`);
                 if (currentResponseId) { currentResponseAudioChunks.push(audioBuffer); }
                 else { console.warn(`${logPrefix} Received assumed audio delta but no current response ID.`); }
                 if (wsClient.readyState === WebSocket.OPEN) { wsClient.send(audioBuffer); }
             } else {
                console.error(`${logPrefix} Error processing message from OpenAI:`, error);
                console.error(`${logPrefix} Original OpenAI message content:`, messageBuffer.toString('utf8'));
            }
        }
    });

    // --- OpenAI Error/Close Handlers ---
    wsOpenAI.on('error', (error: Error) => {
        if (clientClosed || !wsOpenAI) return;
        console.error(`${logPrefix} OpenAI WebSocket Error:`, error);
        conversationLog.push({ timestamp: Date.now(), type: 'openai_ws_error', message: error.message });
        safeCloseClient(wsClient, 1011, 'OpenAI connection error');
        safeCloseOpenAI(wsOpenAI, 1011, 'WebSocket error');
    });

    wsOpenAI.on('close', (code: number, reason: Buffer) => {
        if (!openAIConnected && wsOpenAI === null) {
             return;
        }
        const reasonString = reason.toString('utf8');
        console.log(`${logPrefix} OpenAI WebSocket closed: Code=${code}, Reason=${reasonString}`);
        conversationLog.push({ timestamp: Date.now(), type: 'openai_closed', code, reason: reasonString });
        safeCloseClient(wsClient, 1000, `OpenAI session ended (${code})`);
        openAIConnected = false;
        wsOpenAI = null;
    });

    // --- Handle Frontend Client WebSocket Events ---
    wsClient.on('message', (message: WebSocket.RawData, isBinary: boolean) => {
        if (clientClosed || !wsOpenAI || wsOpenAI.readyState !== WebSocket.OPEN) {
             if (!wsOpenAI || wsOpenAI.readyState !== WebSocket.OPEN) {
                 console.warn(`${logPrefix} Received client message, but OpenAI WebSocket is not ready or null.`);
             }
             return;
        }

        if (isBinary) {
            const audioChunk: Buffer = Buffer.isBuffer(message)
                ? message
                : Buffer.from(message as ArrayBuffer);

            const base64Audio = audioChunk.toString('base64');
            const appendEvent = { type: 'input_audio_buffer.append', audio: base64Audio };
            try {
                wsOpenAI.send(JSON.stringify(appendEvent));
                conversationLog.push({ timestamp: Date.now(), type: 'user_audio_chunk_sent', size: audioChunk.length });
            } catch (error: any) {
                 console.error(`${logPrefix} Error sending audio chunk to OpenAI:`, error);
            }
        } else if (typeof message === 'string' || message instanceof Buffer) {
             const messageString = message.toString();
            try {
                const controlMsg = JSON.parse(messageString);
                 console.log(`${logPrefix} Received control message from client:`, controlMsg);
                 // TODO: Handle control messages
            } catch(e: any) {
                console.warn(`${logPrefix} Received non-JSON string/buffer from client:`, messageString);
            }
        } else {
            console.warn(`${logPrefix} Received unexpected message type from client:`, typeof message);
        }
    });

    wsClient.on('close', (code: number, reason: Buffer) => {
        if (clientClosed) return;
        const reasonString = reason.toString('utf8');
        console.log(`${logPrefix} Frontend client disconnected: Code=${code}, Reason=${reasonString}`);
        conversationLog.push({ timestamp: Date.now(), type: 'client_disconnected', code, reason: reasonString });
        clientClosed = true;
        safeCloseOpenAI(wsOpenAI, 1000, 'Client disconnected');
    });

    wsClient.on('error', (error: Error) => {
        if (clientClosed) return;
        console.error(`${logPrefix} Frontend client WebSocket Error:`, error);
        conversationLog.push({ timestamp: Date.now(), type: 'client_ws_error', message: error.message });
        clientClosed = true;
        safeCloseOpenAI(wsOpenAI, 1011, 'Client connection error');
    });
}

// Export using CommonJS style
export = {
    handleNewClientConnection,
};