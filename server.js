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
let lastResponseId = null; // Store the ID of the last response for context - (Note: ID handling might need adjustment for chat completions)
let lastGeneratedImageBase64 = null; // Store the base64 of the last generated image

// --- Instructions for the model ---
const baseInstructions = process.env.OPENAI_INSTRUCTIONS || "You are an AI assistant specialized in image generation, editing, and analysis using provided tools. Help users create, modify, and understand images based on their requests.";

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
                    description: "Detailed description of the image to generate. Should include style, mood, lighting, composition etc."
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
        description: "Edit the previously generated image based on instructions.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Clear instructions on how to edit the previous image."
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
        description: "Analyze the previously generated image and answer a question about it.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The question to ask about the previous image."
                }
            },
            required: ["question"],
            additionalProperties: false
        },
        strict: true
    }
];

// --- Helper Functions for Tool Execution ---

async function handleGenerateImage(args) {
    console.log("Executing tool 'generate_image' with args:", args);
    try {
        const imageResponse = await openai.images.generate({
            model: "gpt-image-1", // Use specified model
            prompt: args.prompt,
            n: 1,
            size: "1024x1024"
            // response_format: "b64_json", // Removed as per user request
        });
        // Log the full response to see its structure
        console.log("Image Response from API:", JSON.stringify(imageResponse, null, 2));

        // Corrected extraction path based on documentation
        const imageBase64 = imageResponse.data[0].b64_json; 
        console.log("Tool 'generate_image' executed successfully.");
        return { result: "Image generated successfully.", imageBase64: imageBase64 };
    } catch (error) {
        console.error("Error generating image:", error);
        return { result: "Error generating image.", imageBase64: null };
    }
}

async function handleEditImage(args, currentImageBase64) {
    console.log("Executing tool 'edit_image' with args:", args);
    if (!currentImageBase64) {
        console.warn("Edit requested but no image available.");
        return { result: "No image available to edit.", imageBase64: null };
    }
    try {
        const imageBuffer = Buffer.from(currentImageBase64, 'base64');
        // Use toFile to create a file-like object from the buffer, explicitly setting the type
        const imageFile = await toFile(imageBuffer, 'image.png', { type: 'image/png' });

        const editResponse = await openai.images.edit({
            model: "gpt-image-1", // Use specified model
            image: imageFile,
            prompt: args.prompt,
            n: 1,
            size: "1024x1024"
        });
        // Corrected extraction path based on documentation
        const imageBase64 = editResponse.data[0].b64_json;
        console.log("Tool 'edit_image' executed successfully.");
        return { result: "Image edited successfully.", imageBase64: imageBase64 };
    } catch (error) {
        console.error("Error editing image:", error);
        // Log specific API error details if available
        if (error.response) {
            console.error('API Error Data:', error.response.data);
            console.error('API Error Status:', error.response.status);
            console.error('API Error Headers:', error.response.headers);
        }
        return { result: `Error editing image: ${error.message}`, imageBase64: null };
    }
}

async function handleAnalyzeImage(args, currentImageBase64) {
    console.log("Executing tool 'analyze_image' with args:", args);
    if (!currentImageBase64) {
        console.warn("Analysis requested but no image available.");
        return { result: "No image available to analyze.", imageBase64: null };
    }

    const visionInput = [{
        role: "user",
        content: [
            {
                type: "output_text",
                text: args.question // The user's question about the image
            },
            {
                type: "input_image",
                image_url: `data:image/png;base64,${currentImageBase64}`
            }
        ]
    }];

    try {
        // Use the main chat model (which supports vision) for analysis
        const visionResponse = await openai.responses.create({ // Revert to responses.create
            model: modelId, // Use the main chat model ID (e.g., gpt-4o)
            input: visionInput, // Use input parameter
        });

        // Extract the text result from the vision call's output array
        const visionAssistantMessage = visionResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
        const analysisText = visionAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Could not analyze the image.";
        console.log("Tool 'analyze_image' executed successfully.");
        return { result: analysisText, imageBase64: null }; // Analysis returns text, not a new image
    } catch (visionError) {
        console.error('Error during vision analysis API call:', visionError);
        return { result: `Error analyzing image: ${visionError.message}`, imageBase64: null };
    }
}

