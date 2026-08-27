const mongoose = require('mongoose');

const mandiSchema = new mongoose.Schema({
  state: { type: String, default: 'Maharashtra' },
  district: { type: String, default: 'Unknown' },
  mandiName: { type: String, required: true },
  commodity: { type: String, required: true },
  modalPrice: { type: Number, required: true },
  minPrice: { type: Number, default: 0 },
  maxPrice: { type: Number, default: 0 },
  previousPrice: { type: Number, default: 0 },
  latitude: { type: Number, default: 18.9220 },
  longitude: { type: Number, default: 72.8347 },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Mandi || mongoose.model('Mandi', mandiSchema);