require('dotenv').config();

// Enforce Google Public DNS for MongoDB Atlas SRV resolution
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

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
const ML_SERVICE_URL = (process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const AGMARKNET_API_KEY = process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd0000018332acedc15c4ee159ffd2da233cac45';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const groq = new Groq({ apiKey: GROQ_API_KEY || 'dummy_key' });

const app = express();
app.use(express.json());
// Serve the B2B Buyer Web Portal from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. MONGOOSE DATA SCHEMAS
// ==========================================
const userSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  name: { type: String, default: 'Farmer' },
  phone: { type: String, default: '' },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [73.0, 19.0] }
  },
  updatedAt: { type: Date, default: Date.now }
});
userSchema.index({ location: '2dsphere' });
const User = mongoose.models.User || mongoose.model('User', userSchema);

const cropCycleSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  commodity: { type: String, required: true },
  variety: { type: String, default: 'Standard' },
  sowingDate: { type: Date, default: Date.now },
  estimatedHarvestDate: { type: Date, required: true },
  acres: { type: Number, default: 1.0 },
  expectedQuintals: { type: Number, required: true },
  status: { type: String, enum: ['SOWN', 'GROWING', 'HARVEST_READY', 'PROCURED'], default: 'GROWING' },
  createdAt: { type: Date, default: Date.now }
});
const CropCycle = mongoose.models.CropCycle || mongoose.model('CropCycle', cropCycleSchema);

// Geolocation Dictionary for Mandis & Districts
const mandiCoordinates = {
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
  'ahilyanagar': { lat: 19.0948, lng: 74.7480 },
  'ahmednagar': { lat: 19.0948, lng: 74.7480 },
  'newasa': { lat: 19.5525, lng: 74.9255 },
  'ghodegaon': { lat: 19.5525, lng: 74.9255 },
  'parner': { lat: 19.0028, lng: 74.4418 },
  'shrirampur': { lat: 19.6190, lng: 74.6560 },
  'rahata': { lat: 19.7120, lng: 74.4840 },
  'kopargaon': { lat: 19.8880, lng: 74.4800 },
  'sangamner': { lat: 19.5760, lng: 74.2080 },
  'pune': { lat: 18.5204, lng: 73.8567 },
  'khadki': { lat: 18.5630, lng: 73.8340 },
  'pimpri': { lat: 18.6298, lng: 73.7997 },
  'narayangaon': { lat: 19.1228, lng: 73.9747 },
  'manchar': { lat: 19.0064, lng: 73.9436 },
  'khed': { lat: 18.8475, lng: 73.9040 },
  'junnar': { lat: 19.2083, lng: 73.8767 },
  'baramati': { lat: 18.1517, lng: 74.5770 },
  'nashik': { lat: 20.0059, lng: 73.7898 },
  'saykheda': { lat: 20.1000, lng: 74.0500 },
  'pimpalgaon': { lat: 20.1700, lng: 73.9800 },
  'lasalgaon': { lat: 20.1477, lng: 74.2253 },
  'yeola': { lat: 20.0420, lng: 74.4870 },
  'sinnar': { lat: 19.8450, lng: 74.0000 },
  'malegaon': { lat: 20.5530, lng: 74.5290 },
  'chandwad': { lat: 20.3270, lng: 74.2400 },
  'kalwan': { lat: 20.4870, lng: 73.9870 }
};

// Commodity Normalizer
const commodityAliases = {
  'onion': 'Onion', 'kanda': 'Onion', 'pyaz': 'Onion',
  'potato': 'Potato', 'batata': 'Potato', 'aloo': 'Potato',
  'tomato': 'Tomato', 'tamatar': 'Tomato',
  'chilli': 'Chilli', 'chilly': 'Chilli', 'mirchi': 'Chilli',
  'soyabean': 'Soyabean', 'soybean': 'Soyabean',
  'wheat': 'Wheat', 'gehu': 'Wheat', 'gahu': 'Wheat',
  'sugarcane': 'Sugarcane', 'ganna': 'Sugarcane', 'us': 'Sugarcane',
  'sweet potato': 'Sweet Potato', 'ratala': 'Sweet Potato',
  'bhindi': 'Bhindi', 'okra': 'Bhindi', 'ladyfinger': 'Bhindi',
  'carrot': 'Carrot', 'gajar': 'Carrot',
  'cotton': 'Cotton', 'kapas': 'Cotton',
  'paddy': 'Paddy', 'rice': 'Paddy', 'dhan': 'Paddy',
  'maize': 'Maize', 'corn': 'Maize', 'maka': 'Maize',
  'bajra': 'Bajra', 'bajri': 'Bajra',
  'jowar': 'Jowar', 'jwari': 'Jowar',
  'chana': 'Bengal Gram', 'harbara': 'Bengal Gram',
  'tur': 'Arhar (Tur)', 'arhar': 'Arhar (Tur)', 'toor': 'Arhar (Tur)'
};

