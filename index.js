const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const app = express();

// Increase timeout limits for 100MB uploads
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

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('⚠️ WARNING: MONGODB_URI not set! Games will not persist.');
  console.log('Set MONGODB_URI in Render environment variables.');
}

let db = null;
let gridFSBucket = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.log('Skipping MongoDB connection - using in-memory storage only');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    db = mongoose.connection;
    gridFSBucket = new GridFSBucket(db.getClient().db('gamevault'));
    console.log('✅ Connected to MongoDB with GridFS (supports 100MB+ files)');
    
    // Load existing games
    loadGamesFromDB();
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('Games will be stored in memory only (will not persist on restart)');
  }
}

// Game Schema (stores metadata only - HTML is in GridFS)
const gameSchema = new mongoose.Schema({
  id: Number,
  name: String,
  description: String,
  uploader: String,
  category: String,
  customSettings: String,
  icon: String,
  uploadDate: String,
  downloads: Number,
  timestamp: Number,
  htmlFileId: mongoose.Schema.Types.ObjectId, // Reference to GridFS file
  uploaderToken: String,
});

let Game = null;

if (MONGODB_URI) {
  Game = mongoose.model('Game', gameSchema);
}

// In-memory fallback for HTML content
let allFiles = [];
let nextId = 1;

async function loadGamesFromDB() {
  if (!Game) {
    console.log('📂 Using in-memory storage (no MongoDB)');
    return;
  }

  try {
    const games = await Game.find().sort({ id: 1 });
    allFiles = games.map(g => g.toObject());
    nextId = allFiles.length > 0 ? Math.max(...allFiles.map(g => g.id)) + 1 : 1;
    console.log(`📂 Loaded ${allFiles.length} games from MongoDB`);
  } catch (err) {
    console.error('Error loading games from MongoDB:', err);
  }
}

async function saveGamesToDB(game) {
  if (!Game) {
    console.log('⚠️ MongoDB not connected - game only saved in memory');
    return;
  }

  try {
    await Game.findOneAndUpdate(
      { id: game.id },
      game,
      { upsert: true, new: true }
    );
    console.log(`💾 Game metadata saved to MongoDB: ${game.name}`);
  } catch (err) {
    console.error('Error saving game to MongoDB:', err);
  }
}

async function deleteGameFromDB(gameId) {
  if (!Game || !gridFSBucket) return;

  try {
    const game = await Game.findOne({ id: gameId });
    if (game && game.htmlFileId) {
      // Delete file from GridFS
      await gridFSBucket.delete(game.htmlFileId);
      console.log(`🗑️ HTML file deleted from GridFS`);
    }
    // Delete metadata
    await Game.deleteOne({ id: gameId });
    console.log(`🗑️ Game deleted from MongoDB (ID: ${gameId})`);
  } catch (err) {
    console.error('Error deleting game from MongoDB:', err);
  }
}

// Utility function to generate a unique token
function generateToken() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Active players tracking
const activeSessions = new Map();

function cleanupInactiveSessions() {
  const now = Date.now();
  const timeout = 15000;
  
  for (const [sessionId, timestamp] of activeSessions) {
    if (now - timestamp > timeout) {
      activeSessions.delete(sessionId);
    }
  }
}

setInterval(cleanupInactiveSessions, 10000);

// Setup file upload with memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

// HOME: Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// UPLOAD: When someone uploads a file
app.post('/api/upload', upload.single('file'), async (req, res) => {
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
  
  if (!req.file || !req.file.buffer) {
    console.error('File buffer not available:', req.file);
    return res.status(400).json({ error: 'File processing failed' });
  }

  let iconBase64 = null;
  if (req.body.iconData) {
    try {
      if (req.body.iconData.includes(',')) {
        iconBase64 = req.body.iconData.split(',')[1];
      } else {
        iconBase64 = req.body.iconData;
      }
      // Limit icon to 1MB
      if (iconBase64.length > 1024 * 1024) {
        console.warn('Icon too large, skipping');
        iconBase64 = null;
      }
    } catch (err) {
      console.error('Icon processing error:', err);
      iconBase64 = null;
    }
  }

  let htmlContent = '';
  try {
    htmlContent = req.file.buffer.toString('utf-8');
  } catch (err) {
    console.error('Error converting file buffer:', err);
    return res.status(400).json({ error: 'Could not process HTML file' });
  }

  const uploaderToken = generateToken();
  
  // Create game metadata object
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
    uploaderToken: uploaderToken
  };

  // If MongoDB is connected, save to GridFS
  if (gridFSBucket && Game) {
    try {
      // Upload HTML content to GridFS
      const uploadStream = gridFSBucket.openUploadStream(`game-${nextId}.html`, {
        metadata: { gameId: nextId, gameName: gameName }
      });

      uploadStream.end(htmlContent, async (err) => {
        if (err) {
          console.error('GridFS upload failed:', err);
          return res.status(500).json({ error: 'Failed to save game file' });
        }

        newFile.htmlFileId = uploadStream.id;
        
        // Save metadata to MongoDB
        await saveGamesToDB(newFile);
        
        // Also store in memory for quick access
        allFiles.push(newFile);
        nextId++;

        console.log(`✅ Game uploaded successfully: ${newFile.name} (${(req.file.buffer.length / 1024 / 1024).toFixed(2)}MB)`);
        
        res.json({ 
          success: true, 
          file: newFile,
          uploaderToken: uploaderToken,
          message: 'Game uploaded successfully!'
        });
      });
    } catch (err) {
      console.error('GridFS error:', err);
      return res.status(500).json({ error: 'Failed to save game' });
    }
  } else {
    // Fallback: store HTML in memory if MongoDB not available
    newFile.htmlContent = htmlContent;
    allFiles.push(newFile);
    nextId++;

    console.log(`✅ Game uploaded (memory only): ${newFile.name}`);
    
    res.json({ 
      success: true, 
      file: newFile,
      uploaderToken: uploaderToken,
      message: 'Game uploaded successfully! (stored in memory)'
    });
  }
});

