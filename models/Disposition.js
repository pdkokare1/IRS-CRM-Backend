const mongoose = require('mongoose');

const dispositionSchema = new mongoose.Schema({
  respondentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Respondent', required: true },
  associateId: { type: String, required: true }, // Firebase UID
  outcome: { 
    type: String, 
    enum: ['completed', 'refusal', 'callback', 'terminated', 'no-answer'], 
    required: true 
  },
  notes: { type: String },
  callDurationSeconds: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Disposition', dispositionSchema);