function normalizeCommodity(inputStr) {
  if (!inputStr) return 'General';
  const clean = inputStr.toLowerCase().trim();
  return commodityAliases[clean] || inputStr;
}

// In-Memory Session Cache
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

// Realistic Road Distance Calculation (1.35x winding road multiplier)
function calculateKmDistance(userLat, userLng, mandiLat, mandiLng) {
  if (!userLat || !userLng || !mandiLat || !mandiLng) return 9999;
  try {
    const from = point([userLng, userLat]);
    const to = point([mandiLng, mandiLat]);
    const aerialKm = distance(from, to, { units: 'kilometers' });
    return Math.round(aerialKm * 1.35);
  } catch (err) {
    return 9999;
  }
}

// Dynamic Coordinate Lookup
function getQuickCoordinates(marketName = '', districtName = '') {
  const textToSearch = `${marketName} ${districtName}`.toLowerCase().replace(/[\(\),]/g, ' ');
  const words = textToSearch.split(/\s+/);

  for (const [key, coords] of Object.entries(mandiCoordinates)) {
    if (textToSearch.includes(key)) return coords;
  }
  for (const word of words) {
    if (mandiCoordinates[word]) return mandiCoordinates[word];
  }
  return { lat: 19.7515, lng: 75.7139 };
}

