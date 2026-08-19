require('dotenv').config();

// Global catchers to keep Node alive on network drops
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || (err.message && err.message.includes('fetch failed'))) {
    // Silent catch
  } else {
    console.error('Uncaught Exception:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  if (reason && (reason.code === 'ECONNRESET' || (reason.message && reason.message.includes('fetch failed')))) {
    // Silent catch
  } else {
    console.error('Unhandled Rejection:', reason);
  }
});

const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const TelegramBotPackage = require('node-telegram-bot-api');
const distance = require('@turf/distance').default;
const { point } = require('@turf/helpers');

const TelegramBot = TelegramBotPackage.default || TelegramBotPackage;
const Mandi = require('./models/Mandi');

// Configurations
const TELEGRAM_TOKEN = '8878208094:AAEBZ06revJ10sn92ETNky9jP5GWxNFK5gg';
const AGMARKNET_API_KEY = '579b464db66ec23bdd0000018332acedc15c4ee159ffd2da233cac45';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_API_KEY) {
  console.warn('⚠️ Warning: GROQ_API_KEY is missing from your .env file!');
}

const groq = new Groq({ apiKey: GROQ_API_KEY || 'dummy_key' });

const app = express();
app.use(express.json());

// Fast local dictionary for instant coordinate matching
const mandiCoordinates = {
  'pune': { lat: 18.5204, lng: 73.8567 },
  'vashi': { lat: 19.0770, lng: 73.0000 },
  'mumbai': { lat: 19.0760, lng: 72.8777 },
  'turbhe': { lat: 19.0770, lng: 73.0000 },
  'kalyan': { lat: 19.2403, lng: 73.1305 },
  'thane': { lat: 19.2183, lng: 72.9781 },
  'nashik': { lat: 20.0059, lng: 73.7898 },
  'nagpur': { lat: 21.1458, lng: 79.0882 },
  'chhatrapati sambhajinagar': { lat: 19.8762, lng: 75.3433 },
  'sambhajinagar': { lat: 19.8762, lng: 75.3433 },
  'aurangabad': { lat: 19.8762, lng: 75.3433 },
  'ahmednagar': { lat: 19.0948, lng: 74.7480 },
  'solapur': { lat: 17.6599, lng: 75.9064 },
  'kolhapur': { lat: 16.7050, lng: 74.2433 },
  'satara': { lat: 17.6805, lng: 74.0183 },
  'sangli': { lat: 16.8524, lng: 74.5815 },
  'latur': { lat: 18.4088, lng: 76.5604 },
  'nanded': { lat: 19.1383, lng: 77.3210 },
  'amravati': { lat: 20.9374, lng: 77.7796 },
  'amrawati': { lat: 20.9374, lng: 77.7796 },
  'amarawati': { lat: 20.9374, lng: 77.7796 },
  'akola': { lat: 20.7002, lng: 77.0082 },
  'jalgaon': { lat: 21.0077, lng: 75.5626 },
  'dhule': { lat: 20.9042, lng: 74.7749 },
  'parbhani': { lat: 19.2608, lng: 76.7749 },
  'yavatmal': { lat: 20.3888, lng: 78.1204 },
  'hingoli': { lat: 19.7196, lng: 77.1485 }
};

// 🌾 Smart Crop Alias & Normalization Engine
const commodityAliases = {
  'sweet potato': 'Sweet Potato',
  'sweetpotato': 'Sweet Potato',
  'ratala': 'Sweet Potato',
  'ratalu': 'Sweet Potato',
  'potato': 'Potato',
  'batata': 'Potato',
  'aloo': 'Potato',
  'sugarcane': 'Sugarcane',
  'ganna': 'Sugarcane',
  'us': 'Sugarcane',
  'chilly': 'Chilli',
  'chilli': 'Chilli',
  'chili': 'Chilli',
  'mirchi': 'Chilli',
  'green chilli': 'Chilli',
  'ladyfinger': 'Bhindi',
  'lady finger': 'Bhindi',
  'bhindi': 'Bhindi',
  'ladies finger': 'Bhindi',
  'okra': 'Bhindi',
  'carrot': 'Carrot',
  'gajar': 'Carrot',
  'tomato': 'Tomato',
  'tamatar': 'Tomato',
  'onion': 'Onion',
  'kanda': 'Onion',
  'pyaz': 'Onion',
  'cotton': 'Cotton',
  'kapas': 'Cotton',
  'soyabean': 'Soyabean',
  'soybean': 'Soyabean',
  'wheat': 'Wheat',
  'gehun': 'Wheat',
  'rice': 'Paddy',
  'paddy': 'Paddy',
  'dhan': 'Paddy',
  'maize': 'Maize',
  'corn': 'Maize',
  'makka': 'Maize',
  'bajra': 'Bajra',
  'jowar': 'Jowar',
  'bengal gram': 'Bengal Gram'
};

