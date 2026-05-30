const mongoose = require('mongoose');

const respondentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    default: null,
  },
  demographics: {
    type: Map,
    of: String,
    default: {},
  },
  assignedTo: {
    type: String,
    default: null,
  },
  lastCallStatus: {
    type: String,
    default: 'Uncalled',
  },
  // NEW: Formally tracking Cloudinary audio URLs
  recordings: [{
    url: { type: String },
    date: { type: Date, default: Date.now }
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.models.Respondent || mongoose.model('Respondent', respondentSchema);
