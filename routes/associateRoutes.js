// File: routes/associateRoutes.js

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const { Resend } = require('resend');
const Respondent = require('../models/Respondent');
const Disposition = require('../models/Disposition');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

// Optional fallback string so your server doesn't crash before you add your Railway Variable
const resend = new Resend(process.env.RESEND_API_KEY || 're_mock_key');

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

    // Hard Quota Enforcement Check
    const completedCount = await Disposition.countDocuments({ outcome: { $regex: /^completed/ } });
    if (completedCount >= 5000) {
      return res.status(403).json({ message: 'Campaign Quota reached. No more leads can be pulled.' });
    }

    // Smart Callback Routing
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

// Update Respondent Profile Route
router.put('/respondent/:id', async (req, res) => {
  try {
    const { company, jobTitle, jobRole, country, source, directNumber, boardLineNumber, additionalBoardLines } = req.body;
    const updated = await Respondent.findByIdAndUpdate(req.params.id, {
      $set: {
        company, jobTitle, jobRole, country, source, directNumber, boardLineNumber, additionalBoardLines
      }
    }, { new: true });
    
    if (!updated) return res.status(404).json({ error: 'Respondent not found' });
    res.json(updated);
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
    const { respondentId, outcome, notes, callDurationSeconds, callbackTime, recordingUrl } = req.body;
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
      callbackTime: outcome === 'callback-requested' ? callbackTime : null,
      recordingUrl: recordingUrl || null
    });
    await disposition.save();

    await Respondent.findByIdAndUpdate(respondentId, {
      status: outcome === 'no-answer' ? 'uncontacted' : outcome,
      lastCallStatus: outcome,
      lockedBy: null,
      lockTime: null,
      callbackTime: outcome === 'callback-requested' ? callbackTime : null,
      callbackAssignedTo: outcome === 'callback-requested' ? associateId : null 
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

// 8. Data Ingestion (CSV Upload to DB) with FEATURE: Automated Data Enrichment
router.post('/ingest', async (req, res) => {
  try {
    const records = req.body; 
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'Valid JSON array of records required.' });
    }

    // Helper: Clean and format phone numbers for Twilio
    const sanitizePhone = (phone) => {
      if (!phone) return null;
      let cleaned = phone.toString().replace(/[\s\-\(\)]/g, ''); // Strip visual formatting
      
      // Smart formatting: If it's 10 digits exactly, assume Indian format and append +91
      if (/^\d{10}$/.test(cleaned)) {
        cleaned = '+91' + cleaned;
      } else if (!cleaned.startsWith('+') && /^\d+$/.test(cleaned)) {
        // If it lacks a plus but is all numbers, prepend the plus
        cleaned = '+' + cleaned;
      }
      return cleaned;
    };

    // Helper: Proper capitalization for messy string inputs
    const toTitleCase = (str) => {
      if (!str) return str;
      return str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
      );
    };

    // Enrichment Mapping
    const enrichedRecords = records.map(record => {
      const enriched = { ...record };
      
      if (enriched.name) enriched.name = toTitleCase(enriched.name.trim());
      if (enriched.company) enriched.company = toTitleCase(enriched.company.trim());
      if (enriched.jobTitle) enriched.jobTitle = toTitleCase(enriched.jobTitle.trim());
      if (enriched.email) enriched.email = enriched.email.trim().toLowerCase();
      
      if (enriched.phone) enriched.phone = sanitizePhone(enriched.phone);
      if (enriched.directNumber) enriched.directNumber = sanitizePhone(enriched.directNumber);
      if (enriched.boardLineNumber) enriched.boardLineNumber = sanitizePhone(enriched.boardLineNumber);
      
      return enriched;
    });

    // Modified to use the enriched array instead of the raw array
    const result = await Respondent.insertMany(enrichedRecords, { ordered: false }).catch(err => {
      return err.insertedDocs; // Ignore duplicates, return successful inserts
    });

    res.status(201).json({ message: `Successfully enriched and ingested ${result ? result.length : 0} new respondents.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Client Data Export
router.get('/export', async (req, res) => {
  try {
    const respondents = await Respondent.find().lean();
    
    let csvStr = 'ID,Name,Phone,Email,Status,LastCallStatus,RecordingCount\n';
    
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

// Get Active Associates for Warm Transfer
router.get('/active-associates', async (req, res) => {
  try {
    const mockActiveAssociates = [
      { id: 'manager-001', name: 'Sarah Connor', role: 'Escalations Manager', status: 'Available' },
      { id: 'agent-002', name: 'John Smith', role: 'Senior Associate', status: 'In a Call' },
      { id: 'agent-003', name: 'Priya Mehta', role: 'Support Specialist', status: 'Available' }
    ];
    res.json(mockActiveAssociates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1-Click Voicemail Drop Hijack
router.post('/voicemail-drop', express.json(), async (req, res) => {
  try {
    const { callSid } = req.body;
    if (!callSid) return res.status(400).json({ error: 'Call SID required' });

    const twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
    const serverUrl = `https://${req.get('host')}`;
    
    await twilioClient.calls(callSid).update({
      method: 'POST',
      url: `${serverUrl}/api/associate/voicemail-twiml`
    });

    res.status(200).json({ message: 'Voicemail routing initiated successfully.' });
  } catch (error) {
    console.error('Voicemail Drop Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// The TwiML for the Voicemail Drop
router.post('/voicemail-twiml', express.urlencoded({ extended: false }), (req, res) => {
  const twiml = new VoiceResponse();
  const audioUrl = process.env.VOICEMAIL_AUDIO_URL || 'https://demo.twilio.com/docs/classic.mp3';
  
  twiml.play(audioUrl);
  twiml.hangup(); 
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Historical Timeline Fetcher
router.get('/respondent/:id/history', async (req, res) => {
  try {
    const history = await Disposition.find({ respondentId: req.params.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Introductory Email via Resend
router.post('/send-intro-email', async (req, res) => {
  try {
    const { respondentId, surveyName, agentName, agentId } = req.body;
    
    if (!respondentId || !surveyName) {
      return res.status(400).json({ error: 'Respondent ID and Survey Name are required.' });
    }

    const respondent = await Respondent.findById(respondentId);
    if (!respondent) return res.status(404).json({ error: 'Respondent not found.' });
    if (!respondent.email) return res.status(400).json({ error: 'Respondent has no valid email address.' });

    const uniqueToken = crypto.randomBytes(16).toString('hex');
    const trackingLink = `https://${req.get('host')}/api/associate/track-survey/${uniqueToken}`;

    const htmlContent = `
      <div style="font-family: sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto;">
        <p>Dear ${respondent.name.split(' ')[0]},</p>
        <p>Following up on our recent communication, I am sharing the link to the <strong>${surveyName}</strong>.</p>
        <p>Your insights are incredibly valuable to our research. Please use your unique, secure link below to access the survey:</p>
        <p style="margin: 25px 0;">
          <a href="${trackingLink}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Begin Survey</a>
        </p>
        <p>If you have any questions, feel free to reply directly to this email.</p>
        <p>Best regards,<br/><br/><strong>${agentName || 'Research Team'}</strong><br/>IRS-CRM Associate</p>
      </div>
    `;

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    
    const { data, error } = await resend.emails.send({
      from: `IRS-CRM <${fromEmail}>`,
      to: [respondent.email],
      subject: `Research Invitation: ${surveyName}`,
      html: htmlContent,
    });

    if (error) {
      console.error('Resend Error:', error);
      return res.status(500).json({ error: error.message });
    }

    respondent.assignedSurveys.push({
      surveyName,
      associateId: agentId || 'unknown-agent',
      uniqueToken,
      status: 'Sent'
    });
    await respondent.save();

    res.status(200).json({ message: 'Email sent successfully!', trackingLink });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Survey Tracking Redirect
router.get('/track-survey/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const respondent = await Respondent.findOne({ 'assignedSurveys.uniqueToken': token });
    
    if (!respondent) {
      return res.status(404).send('Invalid or expired survey link.');
    }

    const surveyIndex = respondent.assignedSurveys.findIndex(s => s.uniqueToken === token);
    if (surveyIndex !== -1 && respondent.assignedSurveys[surveyIndex].status === 'Sent') {
      respondent.assignedSurveys[surveyIndex].status = 'Opened';
      await respondent.save();
    }

    const destinationUrl = process.env.SURVEY_PLATFORM_URL || 'https://google.com';
    res.redirect(`${destinationUrl}?ref=${token}`);
  } catch (error) {
    res.status(500).send('Tracking error occurred.');
  }
});

module.exports = router;