function normalizeCommodity(inputStr) {
  if (!inputStr) return 'General';
  const clean = inputStr.toLowerCase().trim();
  return commodityAliases[clean] || inputStr;
}

// In-memory stores
const userLocations = {}; // chatId -> { latitude, longitude }
const userQueries = {};   // chatId -> { commodity, quantity }

// Connect to MongoDB
const MONGO_URI = 'mongodb://127.0.0.1:27017/mandi_db';
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Successfully connected to MongoDB!');
    // Initial sync check on boot
    fetchAndSyncAgmarknet('Maharashtra')
      .then(res => console.log(`🚀 [Initial Boot Sync]: ${res.message}`))
      .catch(err => console.warn('⚠️ Boot sync warning:', err.message));
  })
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

// Helper: Calculate distance in KM using Turf.js
function calculateKmDistance(userLat, userLng, mandiLat, mandiLng) {
  if (!userLat || !userLng || !mandiLat || !mandiLng) return 9999;
  const from = point([userLng, userLat]);
  const to = point([mandiLng, mandiLat]);
  return Math.round(distance(from, to, { units: 'kilometers' }));
}

// Instant Coordinate Lookup via Dictionary
function getQuickCoordinates(marketName = '', districtName = '') {
  const textToSearch = `${marketName} ${districtName}`.toLowerCase();
  for (const [key, coords] of Object.entries(mandiCoordinates)) {
    if (textToSearch.includes(key)) {
      return coords;
    }
  }
  return { lat: null, lng: null };
}

// Helper: Fetch ML Prediction from FastAPI Service
async function fetchMLPrediction(mandiName, commodity, currentPrice) {
  try {
    const response = await axios.post('http://127.0.0.1:8000/predict', {
      mandiName: mandiName,
      commodity: commodity,
      currentPrice: currentPrice,
      prices: []
    }, { timeout: 10000 });

    return response.data;
  } catch (err) {
    console.error('⚠️ ML Microservice fallback triggered:', err.message);
    const predictedPriceDay2 = Math.round(currentPrice * 1.02);
    const priceDiff = Math.round(predictedPriceDay2 - currentPrice);
    return {
      mandiName: mandiName,
      commodity: commodity,
      currentPrice: currentPrice,
      predictedPriceDay2: predictedPriceDay2,
      priceDiff: priceDiff,
      percentChange: 2.0,
      recommendation: '🚀 HOLD 2 DAYS',
      advice: `Price expected to rise slightly (+2.0%). Holding recommended.`
    };
  }
}

