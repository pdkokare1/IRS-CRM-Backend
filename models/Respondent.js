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
  // NEW: Expanded Respondent Data Fields
  company: { type: String, default: null },
  jobTitle: { type: String, default: null },
  jobRole: { type: String, default: null },
  email: { type: String, default: null },
  directNumber: { type: String, default: null },
  boardLineNumber: { type: String, default: null },
  source: { type: String, default: null },
  country: { type: String, default: null },
  
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
  recordings: [{
    url: { type: String },
    date: { type: Date, default: Date.now }
  }],
  callbackTime: {
    type: Date,
    default: null,
  },
  callbackAssignedTo: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.models.Respondent || mongoose.model('Respondent', respondentSchema);
