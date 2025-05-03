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
const baseInstructions = process.env.OPENAI_INSTRUCTIONS || "You are a helpful assistant.";
const imageGenInstructions = `If the user asks you to generate a *new* image, reply *only* with the text "IMAGE_PROMPT: " followed by a detailed description of the image they want. Do not add any other text before or after. Example: User: 'make a picture of a cat'. You: 'IMAGE_PROMPT: a cat'.`;
const imageEditInstructions = `If the user asks to *edit or modify the previously generated image*, reply *only* with the text "IMAGE_EDIT_PROMPT: " followed by a description of the *changes* desired. Do not add any other text. Example: User: 'make the cat blue'. You: 'IMAGE_EDIT_PROMPT: make the cat blue'.`;
const imageAnalyzeInstructions = `If the user asks a question *about the previously generated/edited image* (e.g., 'what is this?', 'describe it'), reply *only* with the text "IMAGE_ANALYZE_PROMPT: " followed by the user's question about the image. Do not add any other text. Example: User: 'what color is the ball?'. You: 'IMAGE_ANALYZE_PROMPT: what color is the ball?'.`;
const combinedInstructions = `${baseInstructions}\n\n${imageGenInstructions}\n\n${imageEditInstructions}\n\n${imageAnalyzeInstructions}\n
Respond normally to other requests.`;

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
        // --- Call the /v1/responses endpoint using the dedicated method ---
        console.log(`Sending to /v1/responses: input='${message}', previous_response_id='${lastResponseId}'`);
        const response = await openai.responses.create({
            input: message,
            model: modelId,
            previous_response_id: lastResponseId,
            instructions: combinedInstructions, // Use combined instructions
            // store: true, // Default: store response for context (unless you want stateless)
        });

        // --- Process the response ---
        const responseData = response;
        const currentResponseId = responseData?.id;
        let assistantText = "Sorry, I couldn't get a response.";
        let imageBase64 = null; // Variable to hold image data

        // Extract text output using the observed structure
        if (responseData?.output_text) {
            assistantText = responseData.output_text;
        } else if (
            Array.isArray(responseData?.output) &&
            responseData.output[0]?.type === 'message' &&
            Array.isArray(responseData.output[0]?.content) &&
            responseData.output[0].content[0]?.type === 'output_text' &&
            responseData.output[0].content[0]?.text
        ) {
            assistantText = responseData.output[0].content[0].text;
        }

        console.log(`Received response text: '${assistantText.substring(0, 100)}...'`);

        // --- Check for Image Edit Signal FIRST ---
        const imageEditPromptPrefix = "IMAGE_EDIT_PROMPT: ";
        const imageGenPromptPrefix = "IMAGE_PROMPT: ";
        const imageAnalyzePromptPrefix = "IMAGE_ANALYZE_PROMPT: "; // New prefix

        if (assistantText.startsWith(imageEditPromptPrefix)) {
            const editPrompt = assistantText.substring(imageEditPromptPrefix.length).trim();
            console.log(`Detected image edit request. Prompt: "${editPrompt}"`);

            if (!lastGeneratedImageBase64) {
                console.log("No previous image found to edit.");
                assistantText = "You asked to edit an image, but I don't have a previous image stored. Please generate one first.";
                // Keep currentResponseId to update lastResponseId for this text response
            } else if (!editPrompt) {
                 console.log("Edit prompt is empty.");
                 assistantText = "You asked to edit the image, but didn't specify the changes. What should I do?";
                 // Keep currentResponseId
            } else {
                try {
                    console.log("Preparing image data for editing...");
                    const imageBuffer = Buffer.from(lastGeneratedImageBase64, 'base64');
                    // Use a consistent filename, it doesn't matter much as it's in memory
                    // Explicitly set the MIME type in the options object
                    const imageInput = await toFile(imageBuffer, 'image_to_edit.png', { type: 'image/png' });

                    console.log("Calling OpenAI Image Edit API...");
                    const editResponse = await openai.images.edit({
                        model: "gpt-image-1",
                        image: imageInput, // Pass the prepared image file object
                        prompt: editPrompt,
                        n: 1,
                        size: "1024x1024" // Keep size consistent for now
                    });

                    console.log("Image edit successful.");
                    imageBase64 = editResponse.data[0].b64_json;
                    lastGeneratedImageBase64 = imageBase64; // Update the stored image to the *edited* version
                    assistantText = null; // Clear the prompt text
                    console.log("Image edited, updating lastResponseId and last image.");
                    // Update context to this successful response
                    if (currentResponseId) lastResponseId = currentResponseId;
                    else {
                        console.log("Warning: No currentResponseId after successful edit?");
                        lastResponseId = null; // Fallback reset if ID missing
                    }

                } catch (editError) {
                    console.error("Error calling OpenAI Image Edit API:", editError);
                    assistantText = `Sorry, I encountered an error trying to edit the image: ${editError.message}`;
                    // Keep currentResponseId, don't reset last image on edit failure
                    console.log("Image edit failed, keeping lastResponseId.");
                    if (currentResponseId) lastResponseId = currentResponseId;
                }
            }
        // --- Check for Image Generation Signal (if not edit) ---
        } else if (assistantText.startsWith(imageGenPromptPrefix)) {
            const imagePrompt = assistantText.substring(imageGenPromptPrefix.length).trim();
            console.log(`Detected image generation request. Prompt: "${imagePrompt}"`);

            if (imagePrompt) {
                try {
                    console.log("Calling OpenAI Image Generation API...");
                    const imageResponse = await openai.images.generate({
                        model: "gpt-image-1",
                        prompt: imagePrompt,
                        n: 1,
                        size: "1024x1024"
                    });
                    console.log("Image generation successful.");
                    imageBase64 = imageResponse.data[0].b64_json;
                    lastGeneratedImageBase64 = imageBase64; // Store the newly generated image
                    assistantText = null; // Clear the prompt text
                    console.log("Image generated, updating lastResponseId and last image.");
                    // Update context to this successful response
                    if (currentResponseId) lastResponseId = currentResponseId;
                    else {
                        console.log("Warning: No currentResponseId after successful generation?");
                        lastResponseId = null; // Fallback reset if ID missing
                    }

                } catch (imageError) {
                    console.error("Error calling OpenAI Image Generation API:", imageError);
                    assistantText = `Sorry, I encountered an error trying to generate the image: ${imageError.message}`;
                    // Keep currentResponseId, don't update last image on generation failure
                    console.log("Image generation failed, keeping lastResponseId.");
                    if (currentResponseId) lastResponseId = currentResponseId;
                }
            } else {
                assistantText = "It seems you wanted an image, but didn't provide a description. What should I generate?";
                // Keep currentResponseId
                console.log("Image generation prompt empty, keeping lastResponseId.");
                if (currentResponseId) lastResponseId = currentResponseId;
            }
        // --- Check for Image Analysis Signal (if not edit or generate) ---
        } else if (assistantText.startsWith(imageAnalyzePromptPrefix)) {
            const analyzeQuery = assistantText.substring(imageAnalyzePromptPrefix.length).trim();
            console.log(`Detected image analysis request. Query: "${analyzeQuery}"`);

            if (!lastGeneratedImageBase64) {
                console.log("No previous image found to analyze.");
                assistantText = "You asked me to analyze an image, but I don't have one stored. Please generate or edit one first.";
                // Keep currentResponseId for this text response
                if (currentResponseId) lastResponseId = currentResponseId;
                 else lastResponseId = null;
            } else if (!analyzeQuery) {
                 console.log("Analysis query is empty.");
                 assistantText = "You asked me to analyze the image, but didn't specify what to look for. What should I analyze?";
                 // Keep currentResponseId
                 if (currentResponseId) lastResponseId = currentResponseId;
                 else lastResponseId = null;
            } else {
                try {
                    console.log("Preparing vision API call...");
                    const visionInput = [{
                        role: "user",
                        content: [
                            { type: "input_text", text: analyzeQuery },
                            {
                                type: "input_image",
                                // Format as Base64 data URL
                                image_url: `data:image/png;base64,${lastGeneratedImageBase64}`,
                                // detail: "auto" // Optional: Or 'low'/'high'
                            },
                        ],
                    }];

                    console.log(`Calling OpenAI Responses API for vision analysis with model: ${modelId}...`);
                    // Make a separate call specifically for vision
                    const visionResponse = await openai.responses.create({
                        model: modelId, // Use the primary model (needs vision capability)
                        input: visionInput,
                        // No previous_response_id or instructions needed here
                    });

                    // Extract the analysis text
                    let analysisText = "";
                    if (visionResponse?.output_text) {
                       analysisText = visionResponse.output_text;
                    } else if (visionResponse?.choices?.[0]?.message?.content) {
                       analysisText = visionResponse.choices[0].message.content;
                    } else {
                       console.warn("Could not extract text from vision response.", visionResponse);
                       analysisText = "Sorry, I analyzed the image but couldn't form a text response.";
                    }

                    console.log("Vision analysis successful.");
                    assistantText = analysisText; // Set the main response text to the analysis result
                    imageBase64 = null; // This response is text, not an image

                    // IMPORTANT: Keep the lastResponseId from the *previous* step (the one that gave the ANALYZE signal)
                    // This is handled by the logic below, which uses currentResponseId
                    console.log(`Vision analysis complete, keeping lastResponseId from signal step: ${currentResponseId}`);
                     if (currentResponseId) lastResponseId = currentResponseId;
                     else {
                        console.log("Warning: No currentResponseId after analyze signal?");
                        lastResponseId = null; // Fallback reset
                     }
                     // Don't modify lastGeneratedImageBase64 here, keep it for potential future edits/analysis

                } catch (analysisError) {
                    console.error("Error calling OpenAI Vision API:", analysisError);
                    assistantText = `Sorry, I encountered an error trying to analyze the image: ${analysisError.message}`;
                    // Keep lastResponseId from the signal step
                    console.log("Vision analysis failed, keeping lastResponseId from signal step.");
                     if (currentResponseId) lastResponseId = currentResponseId;
                     else lastResponseId = null;
                }
            }
        }

        // --- Update conversation state (only if it was a pure text response or specific error) ---
        // This part is now handled within the if/else if blocks for image/edit logic
        // We only update lastResponseId for pure text responses or specific error cases
        if (assistantText && !imageBase64) { // If we ended up with only text
            if (currentResponseId) {
                console.log(`Updating lastResponseId for text/error response: ${currentResponseId}`);
                lastResponseId = currentResponseId;
            } else {
                console.log("No currentResponseId available for text/error, resetting lastResponseId.");
                lastResponseId = null; // Reset if ID missing
            }
            // Don't reset lastGeneratedImageBase64 for normal text flow
        } else if (!assistantText && !imageBase64) {
            // If we somehow end up with neither text nor image (shouldn't happen with current logic)
            console.log("No text or image generated, resetting lastResponseId.");
            lastResponseId = null;
        }
        // State updates for successful image gen/edit are handled inside their blocks
        // State update for successful analysis is handled above


        // --- Send Response to Client ---
        res.json({
            assistantResponse: assistantText,
            imageBase64: imageBase64 // Send image data if available
        });

    } catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });
        // Reset context on general error
        lastResponseId = null;
        lastGeneratedImageBase64 = null; // Also reset last image on general error
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