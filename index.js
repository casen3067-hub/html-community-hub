const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const app = express();

// ===== ADMIN EMAIL - ONLY THIS EMAIL GETS ADMIN PRIVILEGES =====
const ADMIN_EMAIL = 'casen3067@gmail.com';

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

// ===== SCHEMAS =====

// Game Schema
const gameSchema = new mongoose.Schema({
  id: Number,
  name: String,
  description: String,
  uploader: String,
  uploaderEmail: String,
  category: String,
  customSettings: String,
  icon: String,
  uploadDate: String,
  downloads: Number,
  views: Number,
  timestamp: Number,
  htmlFileId: mongoose.Schema.Types.ObjectId,
  uploaderToken: String,
  tags: [String],
  fileSize: Number,
  playTime: Number,
  avgRating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  isPasswordProtected: { type: Boolean, default: false },
  password: String,
  accessCode: String,
});

// Rating Schema
const ratingSchema = new mongoose.Schema({
  gameId: Number,
  userId: String,
  rating: Number, // 1-5 stars
  timestamp: { type: Date, default: Date.now },
});

// Comment Schema
const commentSchema = new mongoose.Schema({
  gameId: Number,
  userName: String,
  userEmail: String,
  comment: String,
  timestamp: { type: Date, default: Date.now },
});

// Favorites Schema
const favoriteSchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  timestamp: { type: Date, default: Date.now },
});

// View History Schema
const viewHistorySchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  timestamp: { type: Date, default: Date.now },
});

// Play Time Schema
const playTimeSchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  playDuration: Number, // in milliseconds
  timestamp: { type: Date, default: Date.now },
});

let Game, Rating, Comment, Favorite, ViewHistory, PlayTime;

if (MONGODB_URI) {
  Game = mongoose.model('Game', gameSchema);
  Rating = mongoose.model('Rating', ratingSchema);
  Comment = mongoose.model('Comment', commentSchema);
  Favorite = mongoose.model('Favorite', favoriteSchema);
  ViewHistory = mongoose.model('ViewHistory', viewHistorySchema);
  PlayTime = mongoose.model('PlayTime', playTimeSchema);
}

// In-memory fallback
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
      await gridFSBucket.delete(game.htmlFileId);
      console.log(`🗑️ HTML file deleted from GridFS`);
    }
    await Game.deleteOne({ id: gameId });
    // Also delete associated ratings, comments, favorites
    if (Rating) await Rating.deleteMany({ gameId });
    if (Comment) await Comment.deleteMany({ gameId });
    if (Favorite) await Favorite.deleteMany({ gameId });
    if (ViewHistory) await ViewHistory.deleteMany({ gameId });
    if (PlayTime) await PlayTime.deleteMany({ gameId });
    console.log(`🗑️ Game deleted from MongoDB (ID: ${gameId})`);
  } catch (err) {
    console.error('Error deleting game from MongoDB:', err);
  }
}

// Utility functions
function generateToken() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isAdmin(email) {
  return email === ADMIN_EMAIL;
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

// File upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

// ===== ROUTES =====

// HOME
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// UPLOAD GAME
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
  const tags = req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : [];
  
  const newFile = {
    id: nextId,
    name: gameName,
    description: req.body.description || 'No description',
    uploader: req.body.uploader || 'Anonymous',
    uploaderEmail: req.body.uploaderEmail || '',
    category: req.body.category || 'other',
    customSettings: req.body.customSettings || '',
    icon: iconBase64,
    uploadDate: new Date().toLocaleDateString(),
    downloads: 0,
    views: 0,
    timestamp: Date.now(),
    uploaderToken: uploaderToken,
    tags: tags,
    fileSize: req.file.buffer.length,
    playTime: 0,
    avgRating: 0,
    ratingCount: 0,
    isPasswordProtected: req.body.isPasswordProtected === 'true',
    password: req.body.isPasswordProtected === 'true' ? req.body.password : null,
    accessCode: generateToken().substring(0, 8).toUpperCase(),
  };

  if (gridFSBucket && Game) {
    try {
      const uploadStream = gridFSBucket.openUploadStream(`game-${nextId}.html`, {
        metadata: { gameId: nextId, gameName: gameName }
      });

      uploadStream.end(htmlContent, async (err) => {
        if (err) {
          console.error('GridFS upload failed:', err);
          return res.status(500).json({ error: 'Failed to save game file' });
        }

        newFile.htmlFileId = uploadStream.id;
        await saveGamesToDB(newFile);
        allFiles.push(newFile);
        nextId++;

        console.log(`✅ Game uploaded successfully: ${newFile.name}`);
        
        res.json({ 
          success: true, 
          file: newFile,
          uploaderToken: uploaderToken,
          accessCode: newFile.accessCode,
          message: 'Game uploaded successfully!'
        });
      });
    } catch (err) {
      console.error('GridFS error:', err);
      return res.status(500).json({ error: 'Failed to save game' });
    }
  } else {
    newFile.htmlContent = htmlContent;
    allFiles.push(newFile);
    nextId++;

    console.log(`✅ Game uploaded (memory only): ${newFile.name}`);
    
    res.json({ 
      success: true, 
      file: newFile,
      uploaderToken: uploaderToken,
      accessCode: newFile.accessCode,
      message: 'Game uploaded successfully! (stored in memory)'
    });
  }
});

