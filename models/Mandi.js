const mongoose = require('mongoose');

const mandiSchema = new mongoose.Schema({
  state: String,
  district: String,
  mandiName: String,
  commodity: String,
  modalPrice: Number,
  previousPrice: { type: Number, default: 0 },
  latitude: { type: Number, default: 18.9220 },  // Default fallback coords (Mumbai region)
  longitude: { type: Number, default: 72.8347 },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Mandi', mandiSchema);