const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const FormData = require('form-data');

// Retrieve credentials securely from environment variables
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GEMINI_KEY ||
  process.env.GOOGLE_API_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Define tools for Gemini Function Calling
const tools = [
  {
    functionDeclarations: [
      {
        name: 'generateImage',
        description:
          'Generates an image based on a prompt using Google Imagen 3.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: {
              type: 'STRING',
              description: 'Detailed description of the image to generate.',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'generateVideo',
        description:
          'Generates a video based on a prompt using Google Veo.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: {
              type: 'STRING',
              description: 'Detailed description of the video to generate.',
            },
          },
          required: ['prompt'],
        },
      },
    ],
  },
];

async function sendTelegramMessage(chatId, text, botToken) {
  const token = botToken || TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  }).catch(async (err) => {
    // Retry without Markdown if parsing fails
    await axios.post(url, {
      chat_id: chatId,
      text: text,
    }).catch(() => {});
  });
}

async function sendTelegramPhoto(chatId, imageBuffer, caption, botToken) {
  const token = botToken || TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', imageBuffer, { filename: 'image.png' });
  if (caption) {
    form.append('caption', caption);
  }
  await axios.post(url, form, {
    headers: form.getHeaders(),
  });
}

async function sendTelegramVideo(chatId, videoUrl, caption, botToken) {
  const token = botToken || TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendVideo`;
  await axios.post(url, {
    chat_id: chatId,
    video: videoUrl,
    caption: caption || '',
  }).catch(async () => {
    // If sending video URL directly via sendVideo fails, fallback to sendMessage with link
    await sendTelegramMessage(
      chatId,
      `Video generated! You can view/download it here: ${videoUrl}`,
      token
    );
  });
}

async function handleGenerateImage(prompt, chatId, botToken) {
  try {
    await sendTelegramMessage(chatId, '🎨 Generating image with Imagen 3...', botToken);
    const response = await ai.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: 'image/png',
      },
    });

    const generatedImage = response.generatedImages && response.generatedImages[0];
    if (generatedImage && generatedImage.image && generatedImage.image.imageBytes) {
      const imageBuffer = Buffer.from(generatedImage.image.imageBytes, 'base64');
      await sendTelegramPhoto(chatId, imageBuffer, `Prompt: ${prompt}`, botToken);
    } else {
      await sendTelegramMessage(chatId, 'Failed to generate image.', botToken);
    }
  } catch (err) {
    console.error('Image generation error:', err);
    await sendTelegramMessage(chatId, `Error generating image: ${err.message}`, botToken);
  }
}

async function handleGenerateVideo(prompt, chatId, botToken) {
  try {
    await sendTelegramMessage(
      chatId,
      '🎬 Generating video with Google Veo. This may take a few moments...',
      botToken
    );

    let operation = await ai.models.generateVideos({
      model: 'veo-2.0-generate-001',
      prompt: prompt,
      config: {
        aspectRatio: '16:9',
      },
    });

    // Poll operation until complete
    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      operation = await ai.operations.getVideosOperation({
        operation: operation,
      });
    }

    if (operation.error) {
      await sendTelegramMessage(chatId, `Video generation failed: ${operation.error.message}`, botToken);
      return;
    }

    const generatedVideo =
      operation.response &&
      operation.response.generatedVideos &&
      operation.response.generatedVideos[0];

    const videoUri = generatedVideo && generatedVideo.video && generatedVideo.video.uri;

    if (videoUri) {
      await sendTelegramVideo(chatId, videoUri, `Prompt: ${prompt}`, botToken);
    } else {
      await sendTelegramMessage(chatId, 'Video generation complete, but video URL was not found.', botToken);
    }
  } catch (err) {
    console.error('Video generation error:', err);
    await sendTelegramMessage(chatId, `Error generating video: ${err.message}`, botToken);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Telegram Webhook active' });
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).json({ status: 'No message in update' });
  }

  const chatId = update.message.chat.id;
  const userText = update.message.text;

  if (!userText) {
    return res.status(200).json({ status: 'Non-text message received' });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userText,
      config: {
        tools: tools,
      },
    });

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      for (const call of functionCalls) {
        if (call.name === 'generateImage') {
          await handleGenerateImage(call.args.prompt, chatId);
        } else if (call.name === 'generateVideo') {
          await handleGenerateVideo(call.args.prompt, chatId);
        }
      }
    } else {
      const replyText = response.text || 'Maaf, saya tidak dapat memproses permintaan Anda.';
      await sendTelegramMessage(chatId, replyText);
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Handler error:', err);
    await sendTelegramMessage(chatId, `Terjadi kesalahan: ${err.message}`);
    return res.status(200).json({ status: 'error', message: err.message });
  }
};