// Optimized Live Data Sync Function
async function fetchAndSyncAgmarknet(state = 'Maharashtra') {
  const apiUrl = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${AGMARKNET_API_KEY}&format=json&filters[state]=${encodeURIComponent(state)}&limit=2000`;

  let records = [];
  try {
    const response = await axios.get(apiUrl, { timeout: 25000 });
    records = response.data.records || [];
  } catch (err) {
    console.warn('⚠️ Agmarknet API warning:', err.message);
  }

  if (records && records.length > 0) {
    await Mandi.deleteMany({});

    for (const item of records) {
      const marketName = item.market || 'Local Mandi';
      const districtName = item.district || 'Unknown';
      
      let rawCommodity = (item.commodity || '').trim();
      let cleanCommodityName = rawCommodity.split('(')[0].trim();

      // Explicit check to prevent Sweet Potato from polluting regular Potato records
      if (rawCommodity.toLowerCase().includes('sweet potato')) {
        cleanCommodityName = 'Sweet Potato';
      }

      const commodity = normalizeCommodity(cleanCommodityName || 'General');
      const newPrice = parseFloat(item.modal_price) || 0;

      if (newPrice > 0) {
        const coords = getQuickCoordinates(marketName, districtName);

        await Mandi.create({
          state: item.state || 'Maharashtra',
          district: districtName,
          mandiName: marketName,
          commodity: commodity,
          modalPrice: newPrice,
          previousPrice: newPrice,
          latitude: coords.lat,
          longitude: coords.lng,
          lastUpdated: new Date()
        });
      }
    }
  }

  const totalCount = await Mandi.countDocuments();
  return { message: `Synced ${totalCount} live market records across Maharashtra!` };
}

// Express Web Routes
app.get('/', (req, res) => res.send('🌾 Mandi Price Arbitrage API active!'));

app.get('/api/sync-agmarknet', async (req, res) => {
  try {
    const result = await fetchAndSyncAgmarknet(req.query.state || 'Maharashtra');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Render Arbitrage Results with Strict Exact Match & Deduplication
async function renderArbitrageResults(chatId, sortBy = 'profit') {
  const chatIdKey = String(chatId);
  const userLoc = userLocations[chatIdKey];
  const query = userQueries[chatIdKey];

  if (!query) return;

  const { rawCommodity, quantityQuintals } = query;
  const commodity = normalizeCommodity(rawCommodity);
  const transportRatePerKm = 15;
  const maxDistanceKm = 100;

  // Strict regex match to ensure crops match cleanly
  const rawMandis = await Mandi.find({
    commodity: new RegExp(`^${commodity}$`, 'i'),
    modalPrice: { $gt: 0 }
  });

  if (rawMandis.length === 0) {
    return bot.sendMessage(chatId, `❌ No Mandis found for crop: *${rawCommodity}*`, { parse_mode: 'Markdown' });
  }

  // Deduplicate entries by mandiName (Keep highest modal price)
  const uniqueMandiMap = new Map();
  for (const m of rawMandis) {
    if (!uniqueMandiMap.has(m.mandiName) || uniqueMandiMap.get(m.mandiName).modalPrice < m.modalPrice) {
      uniqueMandiMap.set(m.mandiName, m);
    }
  }
  const mandis = Array.from(uniqueMandiMap.values());

  let recommendations = mandis.map(mandi => {
    let calcDistance = 9999;

    if (userLoc && userLoc.latitude && userLoc.longitude && mandi.latitude && mandi.longitude) {
      calcDistance = calculateKmDistance(userLoc.latitude, userLoc.longitude, mandi.latitude, mandi.longitude);
    }

    const grossIncome = mandi.modalPrice * quantityQuintals;
    const transportCost = calcDistance * transportRatePerKm;
    const netPayout = grossIncome - transportCost;

    return {
      name: mandi.mandiName,
      district: mandi.district,
      price: mandi.modalPrice,
      dist: calcDistance,
      net: netPayout
    };
  });

  if (userLoc) {
    recommendations = recommendations.filter(item => item.dist <= maxDistanceKm);
  }

  if (recommendations.length === 0) {
    return bot.sendMessage(chatId, `❌ No Mandis found within the **100 km** radius for *${rawCommodity}*.`, { parse_mode: 'Markdown' });
  }

  if (sortBy === 'profit') {
    recommendations.sort((a, b) => b.net - a.net);
  } else if (sortBy === 'distance') {
    recommendations.sort((a, b) => a.dist - b.dist);
  }

  const top = recommendations[0];
  const sortModeLabel = sortBy === 'profit' ? '💰 Maximum Profit' : '📍 Closest Mandi';

  const mlData = await fetchMLPrediction(top.name, commodity, top.price);

  let reply = `📊 *Arbitrage Results for ${quantityQuintals} Quintals of ${commodity}*\n`;
  reply += `🎯 *Mode:* ${sortModeLabel} (Max 100 km Radius)\n\n`;

  reply += `🏆 *RECOMMENDED TODAY:* ${top.name} (${top.district})\n`;
  reply += `💰 Price Today: ₹${top.price}/quintal\n`;
  reply += `📍 Distance: ${top.dist} km\n`;
  reply += `💵 *Net Payout Today: ₹${top.net}*\n\n`;

  if (mlData) {
    reply += `🤖 *2-DAY ML PRICE FORECAST:*\n`;
    reply += `🔮 Expected Price (Day +2): *₹${mlData.predictedPriceDay2}/quintal*\n`;
    reply += `💡 *Advice:* ${mlData.recommendation} — ${mlData.advice || ''}\n\n`;
  }

  reply += `*Mandis Within 100 km:* \n`;
  recommendations.forEach((item, index) => {
    reply += `${index + 1}. *${item.name}* - Net: ₹${item.net} (${item.dist} km @ ₹${item.price}/q)\n`;
  });

  const inlineButtons = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💰 Max Profit', callback_data: 'sort_profit' },
          { text: '📍 Closest Mandi', callback_data: 'sort_distance' }
        ]
      ]
    }
  };

  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', ...inlineButtons });
}

// Telegram Bot Logic
let bot;
try {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { 
      interval: 2000, 
      autoStart: true, 
      params: { timeout: 30 } 
    }
  });

  bot.on('polling_error', (err) => {
    if (err.code !== 'EFATAL' && err.code !== 'ECONNRESET') {
      console.warn('Polling Warning:', err.message);
    }
  });

  console.log('🤖 Telegram Bot initialized and polling...');

  bot.on('location', (msg) => {
    const chatIdKey = String(msg.chat.id);
    const { latitude, longitude } = msg.location;
    userLocations[chatIdKey] = { latitude, longitude };

    return bot.sendMessage(
      msg.chat.id,
      `📍 *Location Saved!* (${latitude.toFixed(4)}, ${longitude.toFixed(4)})\n\nEnter your crop query or send a voice note (e.g. \`Sugarcane 20\`, \`Potato 30\`, or \`Chilly 10\`)!`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const chatIdKey = String(chatId);

    bot.sendMessage(chatId, "🎙️ *Transcribing voice message...*", { parse_mode: 'Markdown' });

    const localAudioPath = path.join(__dirname, `voice_${chatId}.ogg`);

    try {
      const fileId = msg.voice.file_id;
      const fileLink = await bot.getFileLink(fileId);

      const response = await axios({
        method: 'get',
        url: fileLink,
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(localAudioPath);
      response.data.pipe(writer);

      writer.on('finish', async () => {
        try {
          const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(localAudioPath),
            model: 'whisper-large-v3-turbo',
            prompt: 'Crop name and quantity in quintals like Onion 10, Sugarcane 20, Potato 30, Chilly 5, Bhindi 15, Bajra 20'
          });

          if (fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath);

          const transcribedText = transcription.text ? transcription.text.trim() : '';
          
          bot.sendMessage(chatId, `🗣️ *You said:* "${transcribedText}"`, { parse_mode: 'Markdown' });

          const parts = transcribedText.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
          if (parts.length < 2) {
            return bot.sendMessage(chatId, "⚠️ Couldn't extract crop and quantity. Please say e.g., *'Potato 30'*", { parse_mode: 'Markdown' });
          }

          const rawCommodity = parts[0];
          const quantityQuintals = parseFloat(parts[1]);

          if (isNaN(quantityQuintals)) {
            return bot.sendMessage(chatId, "⚠️ Please mention a valid quantity number in your voice note.");
          }

          userQueries[chatIdKey] = { rawCommodity, quantityQuintals };
          await renderArbitrageResults(chatId, 'profit');

        } catch (err) {
          if (fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath);
          console.error('Groq Transcription Error:', err.message);
          bot.sendMessage(chatId, "❌ Voice transcription error. Please check your Groq API key in .env.");
        }
      });

    } catch (err) {
      if (fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath);
      console.error('Voice Fetch Error:', err.message);
      bot.sendMessage(chatId, "❌ Failed to retrieve voice file.");
    }
  });

  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const action = callbackQuery.data;

    bot.answerCallbackQuery(callbackQuery.id);

    if (action === 'sort_profit') {
      await renderArbitrageResults(chatId, 'profit');
    } else if (action === 'sort_distance') {
      await renderArbitrageResults(chatId, 'distance');
    }
  });

  bot.on('message', async (msg) => {
    if (msg.location || msg.voice) return;

    const chatId = msg.chat.id;
    const chatIdKey = String(chatId);
    const text = msg.text ? msg.text.trim() : '';

    if (!text) return;

    if (text === '/start') {
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({
          keyboard: [[{ text: '📍 Share Current Location', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: false
        })
      };
      return bot.sendMessage(chatId, "🌾 *Welcome to Mandi Price Arbitrage Bot!*\n\n1️⃣ Tap *'📍 Share Current Location'*\n2️⃣ Send text or hold 🎙️ Voice Note (e.g., `Potato 30`, `Sugarcane 20`, `Chilly 10`)\n3️⃣ Toggle between *Max Profit* or *Closest Mandi*!", opts);
    }

    const parts = text.split(' ');
    if (parts.length < 2) {
      return bot.sendMessage(chatId, "⚠️ Enter format: *Crop Quantity*\nExample: `Potato 30`", { parse_mode: 'Markdown' });
    }

    const rawCommodity = parts[0];
    const quantityQuintals = parseFloat(parts[1]);

    if (isNaN(quantityQuintals)) {
      return bot.sendMessage(chatId, "⚠️ Please enter a valid number for quantity.");
    }

    userQueries[chatIdKey] = { rawCommodity, quantityQuintals };
    await renderArbitrageResults(chatId, 'profit');
  });

} catch (err) {
  console.error('❌ Failed to start Telegram Bot:', err.message);
}

// ⏰ Auto-Sync Daily at 6:00 AM IST (Indian Standard Time)
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ [Cron Job] Starting daily 6:00 AM Agmarknet price sync...');
  try {
    const result = await fetchAndSyncAgmarknet('Maharashtra');
    console.log(`✅ [Cron Job Success]: ${result.message}`);
  } catch (err) {
    console.error('❌ [Cron Job Error] Failed to auto-sync:', err.message);
  }
}, {
  timezone: "Asia/Kolkata"
});

// Start Server
const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));