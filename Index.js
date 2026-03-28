const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve uploaded HTML files as static files (so they display, not download)
app.use('/uploads', express.static('uploads'));

// Create uploads folder if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Setup file upload
const upload = multer({ dest: 'uploads/' });

// This stores files in memory
let allFiles = [];
let nextId = 1;

// HOME: Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// UPLOAD: When someone uploads a file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Save file info
  const newFile = {
    id: nextId,
    name: req.body.name,
    description: req.body.description,
    uploader: req.body.uploader,
    filename: req.file.filename,
    uploadDate: new Date().toLocaleDateString(),
    downloads: 0
  };

  allFiles.push(newFile);
  nextId++;

  console.log(`✅ File uploaded: ${newFile.name}`);
  res.json({ success: true, file: newFile });
});

// GET ALL: Show all uploaded files
app.get('/api/files', (req, res) => {
  res.json(allFiles);
});

// VIEW: Display HTML file in browser (NOT download)
app.get('/api/view/:id', (req, res) => {
  const file = allFiles.find(f => f.id == req.params.id);
  if (!file) {
    return res.status(404).send('File not found');
  }

  const filePath = path.join(__dirname, 'uploads', file.filename);
  
  // Set header to display as HTML, not download
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline');
  
  res.sendFile(filePath);
});

// DOWNLOAD: Download the HTML file
app.get('/api/download/:id', (req, res) => {
  const file = allFiles.find(f => f.id == req.params.id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  file.downloads++;
  const filePath = path.join(__dirname, 'uploads', file.filename);
  res.download(filePath, file.name + '.html');
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});