// GET ALL: Show all uploaded files
app.get('/api/files', (req, res) => {
  console.log(`📋 Fetching ${allFiles.length} games`);
  res.json(allFiles);
});

// HEARTBEAT: Track active players
app.post('/api/heartbeat', (req, res) => {
  const sessionId = req.body.sessionId;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  
  activeSessions.set(sessionId, Date.now());
  cleanupInactiveSessions();
  
  res.json({ success: true, activePlayers: activeSessions.size });
});

// GET ACTIVE PLAYERS: Return current player count
app.get('/api/active-players', (req, res) => {
  cleanupInactiveSessions();
  const count = activeSessions.size;
  
  console.log(`👥 Current active players: ${count}`);
  res.json({ count });
});

// VIEW: Display HTML file in browser
app.get('/api/view/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    console.log(`👁️ View request for game ID: ${fileId}`);
    
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      console.error(`❌ Game not found with ID: ${fileId}`);
      return res.status(404).send('<h1 style="color:#ef4444;">Game not found</h1>');
    }

    let htmlContent = file.htmlContent; // From memory storage
    
    // If stored in GridFS, retrieve from there
    if (file.htmlFileId && gridFSBucket) {
      try {
        const downloadStream = gridFSBucket.openDownloadStream(file.htmlFileId);
        let content = '';
        
        downloadStream.on('data', (chunk) => {
          content += chunk.toString('utf-8');
        });
        
        downloadStream.on('end', () => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline');
          res.send(content);
        });
        
        downloadStream.on('error', () => {
          res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
        });
      } catch (err) {
        res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
      }
    } else if (htmlContent) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline');
      res.send(htmlContent);
    } else {
      console.error(`❌ No HTML content for game: ${file.name}`);
      return res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
    }
  } catch (err) {
    console.error('View error:', err);
    res.status(500).send('<h1 style="color:#ef4444;">Error loading game</h1>');
  }
});

// DOWNLOAD: Download the HTML file
app.get('/api/download/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'Game not found' });
    }

    let htmlContent = file.htmlContent;
    
    // If stored in GridFS, retrieve from there
    if (file.htmlFileId && gridFSBucket) {
      try {
        const downloadStream = gridFSBucket.openDownloadStream(file.htmlFileId);
        let content = '';
        
        downloadStream.on('data', (chunk) => {
          content += chunk.toString('utf-8');
        });
        
        downloadStream.on('end', () => {
          file.downloads++;
          saveGamesToDB(file);
          
          console.log(`📥 Downloading: ${file.name}`);
          
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${file.name}.html"`);
          res.send(content);
        });
        
        downloadStream.on('error', () => {
          res.status(404).json({ error: 'Game file not found' });
        });
      } catch (err) {
        res.status(404).json({ error: 'Game file not found' });
      }
    } else if (htmlContent) {
      file.downloads++;
      saveGamesToDB(file);

      console.log(`📥 Downloading: ${file.name}`);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.name}.html"`);
      res.send(htmlContent);
    } else {
      return res.status(404).json({ error: 'Game file not found' });
    }
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// DELETE: Remove a game (only uploader can delete)
app.delete('/api/delete/:id', (req, res) => {
  try {
    console.log(`🗑️ Delete request for game ID: ${req.params.id}`);
    
    const fileId = parseInt(req.params.id);
    const uploaderToken = req.body.uploaderToken;
    
    console.log(`Checking uploader token...`);
    
    const fileIndex = allFiles.findIndex(f => f.id === fileId);
    
    if (fileIndex === -1) {
      console.log(`❌ Game not found`);
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const file = allFiles[fileIndex];
    console.log(`Found game: ${file.name}`);
    
    if (!uploaderToken || uploaderToken !== file.uploaderToken) {
      console.log('❌ Delete attempt with wrong token');
      return res.status(401).json({ error: 'Invalid token - you did not upload this game' });
    }
    
    console.log(`✅ Token correct, deleting game`);
    
    // Remove from memory
    allFiles.splice(fileIndex, 1);
    
    // Delete from MongoDB/GridFS
    deleteGameFromDB(fileId);
    
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Max size is 100MB.' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'File upload error: ' + err.message });
  }
  
  res.status(500).json({ 
    error: 'Server error: ' + (err.message || 'Unknown error') 
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, async () => {
  console.log(`\n🎮 GameVault running on port ${PORT}`);
  
  // Connect to MongoDB with GridFS
  await connectDB();
  
  console.log(`📊 Games loaded: ${allFiles.length}\n`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close();
  if (db) {
    mongoose.connection.close();
  }
});