// FastAPI ML Prediction Service Connector
async function fetchMLPrediction(mandiName, commodity, currentPrice) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/predict`, {
      mandiName: mandiName,
      commodity: commodity,
      currentPrice: currentPrice,
      prices: [],
      arrivalsTonnes: 45.0
    }, { timeout: 15000 });

    return response.data;
  } catch (err) {
    console.warn(`⚠️ ML Microservice (${ML_SERVICE_URL}) fallback triggered:`, err.message);
    const predictedPriceDay2 = Math.round(currentPrice * 1.02);
    return {
      mandiName,
      commodity,
      currentPrice,
      predictedPriceDay2,
      priceDiff: Math.round(predictedPriceDay2 - currentPrice),
      percentChange: 2.0,
      confidenceInterval: {
        lowerBound: Math.round(predictedPriceDay2 * 0.96),
        upperBound: Math.round(predictedPriceDay2 * 1.04)
      },
      recommendation: '🚀 HOLD 2 DAYS',
      advice: 'Mild upward momentum (+2.0%). Standard selling advised.'
    };
  }
}

// Dynamic B2B Quote API Connector
async function fetchDynamicQuote(commodity, market, currentPrice, floorPrice, distanceKm, quantity) {
  try {
    const response = await axios.post(`${ML_SERVICE_URL}/dynamic-quote`, {
      commodity: commodity,
      market: market,
      current_modal_price: currentPrice,
      floor_price: floorPrice,
      distance_km: distanceKm,
      quantity_quintals: quantity,
      grade: "Grade A"
    }, { timeout: 15000 });
    return response.data;
  } catch (err) {
    console.warn('⚠️ Dynamic quote microservice fallback:', err.message);
    return null;
  }
}

// Daily Agmarknet Sync Function
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
      const commodity = normalizeCommodity((item.commodity || '').split('(')[0].trim());
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

// Render Arbitrage Results (Strict Hard Cutoff <= 100 km)
async function renderArbitrageResults(chatId, sortBy = 'profit') {
  const chatIdKey = String(chatId);
  let userLoc = userLocations[chatIdKey];

  if (!userLoc) {
    const savedUser = await User.findOne({ chatId: chatIdKey });
    if (savedUser) {
      userLoc = { latitude: savedUser.latitude, longitude: savedUser.longitude };
      userLocations[chatIdKey] = userLoc;
    }
  }

  if (!userLoc) {
    return bot.sendMessage(
      chatId,
      `📍 *Please share your location first!*\n\nTap the button below so I can calculate profits for mandis within 100 km.`,
      {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({
          keyboard: [[{ text: '📍 Share Current Location', request_location: true }]],
          resize_keyboard: true
        })
      }
    );
  }

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
    return bot.sendMessage(chatId, `❌ No active mandi records found for: *${rawCommodity}*`, { parse_mode: 'Markdown' });
  }

  const uniqueMandiMap = new Map();
  for (const m of rawMandis) {
    if (!uniqueMandiMap.has(m.mandiName) || uniqueMandiMap.get(m.mandiName).modalPrice < m.modalPrice) {
      uniqueMandiMap.set(m.mandiName, m);
    }
  }
  const mandis = Array.from(uniqueMandiMap.values());

  let recommendations = mandis.map(mandi => {
    const coords = getQuickCoordinates(mandi.mandiName, mandi.district);
    const targetLat = mandi.latitude || coords.lat;
    const targetLng = mandi.longitude || coords.lng;
    const calcDistance = calculateKmDistance(userLoc.latitude, userLoc.longitude, targetLat, targetLng);
    const grossIncome = mandi.modalPrice * quantityQuintals;
    const transportCost = calcDistance * transportRatePerKm;
    return {
      name: mandi.mandiName,
      district: mandi.district,
      price: mandi.modalPrice,
      dist: calcDistance,
      net: grossIncome - transportCost
    };
  });

  let displayList = recommendations.filter(item => item.dist <= maxDistanceKm);
  if (displayList.length === 0) {
    return bot.sendMessage(chatId, `🚫 *No active APMC mandis found within your 100 km radius for ${commodity}.*`, { parse_mode: 'Markdown' });
  }

  if (sortBy === 'profit') displayList.sort((a, b) => b.net - a.net);
  else if (sortBy === 'distance') displayList.sort((a, b) => a.dist - b.dist);

  const top = displayList[0];
  const mlData = await fetchMLPrediction(top.name, commodity, top.price);

  let reply = `🌾 *भावनेत्र (BhavNetra) — ${quantityQuintals} Quintals of ${commodity}*\n\n`;
  reply += `🏆 *RECOMMENDED APMC:* ${top.name} (${top.district})\n`;
  reply += `💰 Price Today: ₹${top.price}/quintal\n`;
  reply += `📍 Distance: ${top.dist} km\n`;
  reply += `💵 *Net Payout Today: ₹${top.net.toLocaleString('en-IN')}*\n\n`;

  if (mlData) {
    const predictedPrice = mlData.predictedPriceDay2 || top.price;
    const lower = mlData?.confidenceInterval?.lowerBound 
      || mlData?.confidence_interval_95?.lower_bound 
      || Math.round(predictedPrice * 0.96);

    const upper = mlData?.confidenceInterval?.upperBound 
      || mlData?.confidence_interval_95?.upper_bound 
      || Math.round(predictedPrice * 1.04);

    reply += `📈 *AI Forecast (2-Day Horizon):*\n`;
    reply += `🔮 Projected Price (Day +2): *₹${predictedPrice}/quintal* (Range: ₹${lower} – ₹${upper})\n`;
    reply += `💡 *Advice:* ${mlData.recommendation || '⚖️ STABLE MARKET'} — ${mlData.advice || 'Normal market dispatch advised.'}\n\n`;
  }

  reply += `*Available Mandis (Within 100 km):*\n`;
  displayList.slice(0, 4).forEach((item, idx) => {
    reply += `${idx + 1}. *${item.name}* (${item.district}) - Net: ₹${item.net.toLocaleString('en-IN')} (${item.dist} km @ ₹${item.price}/q)\n`;
  });

  const inlineButtons = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💰 Max Profit', callback_data: 'sort_profit' },
          { text: '📍 Closest Mandi', callback_data: 'sort_distance' }
        ],
        [
          { text: '🏷️ Lock Farm-Gate Contract (Free Transport)', callback_data: `contract_${top.name}_${top.price}_${top.dist}` }
        ]
      ]
    }
  };

  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', ...inlineButtons });
}

// ==========================================
// 2. TELEGRAM BOT INITIALIZATION & EVENTS
// ==========================================
let bot;
try {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { interval: 1500, autoStart: true, params: { timeout: 25 } }
  });

  console.log('🤖 Telegram Bot initialized and polling 24/7...');

  // Location Receiver
  bot.on('location', async (msg) => {
    const chatIdKey = String(msg.chat.id);
    const { latitude, longitude } = msg.location;
    userLocations[chatIdKey] = { latitude, longitude };

    await User.findOneAndUpdate(
      { chatId: chatIdKey },
      { 
        chatId: chatIdKey, 
        latitude, 
        longitude, 
        location: { type: 'Point', coordinates: [longitude, latitude] },
        updatedAt: new Date() 
      },
      { upsert: true, returnDocument: 'after' }
    );

    return bot.sendMessage(
      msg.chat.id,
      `📍 *Location Saved!* (${latitude.toFixed(4)}, ${longitude.toFixed(4)})\n\nSend your crop query (e.g. \`Onion 20\`) or register a harvest with \`/sow\`!`,
      { parse_mode: 'Markdown' }
    );
  });

  // Voice Note Handler (Groq Whisper)
  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const chatIdKey = String(chatId);
    bot.sendMessage(chatId, "🎙️ *Transcribing voice message with Whisper...*", { parse_mode: 'Markdown' });

    const localAudioPath = path.join('/tmp', `voice_${chatId}_${Date.now()}.ogg`);
    try {
      const fileId = msg.voice.file_id;
      const fileLink = await bot.getFileLink(fileId);
      const response = await axios({ method: 'get', url: fileLink, responseType: 'stream' });
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

          const text = (transcription.text || '').trim();
          bot.sendMessage(chatId, `🗣️ *You said:* "${text}"`, { parse_mode: 'Markdown' });

          const parts = text.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
          if (parts.length >= 2) {
            const rawCommodity = parts[0];
            const quantityQuintals = parseFloat(parts[1]);
            if (!isNaN(quantityQuintals)) {
              userQueries[chatIdKey] = { rawCommodity, quantityQuintals };
              return renderArbitrageResults(chatId, 'profit');
            }
          }
          bot.sendMessage(chatId, "⚠️ Couldn't extract crop and quantity. Please say e.g., *'Onion 20'*", { parse_mode: 'Markdown' });
        } catch (err) {
          if (fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath);
          bot.sendMessage(chatId, "❌ Voice transcription error. Please check your Groq API key.");
        }
      });
    } catch (err) {
      if (fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath);
      bot.sendMessage(chatId, "❌ Failed to retrieve voice file.");
    }
  });

  // Inline Button Callbacks
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'sort_profit') {
      await renderArbitrageResults(chatId, 'profit');
    } else if (data === 'sort_distance') {
      await renderArbitrageResults(chatId, 'distance');
    } else if (data.startsWith('contract_')) {
      const [, mandi, priceStr, distStr] = data.split('_');
      const query = userQueries[String(chatId)];
      if (!query) return;

      const spotPrice = parseFloat(priceStr);
      const floorPrice = Math.round(spotPrice * 0.85);
      const dist = parseFloat(distStr);

      const quote = await fetchDynamicQuote(query.rawCommodity, mandi, spotPrice, floorPrice, dist, query.quantityQuintals);
      if (quote) {
        let msg = `📋 *भावनेत्र Guaranteed Farm-Gate Offer*\n\n`;
        msg += `🌾 Crop: *${query.rawCommodity}* (${query.quantityQuintals} Quintals)\n`;
        msg += `🛡️ Guaranteed Safety Floor: *₹${floorPrice}/quintal*\n`;
        msg += `✨ Grade A Quality Bonus: *+₹${quote.breakdown.quality_premium}/quintal*\n`;
        msg += `📈 Upside Share Added: *+₹${quote.breakdown.upside_share}/quintal*\n`;
        msg += `🚚 Transport Cost: *₹0 (Handled by Platform)*\n\n`;
        msg += `💵 *NET FARM-GATE PAYOUT: ₹${quote.farmer_payout_per_quintal}/quintal*\n`;
        msg += `💰 *TOTAL SETTLEMENT: ₹${quote.total_farmer_settlement.toLocaleString('en-IN')}*\n\n`;
        msg += `✅ *Instant Direct Bank/UPI Transfer upon Farm-Gate Weighment!*`;
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      }
    }
  });

  // Text & Command Handler
  bot.on('message', async (msg) => {
    if (msg.location || msg.voice) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!text) return;

    if (text === '/start') {
      return bot.sendMessage(
        chatId, 
        "🌾 *Welcome to भावनेत्र (BhavNetra)!*\n\n1️⃣ Tap *'📍 Share Current Location'*\n2️⃣ Send crop & quantity (e.g., `Onion 20`, `Potato 50`)\n3️⃣ Use `/sow` to register your upcoming harvest!",
        {
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify({
            keyboard: [[{ text: '📍 Share Current Location', request_location: true }]],
            resize_keyboard: true
          })
        }
      );
    }

    // Explicit command handler for /sow
    if (text.startsWith('/sow')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        return bot.sendMessage(
          chatId,
          "🌱 *Register Sowing & Harvest Date:*\nFormat: `/sow [Crop] [Acres] [ExpectedQuintals]`\n\nExample: `/sow Onion 3 150`",
          { parse_mode: 'Markdown' }
        );
      }
      const commodity = normalizeCommodity(parts[1]);
      const acres = parseFloat(parts[2]);
      const expectedQuintals = parseFloat(parts[3]);
      const harvestDate = new Date();
      harvestDate.setDate(harvestDate.getDate() + 90);

      await CropCycle.create({
        chatId: String(chatId),
        commodity,
        acres,
        expectedQuintals,
        estimatedHarvestDate: harvestDate
      });

      return bot.sendMessage(
        chatId,
        `✅ *Harvest Registered!*\n\n🌾 Crop: *${commodity}*\n📐 Area: *${acres} Acres*\n📦 Expected Yield: *${expectedQuintals} Quintals*\n🗓️ Expected Harvest: *${harvestDate.toDateString()}*\n\nWe will alert you with procurement contracts 10 days before harvest!`,
        { parse_mode: 'Markdown' }
      );
    }

    // Standard Crop Query Parser
    const parts = text.split(' ');
    if (parts.length >= 2) {
      const rawCommodity = parts[0];
      const quantityQuintals = parseFloat(parts[1]);
      if (!isNaN(quantityQuintals)) {
        userQueries[String(chatId)] = { rawCommodity, quantityQuintals };
        return renderArbitrageResults(chatId, 'profit');
      }
    }

    return bot.sendMessage(chatId, "⚠️ Enter format: `[Crop] [Quantity]` (e.g. `Onion 20`) or `/sow` to register harvest.", { parse_mode: 'Markdown' });
  });

} catch (err) {
  console.error('❌ Failed to start Telegram Bot:', err.message);
}

