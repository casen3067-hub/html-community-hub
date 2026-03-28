const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

// Increase timeout limits for faster uploads
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb' }));
app.use(cors());

// Set server timeouts
app.use((req, res, next) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
});

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

// Setup file upload with optimizations
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

// Load games from database file
let allFiles = [];
let nextId = 1;

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      allFiles = parsed.games || [];
      nextId = (parsed.nextId || 1);
      console.log(`📂 Loaded ${allFiles.length} games from database`);
    } else {
      console.log('📂 No database file found, starting fresh');
      allFiles = [];
      nextId = 1;
    }
  } catch (err) {
    console.error('Error loading database:', err);
    allFiles = [];
    nextId = 1;
  }
}

function saveDatabase() {
  try {
    const dbData = JSON.stringify({ games: allFiles, nextId }, null, 2);
    fs.writeFileSync(DB_FILE, dbData, 'utf8');
    console.log(`💾 Database saved with ${allFiles.length} games`);
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
  console.log('📥 Upload request received');
  
  if (!req.file) {
    console.error('No file received');
    return res.status(400).json({ error: 'No HTML file uploaded' });
  }

  const gameName = req.body.name || 'Unnamed Game';
  
  if (!gameName) {
    return res.status(400).json({ error: 'Game name is required' });
  }

  console.log(`⏳ Processing upload for: ${gameName}`);

  // Get icon from request body
  let iconBase64 = null;
  if (req.body.iconData) {
    try {
      if (req.body.iconData.includes(',')) {
        iconBase64 = req.body.iconData.split(',')[1];
      } else {
        iconBase64 = req.body.iconData;
      }
    } catch (err) {
      console.error('Icon processing error:', err);
      // Continue without icon
    }
  }

  // Save file info
  const newFile = {
    id: nextId,
    name: gameName,
    description: req.body.description || 'No description',
    uploader: req.body.uploader || 'Anonymous',
    filename: req.file.filename,
    originalName: req.file.originalname,
    icon: iconBase64,
    uploadDate: new Date().toLocaleDateString(),
    downloads: 0,
    timestamp: Date.now()
  };

  allFiles.push(newFile);
  nextId++;

  // Save to database file immediately
  saveDatabase();

  console.log(`✅ Game uploaded successfully: ${newFile.name} (ID: ${newFile.id})`);
  
  // Return success with the file data
  res.json({ 
    success: true, 
    file: newFile,
    message: 'Game uploaded successfully!'
  });
});

// GET ALL: Show all uploaded files
app.get('/api/files', (req, res) => {
  console.log(`📋 Fetching ${allFiles.length} games`);
  res.json(allFiles);
});

// VIEW: Display HTML file in browser
app.get('/api/view/:id', (req, res) => {
  const fileId = parseInt(req.params.id);
  const file = allFiles.find(f => f.id === fileId);
  
  if (!file) {
    console.error(`❌ Game not found with ID: ${fileId}`);
    console.log('Available games:', allFiles.map(f => f.id).join(', '));
    return res.status(404).send('Game not found');
  }

  const filePath = path.join(__dirname, 'uploads', file.filename);
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found at: ${filePath}`);
    return res.status(404).send('Game file not found on disk');
  }

  console.log(`👁️ Viewing game: ${file.name}`);
  
  // Set header to display as HTML, not download
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline');
  
  res.sendFile(filePath);
});

// DOWNLOAD: Download the HTML file
app.get('/api/download/:id', (req, res) => {
  const fileId = parseInt(req.params.id);
  const file = allFiles.find(f => f.id === fileId);
  
  if (!file) {
    return res.status(404).json({ error: 'Game not found' });
  }

  file.downloads++;
  saveDatabase();
  
  const filePath = path.join(__dirname, 'uploads', file.filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Game file not found' });
  }

  console.log(`📥 Downloading: ${file.name}`);
  res.download(filePath, file.name + '.html');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ 
    error: 'Server error: ' + err.message 
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`\n🎮 GameVault running on port ${PORT}`);
  console.log(`📂 Database file: ${DB_FILE}`);
  console.log(`📊 Games loaded: ${allFiles.length}\n`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  saveDatabase();
  server.close();
});
