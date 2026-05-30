const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const Respondent = require('../models/Respondent');
const Disposition = require('../models/Disposition');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

// Configure Cloudinary (Requires Railway Variables)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 1. Get Next Respondent (Atomic Lock with Quota & Callbacks)
router.get('/next-respondent', async (req, res) => {
  try {
    const associateId = req.user.uid; 

    // NEW FEATURE: Hard Quota Enforcement Check
    // Example: Global cap of 5000 completed surveys before system auto-halts
    const completedCount = await Disposition.countDocuments({ outcome: { $regex: /^completed/ } });
    if (completedCount >= 5000) {
      return res.status(403).json({ message: 'Campaign Quota reached. No more leads can be pulled.' });
    }

    // NEW FEATURE: Smart Callback Routing
    // Check for due callbacks assigned to this associate first
    let respondent = await Respondent.findOneAndUpdate(
      { 
        status: 'callback-requested', 
        lockedBy: null, 
        callbackAssignedTo: associateId,
        callbackTime: { $lte: new Date() } // Time has arrived or passed
      },
      { $set: { lockedBy: associateId, lockTime: new Date() } },
      { new: true, sort: { callbackTime: 1 } } // Oldest due first
    );

    // If no callbacks are due, fetch a standard uncontacted lead
    if (!respondent) {
      respondent = await Respondent.findOneAndUpdate(
        { status: 'uncontacted', lockedBy: null },
        { $set: { lockedBy: associateId, lockTime: new Date() } },
        { new: true, sort: { createdAt: 1 } } // Oldest first
      );
    }

    if (!respondent) {
      return res.status(404).json({ message: 'No available respondents or pending callbacks in the pool.' });
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
    const { respondentId, outcome, notes, callDurationSeconds, callbackTime } = req.body;
    const associateId = req.user.uid;

    if (!respondentId || !outcome) {
      return res.status(400).json({ error: 'Respondent ID and Outcome are required.' });
    }

    const disposition = new Disposition({
      respondentId,
      associateId,
      outcome,
      notes,
      callDurationSeconds,
      callbackTime: outcome === 'callback-requested' ? callbackTime : null // NEW
    });
    await disposition.save();

    // Update respondent status, routing flags, and remove lock
    await Respondent.findByIdAndUpdate(respondentId, {
      status: outcome === 'no-answer' ? 'uncontacted' : outcome,
      lastCallStatus: outcome,
      lockedBy: null,
      lockTime: null,
      callbackTime: outcome === 'callback-requested' ? callbackTime : null, // NEW
      callbackAssignedTo: outcome === 'callback-requested' ? associateId : null // NEW
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
  const callerId = process.env.TWILIO_CALLER_ID; 
  const serverUrl = `https://${req.get('host')}`;

  if (!to) {
    twiml.say("Error: No destination phone number provided.");
  } else if (!callerId) {
    twiml.say("Error: Twilio Caller ID is missing in the server environment.");
  } else {
    const dial = twiml.dial({ 
      callerId: callerId,
      record: 'record-from-answer',
      recordingStatusCallback: `${serverUrl}/api/associate/recording-status?phone=${encodeURIComponent(to)}`,
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: 'completed'
    });
    dial.number(to);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// 5. Cloudinary Migration Webhook
router.post('/recording-status', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const phone = req.query.phone;
    const recordingUrl = req.body.RecordingUrl;
    const recordingSid = req.body.RecordingSid; 
    
    if (phone && recordingUrl && recordingSid) {
      
      const cloudinaryResponse = await cloudinary.uploader.upload(`${recordingUrl}.mp3`, {
        resource_type: 'video', 
        folder: 'irs_crm_recordings' 
      });

      await Respondent.findOneAndUpdate(
        { phone: phone },
        { $push: { recordings: { url: cloudinaryResponse.secure_url, date: new Date() } } }
      );

      const twilioClient = twilio(
        process.env.TWILIO_API_KEY, 
        process.env.TWILIO_API_SECRET, 
        { accountSid: process.env.TWILIO_ACCOUNT_SID }
      );
      await twilioClient.recordings(recordingSid).remove();
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error in Cloudinary migration webhook:', error);
    res.sendStatus(500);
  }
});

// 6. Temporary Data Seeder
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
        phone: "+919860030346",
        email: "david@example.com",
        demographics: { age: 45, gender: "Male", location: "San Francisco, USA", industry: "Healthcare" }
      }
    ];

    await Respondent.insertMany(dummyData);
    res.status(201).json({ message: "Successfully injected test respondents." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Live Metrics for Dashboard
router.get('/metrics', async (req, res) => {
  try {
    const associateId = req.user.uid;
    
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const totalDispositionsToday = await Disposition.countDocuments({
      associateId,
      createdAt: { $gte: startOfDay }
    });

    const catiCount = await Disposition.countDocuments({
      associateId,
      outcome: 'completed-cati',
      createdAt: { $gte: startOfDay }
    });

    const cawiCount = await Disposition.countDocuments({
      associateId,
      outcome: 'completed-cawi',
      createdAt: { $gte: startOfDay }
    });

    res.json({
      callsMade: totalDispositionsToday, 
      connectedCalls: catiCount + cawiCount,
      cati: catiCount,
      cawi: cawiCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEW FEATURE 8: Data Ingestion (CSV Upload to DB)
router.post('/ingest', async (req, res) => {
  try {
    const records = req.body; // Expects an array of objects mapped from CSV
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'Valid JSON array of records required.' });
    }

    // Insert ignoring duplicates (phone is unique in schema)
    const result = await Respondent.insertMany(records, { ordered: false }).catch(err => {
      // If error is code 11000 (duplicate key), we return the successful insertions
      return err.insertedDocs; 
    });

    res.status(201).json({ message: `Successfully ingested ${result ? result.length : 0} new respondents.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEW FEATURE 9: Client Data Export
router.get('/export', async (req, res) => {
  try {
    const respondents = await Respondent.find().lean();
    
    // Construct CSV Header
    let csvStr = 'ID,Name,Phone,Email,Status,LastCallStatus,RecordingCount\n';
    
    // Populate CSV Rows
    respondents.forEach(r => {
      const recCount = r.recordings ? r.recordings.length : 0;
      csvStr += `"${r._id}","${r.name}","${r.phone}","${r.email || ''}","${r.status || 'uncontacted'}","${r.lastCallStatus || ''}",${recCount}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('irs_crm_export.csv');
    res.send(csvStr);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
