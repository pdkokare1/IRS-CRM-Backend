// File: controllers/associateController.js

const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const { Resend } = require('resend');
const Respondent = require('../models/Respondent');
const Disposition = require('../models/Disposition');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

// Configs
const resend = new Resend(process.env.RESEND_API_KEY || 're_mock_key');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

exports.getNextRespondent = async (req, res) => {
  try {
    const associateId = req.user.uid; 
    const completedCount = await Disposition.countDocuments({ outcome: { $regex: /^completed/ } });
    if (completedCount >= 5000) {
      return res.status(403).json({ message: 'Campaign Quota reached. No more leads can be pulled.' });
    }

    let respondent = await Respondent.findOneAndUpdate(
      { 
        status: 'callback-requested', 
        lockedBy: null, 
        callbackAssignedTo: associateId,
        callbackTime: { $lte: new Date() }
      },
      { $set: { lockedBy: associateId, lockTime: new Date() } },
      { new: true, sort: { callbackTime: 1 } }
    );

    if (!respondent) {
      respondent = await Respondent.findOneAndUpdate(
        { status: 'uncontacted', lockedBy: null },
        { $set: { lockedBy: associateId, lockTime: new Date() } },
        { new: true, sort: { createdAt: 1 } }
      );
    }

    if (!respondent) {
      return res.status(404).json({ message: 'No available respondents or pending callbacks in the pool.' });
    }

    res.json(respondent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateRespondent = async (req, res) => {
  try {
    const { company, jobTitle, jobRole, country, source, directNumber, boardLineNumber, additionalBoardLines } = req.body;
    const updated = await Respondent.findByIdAndUpdate(req.params.id, {
      $set: { company, jobTitle, jobRole, country, source, directNumber, boardLineNumber, additionalBoardLines }
    }, { new: true });
    
    if (!updated) return res.status(404).json({ error: 'Respondent not found' });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTwilioToken = (req, res) => {
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
};

exports.saveDisposition = async (req, res) => {
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
};

exports.voiceWebhook = (req, res) => {
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
};

exports.recordingStatusWebhook = async (req, res) => {
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
};

exports.getMetrics = async (req, res) => {
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

    res.json({ callsMade: totalDispositionsToday, connectedCalls: catiCount + cawiCount, cati: catiCount, cawi: cawiCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getActiveAssociates = async (req, res) => {
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
};

exports.voicemailDrop = async (req, res) => {
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
};

exports.voicemailTwiml = (req, res) => {
  const twiml = new VoiceResponse();
  const audioUrl = process.env.VOICEMAIL_AUDIO_URL || 'https://demo.twilio.com/docs/classic.mp3';
  
  twiml.play(audioUrl);
  twiml.hangup(); 
  
  res.type('text/xml');
  res.send(twiml.toString());
};

exports.getHistory = async (req, res) => {
  try {
    const history = await Disposition.find({ respondentId: req.params.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.sendIntroEmail = async (req, res) => {
  try {
    const { respondentId, surveyName, agentName, agentId } = req.body;
    
    if (!respondentId || !surveyName) return res.status(400).json({ error: 'Respondent ID and Survey Name are required.' });

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

    respondent.assignedSurveys.push({ surveyName, associateId: agentId || 'unknown-agent', uniqueToken, status: 'Sent' });
    await respondent.save();

    res.status(200).json({ message: 'Email sent successfully!', trackingLink });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.trackSurvey = async (req, res) => {
  try {
    const { token } = req.params;
    const respondent = await Respondent.findOne({ 'assignedSurveys.uniqueToken': token });
    
    if (!respondent) return res.status(404).send('Invalid or expired survey link.');

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
};

// NEW: Fetches global history for the associate over a specific date range
exports.getGlobalHistory = async (req, res) => {
  try {
    const { start, end } = req.query;
    const associateId = req.user.uid;

    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end dates are required.' });
    }

    // Standardize to beginning of start day and end of end day
    const startDate = new Date(start);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const history = await Disposition.find({
      associateId,
      createdAt: { $gte: startDate, $lte: endDate }
    })
      .populate('respondentId', 'name phone') // Joins Respondent data to grab name and phone
      .sort({ createdAt: -1 })
      .lean();

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
