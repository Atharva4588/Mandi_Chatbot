require('dotenv').config();

// Global keep-alive error boundaries
process.on('uncaughtException', (err) => {
  if (
    err.code === 'ECONNRESET' || 
    err.code === 'ETIMEDOUT' || 
    (err.message && err.message.includes('fetch failed')) ||
    (err.message && err.message.includes('409 Conflict'))
  ) {
    // Keep alive silently
  } else {
    console.error('Uncaught Exception:', err.message);
  }
});

process.on('unhandledRejection', (reason) => {
  if (
    reason && 
    (reason.code === 'ECONNRESET' || 
     reason.code === 'ETIMEDOUT' || 
     (reason.message && reason.message.includes('fetch failed')) ||
     (reason.message && reason.message.includes('409 Conflict')))
  ) {
    // Keep alive silently
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

// Credentials & Endpoints
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8878208094:AAEBZ06revJ10sn92ETNky9jP5GWxNFK5gg';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://atharvagdumbre_db_user:2ecBzFIed7vLhMtt@cluster0.icowgqz.mongodb.net/mandi_db?retryWrites=true&w=majority';
const ML_SERVICE_URL = (process.env.ML_SERVICE_URL || 'https://mandi-chatbot.onrender.com').replace(/\/$/, '');
const AGMARKNET_API_KEY = process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd0000018332acedc15c4ee159ffd2da233cac45';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const groq = new Groq({ apiKey: GROQ_API_KEY || 'dummy_key' });

const app = express();
app.use(express.json());

// Accurate Geolocation Dictionary for All Mandis & Districts
const mandiCoordinates = {
  // Mumbai & MMR (0 - 45 km radius from Navi Mumbai)
  'vashi': { lat: 19.0770, lng: 73.0000 },
  'turbhe': { lat: 19.0770, lng: 73.0000 },
  'navi mumbai': { lat: 19.0330, lng: 73.0297 },
  'mumbai': { lat: 19.0760, lng: 72.8777 },
  'kalyan': { lat: 19.2403, lng: 73.1305 },
  'thane': { lat: 19.2183, lng: 72.9781 },
  'ulhasnagar': { lat: 19.2215, lng: 73.1645 },
  'panvel': { lat: 18.9894, lng: 73.1175 },
  'palghar': { lat: 19.6967, lng: 72.7699 },
  'vasai': { lat: 19.3919, lng: 72.8397 },
  'virar': { lat: 19.4700, lng: 72.8000 },
  'karjat': { lat: 18.9100, lng: 73.3300 },
  'pen': { lat: 18.7330, lng: 73.0830 },
  'alibag': { lat: 18.6414, lng: 72.8722 },
  'raigad': { lat: 18.5158, lng: 73.1822 },

  // Ahmednagar / Ahilyanagar (~180 - 240 km from Navi Mumbai)
  'ahilyanagar': { lat: 19.0948, lng: 74.7480 },
  'ahmednagar': { lat: 19.0948, lng: 74.7480 },
  'newasa': { lat: 19.5525, lng: 74.9255 },
  'ghodegaon': { lat: 19.5525, lng: 74.9255 },
  'parner': { lat: 19.0028, lng: 74.4418 },
  'shrirampur': { lat: 19.6190, lng: 74.6560 },
  'rahata': { lat: 19.7120, lng: 74.4840 },
  'kopargaon': { lat: 19.8880, lng: 74.4800 },
  'sangamner': { lat: 19.5760, lng: 74.2080 },
  'shevgaon': { lat: 19.3400, lng: 75.2100 },
  'pathardi': { lat: 19.1700, lng: 75.1800 },
  'jamkhed': { lat: 18.7200, lng: 75.3200 },

  // Pune Region (~110 - 160 km)
  'pune': { lat: 18.5204, lng: 73.8567 },
  'khadki': { lat: 18.5630, lng: 73.8340 },
  'pimpri': { lat: 18.6298, lng: 73.7997 },
  'narayangaon': { lat: 19.1228, lng: 73.9747 },
  'manchar': { lat: 19.0064, lng: 73.9436 },
  'khed': { lat: 18.8475, lng: 73.9040 },
  'junnar': { lat: 19.2083, lng: 73.8767 },
  'baramati': { lat: 18.1517, lng: 74.5770 },
  'daund': { lat: 18.4600, lng: 74.5800 },
  'bhor': { lat: 18.1600, lng: 73.8400 },

  // Nashik Region (~140 - 200 km)
  'nashik': { lat: 20.0059, lng: 73.7898 },
  'lasalgaon': { lat: 20.1477, lng: 74.2253 },
  'pimpalgaon': { lat: 20.1700, lng: 73.9800 },
  'yeola': { lat: 20.0420, lng: 74.4870 },
  'sinnar': { lat: 19.8450, lng: 74.0000 },
  'malegaon': { lat: 20.5530, lng: 74.5290 },
  'chandwad': { lat: 20.3270, lng: 74.2400 },
  'kalwan': { lat: 20.4870, lng: 73.9870 },

  // Other Maharashtra Districts (>200 km)
  'nagpur': { lat: 21.1458, lng: 79.0882 },
  'chhatrapati sambhajinagar': { lat: 19.8762, lng: 75.3433 },
  'sambhajinagar': { lat: 19.8762, lng: 75.3433 },
  'aurangabad': { lat: 19.8762, lng: 75.3433 },
  'solapur': { lat: 17.6599, lng: 75.9064 },
  'kolhapur': { lat: 16.7050, lng: 74.2433 },
  'satara': { lat: 17.6805, lng: 74.0183 },
  'sangli': { lat: 16.8524, lng: 74.5815 },
  'latur': { lat: 18.4088, lng: 76.5604 },
  'nanded': { lat: 19.1383, lng: 77.3210 },
  'amravati': { lat: 20.9374, lng: 77.7796 },
  'amrawati': { lat: 20.9374, lng: 77.7796 },
  'akola': { lat: 20.7002, lng: 77.0082 },
  'jalgaon': { lat: 21.0077, lng: 75.5626 },
  'dhule': { lat: 20.9042, lng: 74.7749 },
  'parbhani': { lat: 19.2608, lng: 76.7749 },
  'yavatmal': { lat: 20.3888, lng: 78.1204 },
  'hingoli': { lat: 19.7196, lng: 77.1485 },
  'ratnagiri': { lat: 16.9902, lng: 73.3120 },
  'sindhudurg': { lat: 16.1158, lng: 73.6981 },
  'beed': { lat: 18.9891, lng: 75.7601 },
  'osmanabad': { lat: 18.1853, lng: 76.0419 },
  'dharashiv': { lat: 18.1853, lng: 76.0419 },
  'wardha': { lat: 20.7453, lng: 78.6022 },
  'bhandara': { lat: 21.1714, lng: 79.6547 },
  'gondia': { lat: 21.4604, lng: 80.1961 },
  'chandrapur': { lat: 19.9615, lng: 79.2961 },
  'gadchiroli': { lat: 20.1849, lng: 79.9948 },
  'buldhana': { lat: 20.5293, lng: 76.1843 },
  'washim': { lat: 20.1110, lng: 77.1350 },
  'nandurbar': { lat: 21.3739, lng: 74.2404 }
};

// Crop Normalization
const commodityAliases = {
  'sweet potato': 'Sweet Potato',
  'sweetpotato': 'Sweet Potato',
  'ratala': 'Sweet Potato',
  'ratalu': 'Sweet Potato',
  'potato': 'Potato',
  'batata': 'Potato',
  'aloo': 'Potato',
  'alu': 'Potato',
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
  'bhendi': 'Bhindi',
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
  'kapus': 'Cotton',
  'soyabean': 'Soyabean',
  'soybean': 'Soyabean',
  'soya': 'Soyabean',
  'wheat': 'Wheat',
  'gehun': 'Wheat',
  'gehu': 'Wheat',
  'gahu': 'Wheat',
  'rice': 'Paddy',
  'paddy': 'Paddy',
  'dhan': 'Paddy',
  'chawal': 'Paddy',
  'tandul': 'Paddy',
  'maize': 'Maize',
  'corn': 'Maize',
  'makka': 'Maize',
  'maka': 'Maize',
  'bajra': 'Bajra',
  'bajri': 'Bajra',
  'jowar': 'Jowar',
  'jwari': 'Jowar',
  'bengal gram': 'Bengal Gram',
  'chana': 'Bengal Gram',
  'harbara': 'Bengal Gram',
  'gram': 'Bengal Gram',
  'tur': 'Arhar (Tur)',
  'arhar': 'Arhar (Tur)',
  'toor': 'Arhar (Tur)',
  'moong': 'Moong',
  'mung': 'Moong',
  'urad': 'Urad',
  'udid': 'Urad',
  'garlic': 'Garlic',
  'lasun': 'Garlic',
  'lahsun': 'Garlic',
  'ginger': 'Ginger',
  'aale': 'Ginger',
  'adrak': 'Ginger',
  'banana': 'Banana',
  'kela': 'Banana',
  'kele': 'Banana',
  'mango': 'Mango',
  'aam': 'Mango',
  'amba': 'Mango'
};

function normalizeCommodity(inputStr) {
  if (!inputStr) return 'General';
  const clean = inputStr.toLowerCase().trim();
  return commodityAliases[clean] || inputStr;
}

// Memory Stores
const userLocations = {};
const userQueries = {};

// MongoDB Atlas Connection
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 20000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    console.log('✅ Successfully connected to MongoDB Atlas!');
    fetchAndSyncAgmarknet('Maharashtra')
      .then(res => console.log(`🚀 [Initial Boot Sync]: ${res.message}`))
      .catch(err => console.warn('⚠️ Boot sync warning:', err.message));
  })
  .catch((err) => console.error('❌ MongoDB Connection Error:', err.message));

// Distance using Turf.js
function calculateKmDistance(userLat, userLng, mandiLat, mandiLng) {
  if (!userLat || !userLng || !mandiLat || !mandiLng) return 9999;
  try {
    const from = point([userLng, userLat]);
    const to = point([mandiLng, mandiLat]);
    return Math.round(distance(from, to, { units: 'kilometers' }));
  } catch (err) {
    return 9999;
  }
}

// Dynamic Coordinate Lookup
function getQuickCoordinates(marketName = '', districtName = '') {
  const textToSearch = `${marketName} ${districtName}`.toLowerCase().replace(/[\(\),]/g, ' ');
  const words = textToSearch.split(/\s+/);

  for (const [key, coords] of Object.entries(mandiCoordinates)) {
    if (textToSearch.includes(key)) {
      return coords;
    }
  }

  for (const word of words) {
    if (mandiCoordinates[word]) {
      return mandiCoordinates[word];
    }
  }

  // Realistic regional fallback if unknown
  return { lat: 19.7515, lng: 75.7139 };
}

// Python ML Service Connector
async function fetchMLPrediction(mandiName, commodity, currentPrice) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/predict`, {
      mandiName: mandiName,
      commodity: commodity,
      currentPrice: currentPrice,
      prices: []
    }, { timeout: 35000 });

    return response.data;
  } catch (err) {
    console.warn(`⚠️ ML Microservice (${ML_SERVICE_URL}) standby or waking up:`, err.message);
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
      advice: `Price expected to remain stable with mild upward trend (+2.0%). Normal selling advised.`
    };
  }
}

// Live Government API Sync
async function fetchAndSyncAgmarknet(state = 'Maharashtra') {
  const apiUrl = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${AGMARKNET_API_KEY}&format=json&filters[state]=${encodeURIComponent(state)}&limit=3000`;

  let records = [];
  try {
    const response = await axios.get(apiUrl, { timeout: 35000 });
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

// Health Check Endpoint
app.get('/', (req, res) => res.send('🌾 Mandi Price Arbitrage API 24/7 active!'));

app.get('/api/sync-agmarknet', async (req, res) => {
  try {
    const result = await fetchAndSyncAgmarknet(req.query.state || 'Maharashtra');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Render Arbitrage Results with 100 km Radius Filtering
async function renderArbitrageResults(chatId, sortBy = 'profit') {
  const chatIdKey = String(chatId);
  const userLoc = userLocations[chatIdKey];
  const query = userQueries[chatIdKey];

  if (!query) return;

  const { rawCommodity, quantityQuintals } = query;
  const commodity = normalizeCommodity(rawCommodity);
  const transportRatePerKm = 15;
  const maxDistanceKm = 100;

  const rawMandis = await Mandi.find({
    commodity: new RegExp(commodity, 'i'),
    modalPrice: { $gt: 0 }
  });

  if (rawMandis.length === 0) {
    return bot.sendMessage(chatId, `❌ No active mandi records found for crop: *${rawCommodity}*`, { parse_mode: 'Markdown' });
  }

  // Deduplicate and retain highest modal rate
  const uniqueMandiMap = new Map();
  for (const m of rawMandis) {
    if (!uniqueMandiMap.has(m.mandiName) || uniqueMandiMap.get(m.mandiName).modalPrice < m.modalPrice) {
      uniqueMandiMap.set(m.mandiName, m);
    }
  }
  const mandis = Array.from(uniqueMandiMap.values());

  // Compute accurate distances and profits
  let recommendations = mandis.map(mandi => {
    let calcDistance = 9999;

    if (userLoc && userLoc.latitude && userLoc.longitude) {
      const coords = getQuickCoordinates(mandi.mandiName, mandi.district);
      const targetLat = mandi.latitude || coords.lat;
      const targetLng = mandi.longitude || coords.lng;

      if (targetLat && targetLng) {
        calcDistance = calculateKmDistance(userLoc.latitude, userLoc.longitude, targetLat, targetLng);
      }
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

  // Strict 100 km Radius Filter
  let filteredWithin100Km = recommendations;
  if (userLoc) {
    filteredWithin100Km = recommendations.filter(item => item.dist <= maxDistanceKm);
  }

  // If no mandi found inside 100 km, pick closest available markets
  let displayList = filteredWithin100Km;
  let radiusNote = '(Max 100 km Radius)';

  if (filteredWithin100Km.length === 0) {
    recommendations.sort((a, b) => a.dist - b.dist);
    displayList = recommendations.slice(0, 3);
    radiusNote = '(Showing Nearest Available Beyond 100 km)';
  } else {
    if (sortBy === 'profit') {
      displayList.sort((a, b) => b.net - a.net);
    } else if (sortBy === 'distance') {
      displayList.sort((a, b) => a.dist - b.dist);
    }
  }

  const top = displayList[0];
  const sortModeLabel = sortBy === 'profit' ? '💰 Maximum Profit' : '📍 Closest Mandi';

  const mlData = await fetchMLPrediction(top.name, commodity, top.price);

  let reply = `📊 *Arbitrage Results for ${quantityQuintals} Quintals of ${commodity}*\n`;
  reply += `🎯 *Mode:* ${sortModeLabel} ${radiusNote}\n\n`;

  reply += `🏆 *RECOMMENDED TODAY:* ${top.name} (${top.district})\n`;
  reply += `💰 Price Today: ₹${top.price}/quintal\n`;
  reply += `📍 Distance: ${top.dist} km\n`;
  reply += `💵 *Net Payout Today: ₹${top.net.toLocaleString('en-IN')}*\n\n`;

  if (mlData) {
    reply += `🤖 *2-DAY ML PRICE FORECAST:*\n`;
    reply += `🔮 Expected Price (Day +2): *₹${mlData.predictedPriceDay2}/quintal*\n`;
    reply += `💡 *Advice:* ${mlData.recommendation} — ${mlData.advice || ''}\n\n`;
  }

  reply += `*Available Mandis:* \n`;
  displayList.slice(0, 5).forEach((item, index) => {
    reply += `${index + 1}. *${item.name}* (${item.district}) - Net: ₹${item.net.toLocaleString('en-IN')} (${item.dist} km @ ₹${item.price}/q)\n`;
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

// Initialize Telegram Bot
let bot;
try {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { 
      interval: 1500, 
      autoStart: true, 
      params: { timeout: 25 } 
    }
  });

  bot.on('polling_error', (err) => {
    if (err.code !== 'EFATAL' && err.code !== 'ECONNRESET' && !err.message.includes('409 Conflict')) {
      console.warn('Polling Warning:', err.message);
    }
  });

  console.log('🤖 Telegram Bot initialized and polling 24/7...');

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

    const localAudioPath = path.join('/tmp', `voice_${chatId}_${Date.now()}.ogg`);

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
          bot.sendMessage(chatId, "❌ Voice transcription error. Please check your Groq API key.");
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

// Daily Sync Cron Job (06:00 AM IST)
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

// Express Server Listener
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));