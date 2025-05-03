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

        // Initialize the input array for the *next* API call
        let conversationInput = [{ role: "user", content: message }];

        // Add the assistant's first response message (which contains the tool_calls) to the input
        const toolCalls = responseData.output?.filter(item => item.type === "function_call") || [];
        const firstAssistantMessage = responseData.output?.find(item => item.type === 'message' && item.role === 'assistant');

        if (toolCalls.length > 0) {
            // Tool calls exist, process them
            for (const toolCall of toolCalls) {
                const name = toolCall.name;
                const args = JSON.parse(toolCall.arguments);

                // Append the function_call item itself to the input for the next call
                conversationInput.push(toolCall);

                let result; // To store the output of the locally executed function
                switch (name) {
                    case "generate_image":
                        const imageResponse = await openai.images.generate({
                            model: "gpt-image-1", // Use the model specified in docs
                            prompt: args.prompt,
                            n: 1,
                            size: "1024x1024"
                        });
                        // Directly use the base64 data from the response as per docs
                        imageBase64 = imageResponse.data[0].b64_json;
                        if (!imageBase64) {
                            throw new Error("Image generation response did not contain b64_json data.");
                        }
                        lastGeneratedImageBase64 = imageBase64;
                        console.log("Tool 'generate_image' executed.");
                        result = "Image generated successfully."; // Set result for function_call_output
                        break;

                    case "edit_image":
                        if (!lastGeneratedImageBase64) {
                            console.warn("Edit requested but no image available.");
                            result = "Error: No previous image found to edit.";
                            break;
                        }
                        const imageBuffer = Buffer.from(lastGeneratedImageBase64, 'base64');
                        const imageInput = await toFile(imageBuffer, 'image_to_edit.png', { type: 'image/png' });
                        const editResponse = await openai.images.edit({
                            model: "gpt-image-1", // Use the same model
                            image: imageBuffer, // Pass the buffer
                            prompt: args.prompt,
                            n: 1,
                            size: "1024x1024"
                        });
                        imageBase64 = editResponse.data[0].b64_json;
                        if (!imageBase64) {
                            throw new Error("Image edit response did not contain b64_json data.");
                        }
                        lastGeneratedImageBase64 = imageBase64;
                        console.log("Tool 'edit_image' executed.");
                        result = "Image edited successfully."; // Set result for function_call_output
                        break;

                    case "analyze_image":
                        if (!lastGeneratedImageBase64) {
                            console.warn("Analysis requested but no image available.");
                            result = "Error: No image available to analyze.";
                            break;
                        }
                        // Execute the analysis by calling the API *internally* as part of the tool execution
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
                        try {
                            const visionResponse = await openai.responses.create({
                                model: modelId, // Use the same model or a dedicated vision model if preferred
                                input: visionInput
                                // Note: No tools, previous_response_id, or store needed for this internal call
                            });
                            // Extract the text result from the vision call's output
                            const visionAssistantMessage = visionResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
                            result = visionAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Could not analyze the image.";
                        } catch (visionError) {
                            console.error('Error during internal vision API call:', visionError);
                            result = "Error analyzing image.";
                        }
                        break;
                }

                // Append the function result message
                conversationInput.push({
                    type: "function_call_output",
                    call_id: toolCall.call_id, // Use call_id from the function_call item
                    output: result.toString()
                });
            }

            // Make the SECOND API call, providing the full accumulated input
            console.log("Making second API call with accumulated input:", JSON.stringify(conversationInput, null, 2));
            const finalResponse = await openai.responses.create({
                model: modelId,
                input: conversationInput, // Provide the full history including function calls and results
                tools, // Provide tools definition again
                store: true // Ensure state is stored for potential future turns
            });

            // Extract final assistant text from this second response
            const finalAssistantMessage = finalResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
            assistantText = finalAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't finalize the response after tool use.";

            lastResponseId = finalResponse.id; // Update state with the ID of the *final* response

            // --- Send Response to Client ---
            res.json({
                assistantResponse: assistantText,
                imageBase64: imageBase64 // Send image if generated/edited during this turn
            });
        } else {
            // No tool calls in the first response, extract text and send
            assistantText = firstAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't generate a response.";
            lastResponseId = currentResponseId; // Update state with the ID of this direct response
            res.json({ assistantResponse: assistantText, imageBase64: null }); // Send response
        }
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
    if (!process.env.OPENAI_API_KEY) {
        console.warn('WARN: OPENAI_API_KEY is not set in the .env file.');
    }
});