// GET ALL GAMES
app.get('/api/files', async (req, res) => {
  console.log(`📋 Fetching ${allFiles.length} games`);
  
  // Calculate average ratings
  if (Rating) {
    try {
      const ratings = await Rating.find();
      allFiles.forEach(game => {
        const gameRatings = ratings.filter(r => r.gameId === game.id);
        if (gameRatings.length > 0) {
          game.avgRating = (gameRatings.reduce((sum, r) => sum + r.rating, 0) / gameRatings.length).toFixed(1);
          game.ratingCount = gameRatings.length;
        }
      });
    } catch (err) {
      console.error('Error fetching ratings:', err);
    }
  }
  
  res.json(allFiles);
});

// GET GAME STATS
app.get('/api/game-stats/:id', async (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const game = allFiles.find(f => f.id === gameId);
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    let stats = {
      id: game.id,
      name: game.name,
      downloads: game.downloads,
      views: game.views,
      fileSize: game.fileSize,
      uploadDate: game.uploadDate,
      avgRating: game.avgRating || 0,
      ratingCount: game.ratingCount || 0,
      commentCount: 0,
      favoriteCount: 0,
    };

    if (Comment) {
      const comments = await Comment.find({ gameId });
      stats.commentCount = comments.length;
    }
    if (Favorite) {
      const favorites = await Favorite.find({ gameId });
      stats.favoriteCount = favorites.length;
    }

    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

// SEARCH GAMES
app.get('/api/search', (req, res) => {
  const query = req.query.q?.toLowerCase() || '';
  
  if (!query) {
    return res.json(allFiles);
  }

  const results = allFiles.filter(game => 
    game.name.toLowerCase().includes(query) ||
    game.description.toLowerCase().includes(query) ||
    (game.tags && game.tags.some(tag => tag.toLowerCase().includes(query)))
  );

  console.log(`🔍 Search for "${query}" returned ${results.length} results`);
  res.json(results);
});

// GET TRENDING GAMES
app.get('/api/trending', (req, res) => {
  const trending = [...allFiles].sort((a, b) => {
    const scoreA = (a.views || 0) * 0.6 + (a.downloads || 0) * 0.3 + (a.ratingCount || 0) * 0.1;
    const scoreB = (b.views || 0) * 0.6 + (b.downloads || 0) * 0.3 + (b.ratingCount || 0) * 0.1;
    return scoreB - scoreA;
  }).slice(0, 10);

  res.json(trending);
});

// GET MOST RECENT GAMES
app.get('/api/recent', (req, res) => {
  const recent = [...allFiles].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  res.json(recent);
});

// RATE A GAME
app.post('/api/rate', async (req, res) => {
  try {
    const { gameId, rating, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    if (Rating) {
      // Remove old rating from this user for this game
      await Rating.deleteOne({ gameId, userId });
      
      // Add new rating
      const newRating = new Rating({ gameId, userId, rating });
      await newRating.save();

      // Update game average rating
      const ratings = await Rating.find({ gameId });
      if (ratings.length > 0) {
        const avg = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
        const game = allFiles.find(f => f.id === gameId);
        if (game) {
          game.avgRating = parseFloat(avg.toFixed(1));
          game.ratingCount = ratings.length;
          await saveGamesToDB(game);
        }
      }

      console.log(`⭐ Game ${gameId} rated ${rating} stars by ${userId}`);
      res.json({ success: true, message: 'Rating saved' });
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    console.error('Rating error:', err);
    res.status(500).json({ error: 'Error saving rating' });
  }
});

// POST COMMENT
app.post('/api/comment', async (req, res) => {
  try {
    const { gameId, userName, userEmail, comment } = req.body;

    if (!comment || !userName) {
      return res.status(400).json({ error: 'Comment and name required' });
    }

    if (Comment) {
      const newComment = new Comment({ gameId, userName, userEmail, comment });
      await newComment.save();

      console.log(`💬 Comment added to game ${gameId} by ${userName}`);
      res.json({ success: true, message: 'Comment saved' });
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    console.error('Comment error:', err);
    res.status(500).json({ error: 'Error saving comment' });
  }
});

// GET COMMENTS FOR GAME
app.get('/api/comments/:gameId', async (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);

    if (Comment) {
      const comments = await Comment.find({ gameId }).sort({ timestamp: -1 });
      res.json(comments);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.json([]);
  }
});

// ADD TO FAVORITES
app.post('/api/favorite', async (req, res) => {
  try {
    const { gameId, sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    if (Favorite) {
      // Check if already favorited
      const existing = await Favorite.findOne({ gameId, sessionId });
      
      if (existing) {
        // Remove from favorites
        await Favorite.deleteOne({ gameId, sessionId });
        res.json({ success: true, favorited: false });
      } else {
        // Add to favorites
        const newFav = new Favorite({ gameId, sessionId });
        await newFav.save();
        res.json({ success: true, favorited: true });
      }
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    console.error('Favorite error:', err);
    res.status(500).json({ error: 'Error updating favorites' });
  }
});

// GET FAVORITES
app.get('/api/favorites/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    if (Favorite) {
      const favorites = await Favorite.find({ sessionId });
      const favoriteIds = favorites.map(f => f.gameId);
      res.json(favoriteIds);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error('Error fetching favorites:', err);
    res.json([]);
  }
});

// TRACK VIEW
app.post('/api/track-view', async (req, res) => {
  try {
    const { gameId, sessionId } = req.body;

    const game = allFiles.find(f => f.id === gameId);
    if (game) {
      game.views = (game.views || 0) + 1;
      await saveGamesToDB(game);
    }

    if (ViewHistory) {
      const newView = new ViewHistory({ gameId, sessionId });
      await newView.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('View tracking error:', err);
    res.status(500).json({ error: 'Error tracking view' });
  }
});

// TRACK PLAY TIME
app.post('/api/track-playtime', async (req, res) => {
  try {
    const { gameId, sessionId, playDuration } = req.body;

    if (PlayTime) {
      const newPlayTime = new PlayTime({ gameId, sessionId, playDuration });
      await newPlayTime.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Play time tracking error:', err);
    res.status(500).json({ error: 'Error tracking play time' });
  }
});

// HEARTBEAT
app.post('/api/heartbeat', (req, res) => {
  const sessionId = req.body.sessionId;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  
  activeSessions.set(sessionId, Date.now());
  cleanupInactiveSessions();
  
  res.json({ success: true, activePlayers: activeSessions.size });
});

// GET ACTIVE PLAYERS
app.get('/api/active-players', (req, res) => {
  cleanupInactiveSessions();
  const count = activeSessions.size;
  
  console.log(`👥 Current active players: ${count}`);
  res.json({ count });
});

// VIEW GAME
app.get('/api/view/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    console.log(`👁️ View request for game ID: ${fileId}`);
    
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      console.error(`❌ Game not found with ID: ${fileId}`);
      return res.status(404).send('<h1 style="color:#ef4444;">Game not found</h1>');
    }

    let htmlContent = file.htmlContent;
    
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

// DOWNLOAD GAME
app.get('/api/download/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = allFiles.find(f => f.id === fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'Game not found' });
    }

    let htmlContent = file.htmlContent;
    
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

// DELETE GAME
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
    
    allFiles.splice(fileIndex, 1);
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

// EDIT GAME (Admin only)
app.put('/api/edit/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const { uploaderEmail, uploaderToken, name, description, tags } = req.body;

    if (!isAdmin(uploaderEmail)) {
      return res.status(401).json({ error: 'Admin only' });
    }

    const fileIndex = allFiles.findIndex(f => f.id === fileId);
    
    if (fileIndex === -1) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const file = allFiles[fileIndex];

    if (uploaderToken !== file.uploaderToken) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Update fields
    if (name) file.name = name;
    if (description) file.description = description;
    if (tags) file.tags = tags.split(',').map(t => t.trim());

    await saveGamesToDB(file);
    
    console.log(`✏️ Game edited: ${file.name}`);
    res.json({ success: true, message: 'Game updated successfully!' });
  } catch (err) {
    console.error('Edit error:', err);
    res.status(500).json({ error: 'Error editing game' });
  }
});

// GET DEVELOPER DASHBOARD (Admin only)
app.get('/api/dashboard/:email', async (req, res) => {
  try {
    const email = req.params.email;

    if (!isAdmin(email)) {
      return res.status(401).json({ error: 'Admin only' });
    }

    const stats = {
      totalGames: allFiles.length,
      totalDownloads: allFiles.reduce((sum, g) => sum + (g.downloads || 0), 0),
      totalViews: allFiles.reduce((sum, g) => sum + (g.views || 0), 0),
      games: allFiles.map(g => ({
        id: g.id,
        name: g.name,
        downloads: g.downloads,
        views: g.views,
        avgRating: g.avgRating,
        ratingCount: g.ratingCount,
      })),
    };

    res.json(stats);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Error fetching dashboard' });
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
  console.log(`🔐 Admin email: ${ADMIN_EMAIL}`);
  
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
