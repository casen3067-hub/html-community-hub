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

// ADMIN PASSWORD FOR DELETING GAMES (Change this to your secret password!)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// Setup file upload with memory storage (so we can store in database)
const upload = multer({
  storage: multer.memoryStorage(),
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
  
  // Check if file buffer is available
  if (!req.file || !req.file.buffer) {
    console.error('File buffer not available:', req.file);
    return res.status(400).json({ error: 'File processing failed - no file buffer' });
  }

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
  let htmlContent = '';
  try {
    htmlContent = req.file.buffer.toString('utf-8');
  } catch (err) {
    console.error('Error converting file buffer:', err);
    return res.status(400).json({ error: 'Could not process HTML file' });
  }

  const newFile = {
    id: nextId,
    name: gameName,
    description: req.body.description || 'No description',
    uploader: req.body.uploader || 'Anonymous',
    category: req.body.category || 'other',
    customSettings: req.body.customSettings || '',
    icon: iconBase64,
    uploadDate: new Date().toLocaleDateString(),
    downloads: 0,
    timestamp: Date.now(),
    // Store the actual HTML file content in the database
    htmlContent: htmlContent
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
  try {
    const fileId = parseInt(req.params.id);
    console.log(`👁️ View request for game ID: ${fileId}`);
    
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      console.error(`❌ Game not found with ID: ${fileId}`);
      return res.status(404).send('<h1 style="color:#ef4444;">Game not found</h1>');
    }

    if (!file.htmlContent) {
      console.error(`❌ No HTML content for game: ${file.name}`);
      return res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
    }

    console.log(`✅ Serving game: ${file.name}`);
    
    // Set header to display as HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    
    res.send(file.htmlContent);
  } catch (err) {
    console.error('View error:', err);
    res.status(500).send('<h1 style="color:#ef4444;">Error loading game</h1>');
  }
});

// DOWNLOAD: Download the HTML file
app.get('/api/download/:id', (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (!file.htmlContent) {
      return res.status(404).json({ error: 'Game file not found' });
    }

    file.downloads++;
    saveDatabase();

    console.log(`📥 Downloading: ${file.name}`);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}.html"`);
    res.send(file.htmlContent);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// DELETE: Remove a game (admin only)
app.delete('/api/delete/:id', (req, res) => {
  try {
    console.log(`🗑️ Delete request for game ID: ${req.params.id}`);
    console.log(`📊 Current games in database: ${allFiles.length}`);
    
    const fileId = parseInt(req.params.id);
    const password = req.body.password;
    
    console.log(`Checking password...`);
    
    // Check admin password
    if (!password || password !== ADMIN_PASSWORD) {
      console.log('❌ Delete attempt with wrong password');
      return res.status(401).json({ error: 'Invalid admin password' });
    }
    
    console.log(`✅ Password correct, looking for game ID: ${fileId}`);
    
    // Find the game
    const fileIndex = allFiles.findIndex(f => f.id === fileId);
    
    console.log(`Found at index: ${fileIndex}, Total games: ${allFiles.length}`);
    
    if (fileIndex === -1) {
      console.log(`❌ Game not found. Available IDs: ${allFiles.map(f => f.id).join(', ')}`);
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const file = allFiles[fileIndex];
    console.log(`Found game: ${file.name}`);
    
    // Remove from database (no need to delete from disk since we store in DB)
    allFiles.splice(fileIndex, 1);
    saveDatabase();
    
    console.log(`✅ Game deleted: ${file.name} (ID: ${fileId})`);
    
    res.json({ 
      success: true, 
      message: 'Game deleted successfully!'
    });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Error handling middleware (must be AFTER all routes)
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  
  // Handle multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Max size is 100MB.' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'File upload error: ' + err.message });
  }
  
  // Handle other errors
  res.status(500).json({ 
    error: 'Server error: ' + (err.message || 'Unknown error') 
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