// ==========================================
// 3. SCHEDULED CRON JOBS
// ==========================================
// 1. Daily Agmarknet Sync (06:00 AM IST)
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Starting 6:00 AM Agmarknet sync...');
  try {
    const res = await fetchAndSyncAgmarknet('Maharashtra');
    console.log(`✅ [Sync Success]: ${res.message}`);
  } catch (e) {
    console.error('❌ Sync Error:', e.message);
  }
}, { timezone: "Asia/Kolkata" });

// 2. Pre-Harvest Procurement Alert (08:00 AM IST)
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Scanning for crops approaching harvest (10-day window)...');
  try {
    const today = new Date();
    const tenDaysFromNow = new Date();
    tenDaysFromNow.setDate(today.getDate() + 10);

    const maturingCycles = await CropCycle.find({
      status: 'GROWING',
      estimatedHarvestDate: { $lte: tenDaysFromNow, $gte: today }
    });

    for (const crop of maturingCycles) {
      const alertMsg = `🌾 *Your ${crop.commodity} Harvest is ~10 Days Away!*\n\n` +
                       `📦 Registered Volume: *${crop.expectedQuintals} Quintals* on *${crop.acres} Acres*\n` +
                       `🛡️ Want to lock in a guaranteed floor payout with zero transport costs?\n\n` +
                       `Send: \`${crop.commodity} ${crop.expectedQuintals}\` to check live market rates and claim your contract!`;

      bot.sendMessage(crop.chatId, alertMsg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    console.error('❌ Pre-Harvest Cron Error:', err.message);
  }
}, { timezone: "Asia/Kolkata" });