// --- API Routes ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY is not set in .env file' });
    }
    if (!message) {
        return res.status(400).json({ error: 'Message content is required' });
    }

    // Prepare input for responses.create API - Just the user message
    const initialInput = [
        { role: "user", content: message }
    ];

    console.log(`Making initial API call. Input: ${JSON.stringify(initialInput, null, 2)}, Instructions: '${baseInstructions}', PrevID: ${lastResponseId}`);

    try {
        // --- Call OpenAI Responses API ---
        const response = await openai.responses.create({ // Revert to responses.create
            model: modelId,
            input: initialInput, // Use input param without system message
            instructions: baseInstructions, // Use dedicated instructions parameter
            tools: tools, // Keep corrected tool structure
            previous_response_id: lastResponseId, // Use API state management
            store: true // Use API state management'
        });

        console.log("Received response from API:", JSON.stringify(response, null, 2));

        // --- Process Response ---
        const responseData = response;
        const currentResponseId = responseData?.id;
        let assistantText = "";
        let finalImageBase64 = null; // Image to send back in *this* response

        // Prepare input for potential second call - start with initial input
        let conversationInput = [...initialInput];

        // Check if the model wants to call a tool - parse from output array
        const toolCalls = responseData.output?.filter(item => item.type === "function_call") || [];

        if (toolCalls.length > 0) {
            console.log(`Found ${toolCalls.length} tool call(s).`);

            // Process tool calls and collect results
            for (const toolCall of toolCalls) {
                // First, add the function_call object itself to the input, as required by the API
                conversationInput.push(toolCall);

                const functionName = toolCall.name;
                let functionArgs;
                try {
                    functionArgs = JSON.parse(toolCall.arguments);
                } catch (e) {
                    console.error(`Error parsing arguments for tool ${functionName}:`, toolCall.arguments, e);
                    // Add error result to history - matching the call_id of the toolCall we just pushed
                    conversationInput.push({
                        type: "function_call_output",
                        call_id: toolCall.call_id,
                        output: `Error parsing arguments: ${e.message}`
                    });
                    continue; // Skip to next tool call
                }

                let toolResultData; // { result: string, imageBase64: string | null }

                // Execute the corresponding function
                switch (functionName) {
                    case "generate_image":
                        toolResultData = await handleGenerateImage(functionArgs);
                        break;
                    case "edit_image":
                        // Pass the last generated image for editing context
                        toolResultData = await handleEditImage(functionArgs, lastGeneratedImageBase64);
                        break;
                    case "analyze_image":
                        // Pass the last generated image for analysis context
                        toolResultData = await handleAnalyzeImage(functionArgs, lastGeneratedImageBase64);
                        break;
                    default:
                        console.warn(`Unknown tool call: ${functionName}`);
                        toolResultData = { result: `Unknown tool: ${functionName}`, imageBase64: null };
                }

                // Capture the image data if the tool returned any
                if (toolResultData.imageBase64) {
                    finalImageBase64 = toolResultData.imageBase64; // Assign to the variable used in the final response
                    lastGeneratedImageBase64 = finalImageBase64; // Update state for potential future edits/analysis
                }

                // Add the tool result to the conversation history for the NEXT call
                conversationInput.push({
                    type: "function_call_output", // Format for responses API
                    call_id: toolCall.call_id, // Use call_id from the toolCall we pushed earlier
                    output: toolResultData.result // Use output
                });
            } // End of tool call loop

            // --- Make the SECOND API call with tool results --- 
            // The input now contains: user message, function_call(s), function_call_output(s)
            console.log(`Making second API call. Input: ${JSON.stringify(conversationInput, null, 2)}, Instructions: '${baseInstructions}'`);
            const finalResponse = await openai.responses.create({ // Revert to responses.create
                model: modelId,
                input: conversationInput, // Send accumulated input
                instructions: baseInstructions, // Provide instructions again
                tools: tools, // Provide tools definition again
                store: true // Ensure state is stored for potential future turns
            });

            console.log("Received final response from API after tool execution:", JSON.stringify(finalResponse, null, 2));

            // Extract final assistant text from this second response's output array
            const finalAssistantMessage = finalResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
            assistantText = finalAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't process the results of the tool call.";
            lastResponseId = finalResponse.id; // Update state with the ID of the *final* response

        } else {
            // No tool calls, just a regular text response from the first call
            // Extract text from the first response's output array
            const firstAssistantMessageOnly = responseData.output?.find(item => item.type === 'message' && item.role === 'assistant');
            assistantText = firstAssistantMessageOnly?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't generate a response.";
            lastResponseId = currentResponseId; // Update state with the ID of this direct response
        }

        // --- Send Response to Client ---
        console.log(`Sending final response to client. Image included: ${!!finalImageBase64}`);
        res.json({
            assistantResponse: assistantText,
            imageBase64: finalImageBase64 // Send image if generated/edited during this turn
        });

    } catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });

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