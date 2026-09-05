const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const FormData = require('form-data');

// Clean environment variable values (remove accidental spaces, newlines, or quotes)
function sanitizeApiKey(key) {
  if (!key) return '';
  return key.replace(/\s+/g, '').replace(/^["']|["']$/g, '');
}

const GEMINI_API_KEY = sanitizeApiKey(
  process.env.GEMINI_API_KEY ||
  process.env.GEMINI_KEY ||
  process.env.GOOGLE_API_KEY
);

const JULES_API_KEY = sanitizeApiKey(
  process.env.JULES_API_KEY ||
  GEMINI_API_KEY
);

const TELEGRAM_BOT_TOKEN = sanitizeApiKey(process.env.TELEGRAM_BOT_TOKEN);

// In-memory store for user AI model selection mode (chatId -> 'gemini' | 'jules')
const userModes = new Map();

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
  const token = sanitizeApiKey(botToken || TELEGRAM_BOT_TOKEN);
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
  const token = sanitizeApiKey(botToken || TELEGRAM_BOT_TOKEN);
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
  const token = sanitizeApiKey(botToken || TELEGRAM_BOT_TOKEN);
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

async function handleGenerateImage(prompt, chatId, apiKey, botToken) {
  try {
    const key = sanitizeApiKey(apiKey || GEMINI_API_KEY);
    const ai = new GoogleGenAI({ apiKey: key });
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

async function handleGenerateVideo(prompt, chatId, apiKey, botToken) {
  try {
    const key = sanitizeApiKey(apiKey || GEMINI_API_KEY);
    const ai = new GoogleGenAI({ apiKey: key });
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

  // Command handling for mode switching
  const lowerText = userText.trim().toLowerCase();

  if (lowerText === '/gemini') {
    userModes.set(chatId, 'gemini');
    await sendTelegramMessage(
      chatId,
      '🤖 *Mode AI diubah ke Gemini AI.*\n\nModel: `gemini-3.6-flash` dengan fitur Imagen 3 & Veo enabled.'
    );
    return res.status(200).json({ status: 'ok', mode: 'gemini' });
  }

  if (lowerText === '/jules') {
    userModes.set(chatId, 'jules');
    await sendTelegramMessage(
      chatId,
      '⚡ *Mode AI diubah ke Jules AI.*\n\nPersona: Expert Software Engineer & Coding Assistant.'
    );
    return res.status(200).json({ status: 'ok', mode: 'jules' });
  }

  if (lowerText === '/mode' || lowerText === '/status') {
    const currentMode = userModes.get(chatId) || 'gemini';
    await sendTelegramMessage(
      chatId,
      `ℹ️ Mode AI saat ini: *${currentMode.toUpperCase()}*\n\nGunakan perintah:\n- \`/gemini\` untuk beralih ke Mode Gemini AI\n- \`/jules\` untuk beralih ke Mode Jules AI`
    );
    return res.status(200).json({ status: 'ok' });
  }

  const activeMode = userModes.get(chatId) || 'gemini';
  const activeApiKey = sanitizeApiKey(activeMode === 'jules' ? (JULES_API_KEY || GEMINI_API_KEY) : GEMINI_API_KEY);
  const ai = new GoogleGenAI({ apiKey: activeApiKey });

  const systemInstruction = activeMode === 'jules'
    ? 'You are Jules, an extremely skilled software engineer and coding agent assistant. Provide clear, accurate, high-quality code solutions and explanations.'
    : undefined;

  try {
    const config = {
      tools: tools,
    };
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: userText,
      config: config,
    });

    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      for (const call of functionCalls) {
        if (call.name === 'generateImage') {
          await handleGenerateImage(call.args.prompt, chatId, activeApiKey);
        } else if (call.name === 'generateVideo') {
          await handleGenerateVideo(call.args.prompt, chatId, activeApiKey);
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
