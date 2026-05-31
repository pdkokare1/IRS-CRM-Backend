// File: routes/adminRoutes.js

const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Data Seeder
router.get('/seed', adminController.seedData);

// Data Ingestion (CSV Upload to DB)
router.post('/ingest', adminController.ingestData);

// Client Data Export
router.get('/export', adminController.exportData);

module.exports = router;
