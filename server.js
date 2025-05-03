require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { toFile } = require('openai'); // Import toFile helper
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// --- OpenAI Client Initialization ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const modelId = process.env.OPENAI_MODEL_ID || 'gpt-4o'; // Or your preferred model

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'client/build')));

// --- In-memory store for conversation state ---
let lastResponseId = null; // Store the ID of the last response for context
let lastGeneratedImageBase64 = null; // Store the base64 of the last generated image

// --- Instructions for the model ---
const baseInstructions = process.env.OPENAI_INSTRUCTIONS || "You are an AI assistant specialized in image generation and editing. Your primary function is to help users create and modify images. When users ask for images, provide detailed, creative prompts that will result in high-quality images. When users want to edit images, understand their requests clearly and provide specific modification instructions.";
const imageGenInstructions = `If the user asks you to generate a *new* image, reply *only* with the text "IMAGE_PROMPT: " followed by a detailed, creative description of the image they want. Include specific details about style, mood, lighting, and composition. Do not add any other text before or after. Example: User: 'make a picture of a cat'. You: 'IMAGE_PROMPT: a photorealistic cat sitting on a windowsill, soft morning light, detailed fur texture, shallow depth of field, warm color palette'.`;
const imageEditInstructions = `If the user asks to *edit or modify the previously generated image*, reply *only* with the text "IMAGE_EDIT_PROMPT: " followed by a clear, specific description of the *changes* desired. Include details about what should be changed and how. Do not add any other text. Example: User: 'make the cat blue'. You: 'IMAGE_EDIT_PROMPT: change the cat's fur color to a vibrant blue while maintaining the photorealistic texture and lighting'.`;
const imageAnalyzeInstructions = `If the user asks a question *about the previously generated/edited image* (e.g., 'what is this?', 'describe it'), reply *only* with the text "IMAGE_ANALYZE_PROMPT: " followed by the user's question about the image. Do not add any other text. Example: User: 'what color is the ball?'. You: 'IMAGE_ANALYZE_PROMPT: what color is the ball?'.`;
const combinedInstructions = `${baseInstructions}\n\n${imageGenInstructions}\n\n${imageEditInstructions}\n\n${imageAnalyzeInstructions}\n
For any non-image related requests, respond normally but keep responses concise.`;

// --- Function Definitions ---
const tools = [
    {
        type: "function",
        name: "generate_image",
        description: "Generate a new image based on a detailed description.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Detailed description of the image to generate, including style, mood, lighting, and composition"
                }
            },
            required: ["prompt"],
            additionalProperties: false
        },
        strict: true
    },
    {
        type: "function",
        name: "edit_image",
        description: "Edit the previously generated image with specific modifications.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Clear description of the changes to make to the image"
                }
            },
            required: ["prompt"],
            additionalProperties: false
        },
        strict: true
    },
    {
        type: "function",
        name: "analyze_image",
        description: "Analyze the previously generated/edited image to answer questions about it.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "Question to ask about the image"
                }
            },
            required: ["question"],
            additionalProperties: false
        },
        strict: true
    }
];

// --- API Routes ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY is not set in .env file' });
    }
    if (!message) {
        return res.status(400).json({ error: 'Message content is required' });
    }

    try {
        // --- Call OpenAI with function definitions ---
        const response = await openai.responses.create({
            model: modelId,
            input: [{ role: "user", content: message }],
            tools,
            previous_response_id: lastResponseId
        });

        const responseData = response;
        const currentResponseId = responseData?.id;
        let assistantText = null;
        let imageBase64 = null;

        // Initialize the input for the next API call
        let conversationInput = [{ role: "user", content: message }];

        // Extract the first assistant message (which might contain tool calls)
        const firstAssistantMessage = responseData.output?.find(item => item.type === 'message' && item.role === 'assistant');
        if (firstAssistantMessage) {
            conversationInput.push(firstAssistantMessage); // Add assistant's turn
        }

        // --- Process function calls (if any) ---
        const toolCalls = responseData.output?.filter(item => item.type === "function_call") || [];

        if (toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                const name = toolCall.name;
                const args = JSON.parse(toolCall.arguments);

                let result;
                switch (name) {
                    case "generate_image":
                        const imageResponse = await openai.images.generate({
                            model: "gpt-image-1",
                            prompt: args.prompt,
                            quality: "medium",
                            n: 1,
                            size: "1024x1024"
                        });
                        imageBase64 = imageResponse.data[0].b64_json;
                        lastGeneratedImageBase64 = imageBase64;
                        result = "Image generated successfully";
                        break;

                    case "edit_image":
                        if (!lastGeneratedImageBase64) {
                            result = "No previous image found to edit. Please generate one first.";
                            break;
                        }
                        const imageBuffer = Buffer.from(lastGeneratedImageBase64, 'base64');
                        const imageInput = await toFile(imageBuffer, 'image_to_edit.png', { type: 'image/png' });
                        const editResponse = await openai.images.edit({
                            model: "gpt-image-1",
                            image: imageInput,
                            quality: "medium",
                            prompt: args.prompt,
                            n: 1,
                            size: "1024x1024"
                        });
                        imageBase64 = editResponse.data[0].b64_json;
                        lastGeneratedImageBase64 = imageBase64;
                        result = "Image edited successfully";
                        break;

                    case "analyze_image":
                        if (!lastGeneratedImageBase64) {
                            result = "No image available to analyze. Please generate or edit one first.";
                            break;
                        }
                        const visionInput = [{
                            role: "user",
                            content: [
                                { type: "input_text", text: args.question },
                                {
                                    type: "input_image",
                                    image_url: `data:image/png;base64,${lastGeneratedImageBase64}`
                                }
                            ]
                        }];
                        const visionResponse = await openai.responses.create({
                            model: modelId,
                            input: visionInput
                        });
                        result = visionResponse.output_text || "Could not analyze the image.";
                        break;
                }

                // Add tool result to the conversation input array
                conversationInput.push({
                    role: "tool",
                    tool_call_id: toolCall.id, // Use 'id' from the toolCall object
                    content: result.toString() // Use 'content' for the result
                });
            }
        }

        // Get final response incorporating function results
        const finalResponse = await openai.responses.create({
            model: modelId,
            input: conversationInput, // Use the correctly built input array
            tools,
            store: true // Keep store: true if you need stateful responses via ID
        });

        // Extract final assistant text from the potentially new response structure
        const finalAssistantMessage = finalResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
        assistantText = finalAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't generate a response.";

        lastResponseId = finalResponse.id; // Update lastResponseId with the ID of the *final* response

        // --- Send Response to Client ---
        res.json({
            assistantResponse: assistantText,
            imageBase64: imageBase64
        });

    } catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });
        lastResponseId = null;
        lastGeneratedImageBase64 = null;
    }
});

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    console.log(`Using model: ${modelId}`);
    // Optional: Check for API key presence on startup
    if (!process.env.OPENAI_API_KEY) {
        console.warn('WARN: OPENAI_API_KEY is not set in the .env file.');
    }
});