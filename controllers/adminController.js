// File: controllers/adminController.js

const Respondent = require('../models/Respondent');

exports.seedData = async (req, res) => {
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
};

exports.ingestData = async (req, res) => {
  try {
    const records = req.body; 
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'Valid JSON array of records required.' });
    }

    const sanitizePhone = (phone) => {
      if (!phone) return null;
      let cleaned = phone.toString().replace(/[\s\-\(\)]/g, ''); 
      if (/^\d{10}$/.test(cleaned)) {
        cleaned = '+91' + cleaned;
      } else if (!cleaned.startsWith('+') && /^\d+$/.test(cleaned)) {
        cleaned = '+' + cleaned;
      }
      return cleaned;
    };

    const toTitleCase = (str) => {
      if (!str) return str;
      return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    };

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

    const result = await Respondent.insertMany(enrichedRecords, { ordered: false }).catch(err => {
      return err.insertedDocs; 
    });

    res.status(201).json({ message: `Successfully enriched and ingested ${result ? result.length : 0} new respondents.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.exportData = async (req, res) => {
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
};
