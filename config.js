// config.js
require('dotenv').config(); // Load environment variables from .env file

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Validation ---
if (!OPENAI_API_KEY) {
    console.error("\nFATAL ERROR: OPENAI_API_KEY environment variable is not set.");
    console.error("Please create a .env file in the backend directory and add your OpenAI API key.");
    process.exit(1); // Exit the application if the key is missing
}

// --- OpenAI Realtime API Configuration (Based on NEW Docs) ---
const OPENAI_CONFIG = {
    MODEL: "gpt-4o-mini-realtime-preview-2024-12-17", // Target model
    BASE_URL: "wss://api.openai.com/v1/realtime", // Correct base URL
    // Audio formats can be configured via session.update / response.create events
    // Example format we might request from OpenAI (Opus is efficient)
    OUTPUT_AUDIO_FORMAT: {
        codec: "opus",
        container: "ogg", // Opus often comes in Ogg container
        sample_rate: 24000, // Common Opus rate
    },
    // OUTPUT_AUDIO_FORMAT: {
    //     codec: "pcm16",  // PCM16 encoding for audio output
    //     sample_rate: 16000,  // Ensure sample rate matches
    // },
    // Format we expect from the frontend (PCM16 is raw, easy to handle initially)
    // The frontend must send audio in this format.
    INPUT_AUDIO_FORMAT: {
        codec: "pcm",
        sample_rate: 16000, // Must match frontend capture rate
        encoding: "pcm_s16le", // Signed 16-bit Little Endian PCM
    },
};

// Construct the full URL with the model parameter
const WEBSOCKET_URL_WITH_MODEL = `${OPENAI_CONFIG.BASE_URL}?model=${OPENAI_CONFIG.MODEL}`;

// Export the configuration values
module.exports = {
    PORT,
    OPENAI_API_KEY, // For direct use in headers
    OPENAI_CONFIG: {
        ...OPENAI_CONFIG, // Include base config
        WEBSOCKET_URL_WITH_MODEL, // Add the constructed URL
    },
};

console.log("Backend Configuration loaded successfully.");
console.log(` > OpenAI Model: ${OPENAI_CONFIG.MODEL}`);
console.log(` > OpenAI Connection URL: ${WEBSOCKET_URL_WITH_MODEL}`);
console.log(` > Expected Input Format: ${JSON.stringify(OPENAI_CONFIG.INPUT_AUDIO_FORMAT)}`);
console.log(` > Requested Output Format: ${JSON.stringify(OPENAI_CONFIG.OUTPUT_AUDIO_FORMAT)}`);