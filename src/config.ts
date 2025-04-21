// src/config.ts
import dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

const PORT: number = parseInt(process.env.PORT || '8080', 10); // Ensure PORT is a number
const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;

// --- Validation ---
if (!OPENAI_API_KEY) {
    console.error("\nFATAL ERROR: OPENAI_API_KEY environment variable is not set.");
    console.error("Please create a .env file in the backend directory and add your OpenAI API key.");
    process.exit(1); // Exit the application if the key is missing
}

// --- Interfaces for Configuration ---
interface AudioFormat {
    codec: string;
    sample_rate: number;
    container?: string; // Optional for output
    encoding?: string; // Optional for input (like 'pcm_s16le')
}

interface OpenAIConfigBase {
    MODEL: string;
    BASE_URL: string;
    OUTPUT_AUDIO_FORMAT: AudioFormat;
    INPUT_AUDIO_FORMAT: AudioFormat;
}

interface FinalOpenAIConfig extends OpenAIConfigBase {
    WEBSOCKET_URL_WITH_MODEL: string;
}

// --- OpenAI Realtime API Configuration (Based on NEW Docs) ---
// Define the base config using the interface (excluding the derived URL for now)
const OPENAI_CONFIG_BASE: OpenAIConfigBase = {
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
const WEBSOCKET_URL_WITH_MODEL: string = `${OPENAI_CONFIG_BASE.BASE_URL}?model=${OPENAI_CONFIG_BASE.MODEL}`;

// Combine base config and derived URL into the final config object
const OPENAI_CONFIG: FinalOpenAIConfig = {
    ...OPENAI_CONFIG_BASE,
    WEBSOCKET_URL_WITH_MODEL,
};

// Prepare the object for export (using CommonJS style for compatibility with original structure)
const config = {
    PORT,
    OPENAI_API_KEY: OPENAI_API_KEY as string, // Assert as string after the check above
    OPENAI_CONFIG,
};

console.log("Backend Configuration loaded successfully.");
console.log(` > OpenAI Model: ${OPENAI_CONFIG.MODEL}`);
console.log(` > OpenAI Connection URL: ${OPENAI_CONFIG.WEBSOCKET_URL_WITH_MODEL}`);
console.log(` > Expected Input Format: ${JSON.stringify(OPENAI_CONFIG.INPUT_AUDIO_FORMAT)}`);
console.log(` > Requested Output Format: ${JSON.stringify(OPENAI_CONFIG.OUTPUT_AUDIO_FORMAT)}`);

// Use `export =` for CommonJS compatibility when the entire file represents the exported module
export = config;