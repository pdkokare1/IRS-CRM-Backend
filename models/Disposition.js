// File: models/Disposition.js

const mongoose = require('mongoose');

const dispositionSchema = new mongoose.Schema({
  respondentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Respondent', required: true },
  associateId: { type: String, required: true }, // Firebase UID
  outcome: { 
    type: String, 
    enum: ['completed-cati', 'completed-cawi', 'callback-requested', 'left-voicemail', 'no-answer', 'wrong-number', 'refused', 'completed', 'refusal', 'callback', 'terminated'], 
    required: true 
  },
  notes: { type: String },
  callDurationSeconds: { type: Number, default: 0 },
  // NEW: Track the specific callback time requested historically
  callbackTime: { type: Date, default: null },
  // NEW FEATURE: Audio Playback link for this specific disposition's timeline
  recordingUrl: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.models.Disposition || mongoose.model('Disposition', dispositionSchema);
