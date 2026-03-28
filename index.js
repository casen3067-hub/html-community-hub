const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve uploaded HTML files as static files
app.use('/uploads', express.static('uploads'));

// Create necessary folders
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// DATABASE FILE PATH
const DB_FILE = path.join(__dirname, 'games-database.json');

// Setup file upload
const upload = multer({ dest: 'uploads/' });

// Load games from database file
let allFiles = [];
let nextId = 1;

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      allFiles = parsed.games || [];
      nextId = parsed.nextId || 1;
      console.log(`📂 Loaded ${allFiles.length} games from database`);
    }
  } catch (err) {
    console.error('Error loading database:', err);
    allFiles = [];
    nextId = 1;
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({ games: allFiles, nextId }, null, 2));
    console.log('💾 Database saved');
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

// Load games on startup
loadDatabase();

// HOME: Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// UPLOAD: When someone uploads a file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No HTML file uploaded' });
  }

  if (!req.body.name) {
    return res.status(400).json({ error: 'Game name is required' });
  }

  // Get icon from request body
  let iconBase64 = null;
  if (req.body.iconData) {
    // If it's a data URI, extract the base64 part
    if (req.body.iconData.includes(',')) {
      iconBase64 = req.body.iconData.split(',')[1];
    } else {
      iconBase64 = req.body.iconData;
    }
  }

  // Save file info
  const newFile = {
    id: nextId,
    name: req.body.name || 'Unnamed Game',
    description: req.body.description || 'No description',
    uploader: req.body.uploader || 'Anonymous',
    filename: req.file.filename,
    icon: iconBase64,
    uploadDate: new Date().toLocaleDateString(),
    downloads: 0
  };

  allFiles.push(newFile);
  nextId++;

  // Save to database file
  saveDatabase();

  console.log(`✅ Game uploaded: ${newFile.name}`);
  res.json({ success: true, file: newFile });
});

// GET ALL: Show all uploaded files
app.get('/api/files', (req, res) => {
  res.json(allFiles);
});

// VIEW: Display HTML file in browser
app.get('/api/view/:id', (req, res) => {
  const file = allFiles.find(f => f.id == req.params.id);
  if (!file) {
    return res.status(404).send('Game not found');
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
    return res.status(404).json({ error: 'Game not found' });
  }

  file.downloads++;
  
  // Save updated downloads to database
  saveDatabase();
  
  const filePath = path.join(__dirname, 'uploads', file.filename);
  res.download(filePath, file.name + '.html');
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🎮 GameVault running on port ${PORT}`);
  console.log(`📂 Database file: ${DB_FILE}`);
});