// ==========================================
// 4. EXPRESS REST ROUTES & B2B API ENDPOINTS
// ==========================================

// Fallback status check route
app.get('/api/health', (req, res) => res.json({ status: 'active', service: 'BhavNetra Mandi & B2B Engine' }));

// Agmarknet Manual Trigger
app.get('/api/sync-agmarknet', async (req, res) => {
  const result = await fetchAndSyncAgmarknet(req.query.state || 'Maharashtra');
  res.json({ success: true, ...result });
});

// Admin Route to inspect all registered crop cycles
app.get('/api/crop-cycles', async (req, res) => {
  try {
    const cycles = await CropCycle.find().sort({ createdAt: -1 });
    res.json({ success: true, count: cycles.length, cycles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Anonymized B2B Buyer Supply Feed Endpoint
app.get('/api/b2b/supply-feed', async (req, res) => {
  try {
    // 1. Fetch active crop cycles (Growing / Harvest Ready)
    const activeCrops = await CropCycle.find({
      status: { $in: ['GROWING', 'HARVEST_READY'] }
    }).sort({ estimatedHarvestDate: 1 });

    // 2. Fetch user locations to infer aggregate regional cluster
    const users = await User.find({}, 'chatId latitude longitude');
    const userMap = new Map();
    users.forEach((u) => userMap.set(u.chatId, u));

    // 3. Fetch latest APMC benchmark rates for price calculation
    const allMandis = await Mandi.find({}, 'commodity modalPrice mandiName');
    const priceMap = new Map();
    allMandis.forEach((m) => {
      const commKey = m.commodity.toLowerCase();
      if (!priceMap.has(commKey) || priceMap.get(commKey).modalPrice < m.modalPrice) {
        priceMap.set(commKey, m);
      }
    });

    const anonymizedFeed = activeCrops.map((crop) => {
      const user = userMap.get(crop.chatId);
      const commKey = crop.commodity.toLowerCase();
      const benchMandi = priceMap.get(commKey);
      const benchmarkPrice = benchMandi ? benchMandi.modalPrice : 2200;

      // Anonymize farmer identity: e.g. LOT-7489-A2F8
      const lotCode = `LOT-${crop.chatId.slice(0, 4)}-${crop._id.toString().slice(-4).toUpperCase()}`;

      // Approximate regional cluster without revealing coordinates
      let clusterName = 'Western Maharashtra Cluster';
      if (user) {
        if (user.latitude > 19.5) clusterName = 'Nashik-Ahilyanagar Agri Zone';
        else if (user.latitude > 18.5) clusterName = 'Pune-Raigad Corridor';
        else clusterName = 'Thane-Palghar Green Belt';
      }

      const daysLeft = Math.max(0, Math.ceil((new Date(crop.estimatedHarvestDate) - new Date()) / (1000 * 60 * 60 * 24)));
      
      // B2B Wholesale Pricing: Farmer Floor + Platform Quality Assay + Logistics Margin
      const b2bWholesalePrice = Math.round(benchmarkPrice * 1.05);

      return {
        id: crop._id.toString(),
        lotCode,
        commodity: crop.commodity,
        variety: crop.variety || 'Grade A Standard',
        volumeQuintals: crop.expectedQuintals,
        estimatedHarvestDate: crop.estimatedHarvestDate.toISOString().split('T')[0],
        daysRemaining: daysLeft,
        clusterOrigin: clusterName,
        qualityGrade: 'Grade A (Assayed & Certified)',
        wholesalePricePerQtl: b2bWholesalePrice,
        totalLotValue: b2bWholesalePrice * crop.expectedQuintals,
        status: crop.status
      };
    });

    res.json({
      success: true,
      totalLots: anonymizedFeed.length,
      lots: anonymizedFeed
    });
  } catch (error) {
    console.error('B2B Feed Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch anonymized feed' });
  }
});

// B2B Contract Procurement RFQ Order Desk Endpoint
app.post('/api/b2b/procure-lot', async (req, res) => {
  try {
    const { lotId, buyerName, buyerCompany, phone, email, deliveryLocation } = req.body;
    
    const crop = await CropCycle.findById(lotId);
    if (!crop) {
      return res.status(404).json({ success: false, message: 'Agri Lot not found or already procured' });
    }

    // Update status to prevent double-booking
    crop.status = 'PROCURED';
    await crop.save();

    // Alert Farmer directly on Telegram
    const farmerAlert = `🎉 *GOOD NEWS: Lot Procured!*\n\n` +
                        `📦 Your harvest of *${crop.expectedQuintals} Quintals (${crop.commodity})* has been booked by an institutional buyer (${buyerCompany}).\n` +
                        `🚚 Platform vehicle dispatch scheduled for harvest window.\n` +
                        `🛡️ *Guaranteed Direct UPI Settlement on Farm-Gate Weighment.*`;
    
    bot.sendMessage(crop.chatId, farmerAlert, { parse_mode: 'Markdown' }).catch(() => {});

    res.json({
      success: true,
      message: 'Procurement contract confirmed. BhavNetra logistics desk has been notified.',
      orderReference: `ORD-${Date.now().toString().slice(-6)}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Node.js Server listening on port ${PORT}`));