const { openai } = require('./openaiClient'); // Import the initialized client
const { toFile } = require('openai'); // Import toFile helper

// --- Tool Definitions ---
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
            model: "gpt-image-1", // Use gpt-image-1 as requested
            prompt: args.prompt,
            n: 1,
            size: "1024x1024",
            quality: "medium",
        });
        console.log("Image Response from API (Generate):", JSON.stringify(imageResponse, null, 2));

        // IMPORTANT: The path to the image data might change without response_format: b64_json
        // Need to inspect the actual response structure from the console log if this fails.
        // Assuming it might be in data[0].url or similar if not b64_json
        const imageBase64 = imageResponse.data[0].b64_json; // Keep this for now, but check logs
        if (!imageBase64) {
            console.warn("No b64_json found in response. Check API response structure. Trying url...");
            const imageUrl = imageResponse.data[0]?.url;
            if (imageUrl) {
                // If we only get a URL, we can't directly send base64 back.
                // For now, we'll return an error message indicating this limitation.
                // A more advanced solution would involve fetching the image from the URL and converting it.
                console.log("Image generated, but only URL provided:", imageUrl);
                return { result: `Image generated, but only URL available: ${imageUrl}`, imageBase64: null };
            }
        }

        console.log("Tool 'generate_image' executed successfully.");
        return { result: "Image generated successfully.", imageBase64: imageBase64 };
    } catch (error) {
        console.error("Error generating image:", error);
        return { result: `Error generating image: ${error.message}`, imageBase64: null };
    }
}

async function handleEditImage(args, currentImageBase64) {
    console.log("Executing tool 'edit_image' with args:", args);
    if (!currentImageBase64) {
        console.warn("Cannot edit image: No previous image found in state.");
        return { result: "Error: No image available to edit. Please generate one first.", imageBase64: null };
    }
    try {
        // Convert base64 string back to a buffer/file-like object for the API
        const imageBuffer = Buffer.from(currentImageBase64, 'base64');
        // Explicitly set the mimetype to 'image/png'
        const imageFile = await toFile(imageBuffer, 'image.png', { type: 'image/png' });

        const editResponse = await openai.images.edit({
            image: imageFile,
            prompt: args.prompt,
            n: 1,
            size: "1024x1024",
            model: "gpt-image-1",
            quality: "medium",
        });

        console.log("Image Response from API (Edit):", JSON.stringify(editResponse, null, 2));
        const editedImageBase64 = editResponse.data[0].b64_json;
        console.log("Tool 'edit_image' executed successfully.");
        return { result: "Image edited successfully.", imageBase64: editedImageBase64 };
    } catch (error) {
        console.error("Error editing image:", error);
        return { result: `Error editing image: ${error.message}`, imageBase64: null }; // Return current image maybe?
    }
}

async function handleAnalyzeImage(args, currentImageBase64) {
    console.log("Executing tool 'analyze_image' with args:", args);
    if (!currentImageBase64) {
        console.warn("Cannot analyze image: No previous image found in state.");
        return { result: "Error: No image available to analyze. Please generate or edit one first.", imageBase64: null };
    }

    try {
        const visionResponse = await openai.chat.completions.create({
            model: "gpt-4o", // Use the current gpt-4o model which supports vision
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: args.question },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/png;base64,${currentImageBase64}`,
                            },
                        },
                    ],
                },
            ],
        });

        console.log("Vision API Response:", JSON.stringify(visionResponse, null, 2));
        const analysisResult = visionResponse.choices[0]?.message?.content || "Could not analyze the image.";
        console.log("Tool 'analyze_image' executed successfully.");
        // Analysis doesn't change the image, so return null for imageBase64
        return { result: analysisResult, imageBase64: null };
    } catch (error) {
        console.error("Error analyzing image:", error);
        return { result: `Error analyzing image: ${error.message}`, imageBase64: null };
    }
}


module.exports = {
    tools,
    handleGenerateImage,
    handleEditImage,
    handleAnalyzeImage
};
