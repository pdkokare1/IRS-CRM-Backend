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
  // NEW: Links the respondent to a specific agent's list view
  assignedTo: {
    type: String,
    default: null,
  },
  // NEW: Provides instant UI feedback in the dashboard table
  lastCallStatus: {
    type: String,
    default: 'Uncalled',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.models.Respondent || mongoose.model('Respondent', respondentSchema);
