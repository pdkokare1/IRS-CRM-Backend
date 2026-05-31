// File: models/Respondent.js

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
    index: true, // Speeds up manual searches
  },
  // Expanded Respondent Data Fields
  company: { type: String, default: null },
  jobTitle: { type: String, default: null },
  jobRole: { type: String, default: null },
  email: { type: String, default: null },
  directNumber: { type: String, default: null },
  boardLineNumber: { type: String, default: null },
  
  // Schema accepts multiple extra board lines 
  additionalBoardLines: [{ type: String }],
  
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
  
  // NEW/MISSING: Added to support the atomic locking in associateController
  status: {
    type: String,
    default: 'uncontacted',
    index: true,
  },
  lockedBy: {
    type: String,
    default: null,
    index: true,
  },
  lockTime: {
    type: Date,
    default: null,
  },
  
  lastCallStatus: {
    type: String,
    default: 'Uncalled',
    index: true,
  },
  recordings: [{
    url: { type: String },
    date: { type: Date, default: Date.now }
  }],
  callbackTime: {
    type: Date,
    default: null,
    index: true,
  },
  callbackAssignedTo: {
    type: String,
    default: null,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // Smart Email & Survey Tracking System
  assignedSurveys: [{
    surveyName: { type: String },
    associateId: { type: String },
    uniqueToken: { type: String },
    status: { type: String, default: 'Sent' }, // Status can be Sent, Opened, or Completed
    sentAt: { type: Date, default: Date.now }
  }]
});

// Compound index for the atomic queue fetch (prioritizing callbacks and uncontacted leads)
respondentSchema.index({ status: 1, lockedBy: 1, callbackTime: 1 });

module.exports = mongoose.models.Respondent || mongoose.model('Respondent', respondentSchema);
