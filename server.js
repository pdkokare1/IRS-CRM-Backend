// File: server.js

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors()); // Allows your Vercel frontend to make requests here
// Increased payload limit to 50mb to support bulk CSV uploads
app.use(express.json({ limit: '50mb' })); // Parses incoming JSON data

// Temporary Mock Auth Middleware (Until Firebase Admin is connected)
// This ensures req.user.uid exists so our routes don't crash during early testing
app.use((req, res, next) => {
  req.user = { uid: 'mock-associate-uid-123' };
  next();
});

// Mount Routes
const associateRoutes = require('./routes/associateRoutes');
const adminRoutes = require('./routes/adminRoutes'); // NEW: Admin routes imported

app.use('/api/associate', associateRoutes);
app.use('/api/admin', adminRoutes); // NEW: Admin routes mounted

// Root route for health check
app.get('/', (req, res) => {
  res.send('IRS-CRM Backend is running.');
});

const PORT = process.env.PORT || 8080;

// Database Connection & Server Start
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB Database');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
  });
