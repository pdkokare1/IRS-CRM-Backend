// File: models/Disposition.js

const mongoose = require('mongoose');

const dispositionSchema = new mongoose.Schema({
  respondentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Respondent', required: true, index: true },
  associateId: { type: String, required: true, index: true }, // Firebase UID
  outcome: { 
    type: String, 
    enum: ['completed-cati', 'completed-cawi', 'callback-requested', 'left-voicemail', 'no-answer', 'wrong-number', 'refused', 'completed', 'refusal', 'callback', 'terminated'], 
    required: true,
    index: true
  },
  notes: { type: String },
  callDurationSeconds: { type: Number, default: 0 },
  // Track the specific callback time requested historically
  callbackTime: { type: Date, default: null },
  // Audio Playback link for this specific disposition's timeline
  recordingUrl: { type: String, default: null }
}, { timestamps: true });

// Compound index to optimize the daily metrics query in associateController
dispositionSchema.index({ associateId: 1, createdAt: -1 });

module.exports = mongoose.models.Disposition || mongoose.model('Disposition', dispositionSchema);
