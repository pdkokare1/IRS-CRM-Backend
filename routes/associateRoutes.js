const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const Respondent = require('../models/Respondent');
const Disposition = require('../models/Disposition');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

// 1. Get Next Respondent (Atomic Lock)
router.get('/next-respondent', async (req, res) => {
  try {
    const associateId = req.user.uid; 
    
    // Find and lock an uncontacted respondent atomically
    const respondent = await Respondent.findOneAndUpdate(
      { status: 'uncontacted', lockedBy: null },
      { $set: { lockedBy: associateId, lockTime: new Date() } },
      { new: true, sort: { createdAt: 1 } } // Oldest first
    );

    if (!respondent) {
      return res.status(404).json({ message: 'No available uncontacted respondents in the pool.' });
    }

    res.json(respondent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Generate Twilio Access Token for the Client Dialer
router.get('/twilio-token', (req, res) => {
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioApiKey = process.env.TWILIO_API_KEY;
    const twilioApiSecret = process.env.TWILIO_API_SECRET;
    const twilioAppSid = process.env.TWILIO_APP_SID; 

    if (!twilioAccountSid || !twilioApiKey || !twilioApiSecret || !twilioAppSid) {
      return res.status(500).json({ error: 'Twilio credentials missing in environment.' });
    }

    const token = new AccessToken(
      twilioAccountSid,
      twilioApiKey,
      twilioApiSecret,
      { identity: req.user.uid }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twilioAppSid,
      incomingAllow: false,
    });

    token.addGrant(voiceGrant);
    res.json({ token: token.toJwt() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Save Disposition and Unlock/Update Respondent
router.post('/disposition', async (req, res) => {
  try {
    const { respondentId, outcome, notes, callDurationSeconds } = req.body;
    const associateId = req.user.uid;

    const disposition = new Disposition({
      respondentId,
      associateId,
      outcome,
      notes,
      callDurationSeconds
    });
    await disposition.save();

    // Update respondent status and remove lock
    await Respondent.findByIdAndUpdate(respondentId, {
      status: outcome === 'no-answer' ? 'uncontacted' : outcome,
      lockedBy: null,
      lockTime: null
    });

    res.status(200).json({ message: 'Disposition saved successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Twilio Voice Webhook (TwiML App Bridge)
router.post('/voice', express.urlencoded({ extended: false }), (req, res) => {
  const twiml = new VoiceResponse();
  const to = req.body.To;
  
  // The callerId must be a verified Twilio number you own
  const callerId = process.env.TWILIO_CALLER_ID; 

  if (!to) {
    twiml.say("Error: No destination phone number provided.");
  } else if (!callerId) {
    twiml.say("Error: Twilio Caller ID is missing in the server environment.");
  } else {
    // This tells Twilio to bridge the browser audio to the real phone network
    const dial = twiml.dial({ callerId });
    dial.number(to);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// 5. Temporary Data Seeder (To test the UI) - CHANGED TO GET
router.get('/seed', async (req, res) => {
  try {
    const dummyData = [
      {
        name: "Arjun Sharma",
        phone: "+919860976209", 
        email: "arjun@example.com",
        demographics: { age: 34, gender: "Male", location: "Pune, India", industry: "Technology" }
      },
      {
        name: "Priya Patel",
        phone: "+917666886851",
        email: "priya@example.com",
        demographics: { age: 28, gender: "Female", location: "Mumbai, India", industry: "Finance" }
      },
      {
        name: "David Chen",
        phone: "+14155552671",
        email: "david@example.com",
        demographics: { age: 45, gender: "Male", location: "San Francisco, USA", industry: "Healthcare" }
      }
    ];

    await Respondent.insertMany(dummyData);
    res.status(201).json({ message: "Successfully injected 3 test respondents into the queue." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
