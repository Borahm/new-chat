require('dotenv').config();
const OpenAI = require('openai');

// --- OpenAI Client Initialization ---
if (!process.env.OPENAI_API_KEY) {
    console.warn('WARN: OPENAI_API_KEY is not set in the .env file.');
    // Optionally throw an error or exit if the key is absolutely required to start
    // throw new Error('FATAL: OPENAI_API_KEY is not set.');
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const modelId = process.env.OPENAI_MODEL_ID || 'gpt-4o';
const baseInstructions = process.env.OPENAI_INSTRUCTIONS || "You are an AI assistant specialized in image generation, editing, and analysis using provided tools. Help users create, modify, and understand images based on their requests.";

module.exports = {
    openai,
    modelId,
    baseInstructions
};
