const mongoose = require('mongoose');

const respondentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  demographics: {
    age: Number,
    gender: String,
    location: String,
    industry: String,
  },
  status: { 
    type: String, 
    enum: ['uncontacted', 'callback', 'completed', 'refusal', 'terminated'],
    default: 'uncontacted' 
  },
  lockedBy: { type: String, default: null }, // Firebase UID of the Associate
  lockTime: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Respondent', respondentSchema);
