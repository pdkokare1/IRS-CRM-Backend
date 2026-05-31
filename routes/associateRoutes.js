// File: routes/associateRoutes.js

const express = require('express');
const router = express.Router();
const associateController = require('../controllers/associateController');

// 1. Get Next Respondent (Atomic Lock with Quota & Callbacks)
router.get('/next-respondent', associateController.getNextRespondent);

// Update Respondent Profile Route
router.put('/respondent/:id', associateController.updateRespondent);

// 2. Generate Twilio Access Token for the Client Dialer
router.get('/twilio-token', associateController.getTwilioToken);

// 3. Save Disposition and Unlock/Update Respondent
router.post('/disposition', associateController.saveDisposition);

// 4. Twilio Voice Webhook (TwiML App Bridge)
router.post('/voice', express.urlencoded({ extended: false }), associateController.voiceWebhook);

// 5. Cloudinary Migration Webhook
router.post('/recording-status', express.urlencoded({ extended: false }), associateController.recordingStatusWebhook);

// 6. Live Metrics for Dashboard
router.get('/metrics', associateController.getMetrics);

// 7. Get Active Associates for Warm Transfer
router.get('/active-associates', associateController.getActiveAssociates);

// 8. 1-Click Voicemail Drop Hijack
router.post('/voicemail-drop', express.json(), associateController.voicemailDrop);

// 9. The TwiML for the Voicemail Drop
router.post('/voicemail-twiml', express.urlencoded({ extended: false }), associateController.voicemailTwiml);

// 10. Historical Timeline Fetcher (Specific Respondent)
router.get('/respondent/:id/history', associateController.getHistory);

// 11. Send Introductory Email via Resend
router.post('/send-intro-email', associateController.sendIntroEmail);

// 12. Survey Tracking Redirect
router.get('/track-survey/:token', associateController.trackSurvey);

// 13. Global History for Associate Dashboard
router.get('/history', associateController.getGlobalHistory);

module.exports = router;
