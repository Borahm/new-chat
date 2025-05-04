const { openai, modelId, baseInstructions } = require('./openaiClient');
const { tools, handleGenerateImage, handleEditImage, handleAnalyzeImage } = require('./toolHandlers');

// --- In-memory store for conversation state --- (Now managed within this controller)
let lastResponseId = null;
let lastGeneratedImageBase64 = null;

// --- Chat Request Handler Logic ---
async function handleChatRequest(req, res) {
    const { message } = req.body;

    if (!process.env.OPENAI_API_KEY) { // Keep check here or rely on openaiClient's warning
        return res.status(500).json({ error: 'OPENAI_API_KEY is not set in .env file' });
    }
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const initialInput = [
        { role: "user", content: message }
    ];

    console.log(`Handling chat request. Input: ${JSON.stringify(initialInput, null, 2)}, Instructions: '${baseInstructions}', Prev Img State: ${!!lastGeneratedImageBase64}`);

    let finalImageBase64 = null; // Reset image for this request
    let assistantText = "Sorry, I encountered an issue."; // Default response

    try {
        // --- Call OpenAI Responses API (First Call) ---
        const response = await openai.responses.create({
            model: modelId,
            input: initialInput,
            instructions: baseInstructions,
            tools: tools,
            store: true // Store state for potential tool calls
        });

        console.log("Received initial response from API:", JSON.stringify(response, null, 2));
        const responseData = response; // Assuming response is the direct data
        const currentResponseId = response.id;

        let conversationInput = [...initialInput];

        // Check if the model wants to call a tool
        const toolCalls = responseData.output?.filter(item => item.type === "function_call") || [];

        if (toolCalls.length > 0) {
            console.log(`Found ${toolCalls.length} tool call(s).`);

            // Process tool calls and collect results
            for (const toolCall of toolCalls) {
                conversationInput.push(toolCall); // Add function_call object

                const functionName = toolCall.name;
                let functionArgs;
                try {
                    functionArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
                } catch (parseError) {
                    console.error(`Error parsing arguments for tool ${functionName}:`, parseError);
                    conversationInput.push({
                        type: "function_call_output",
                        call_id: toolCall.call_id,
                        output: `Error: Invalid arguments format for ${functionName}.`
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
                        // Pass the last known image state to the handler
                        toolResultData = await handleEditImage(functionArgs, lastGeneratedImageBase64);
                        break;
                    case "analyze_image":
                        // Pass the last known image state to the handler
                        toolResultData = await handleAnalyzeImage(functionArgs, lastGeneratedImageBase64);
                        break;
                    default:
                        console.warn(`Unknown tool call: ${functionName}`);
                        toolResultData = { result: `Unknown tool: ${functionName}`, imageBase64: null };
                }

                // Capture the image data if the tool returned any and update state
                if (toolResultData.imageBase64) {
                    finalImageBase64 = toolResultData.imageBase64; // Image for *this* response
                    lastGeneratedImageBase64 = finalImageBase64; // Update persistent state
                }

                // Add the tool result to the conversation history for the NEXT call
                conversationInput.push({
                    type: "function_call_output",
                    call_id: toolCall.call_id,
                    output: toolResultData.result
                });
            } // End of tool call loop

            // --- Make the SECOND API call with tool results ---
            console.log(`Making second API call. Input: ${JSON.stringify(conversationInput, null, 2)}, Instructions: '${baseInstructions}'`);
            const finalResponse = await openai.responses.create({
                model: modelId,
                input: conversationInput,
                instructions: baseInstructions,
                tools: tools,
                store: true
            });

            console.log("Received final response from API after tool execution:", JSON.stringify(finalResponse, null, 2));

            const finalAssistantMessage = finalResponse.output?.find(item => item.type === 'message' && item.role === 'assistant');
            assistantText = finalAssistantMessage?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't process the results of the tool call.";
            lastResponseId = finalResponse.id; // Update state

        } else {
            // No tool calls, just a regular text response from the first call
            const firstAssistantMessageOnly = responseData.output?.find(item => item.type === 'message' && item.role === 'assistant');
            assistantText = firstAssistantMessageOnly?.content?.find(c => c.type === 'output_text')?.text || "Sorry, I couldn't generate a response.";
            lastResponseId = currentResponseId; // Update state
        }

        // --- Send Response to Client ---
        console.log(`Sending final response to client. Image included: ${!!finalImageBase64}`);
        res.json({
            assistantResponse: assistantText,
            imageBase64: finalImageBase64 // Send image if generated/edited during this turn
        });

    } catch (error) {
        console.error('Error processing chat message:', error);
        // Ensure state isn't corrupted on error, maybe clear lastResponseId?
        // lastResponseId = null;
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });
    }
}

module.exports = {
    handleChatRequest
};
