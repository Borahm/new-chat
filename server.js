require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Import OpenAI client and config
const { openai, modelId, baseInstructions } = require('./openaiClient');
// Import tools and handlers
const { tools, handleGenerateImage, handleEditImage, handleAnalyzeImage } = require('./toolHandlers');

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'client/build')));

// --- In-memory store for conversation state ---
let lastResponseId = null; // Store the ID of the last response for context
let lastGeneratedImageBase64 = null; // Store the base64 of the last generated image

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
        const response = await openai.responses.create({ 
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
            const finalResponse = await openai.responses.create({ 
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
    console.log(`Using model: ${modelId}`); // Keep this log, now using imported modelId
});