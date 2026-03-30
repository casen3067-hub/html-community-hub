const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const app = express();

// ===== ADMIN PASSWORD =====
const ADMIN_PASSWORD = 'Tiu2mc3y!!!';

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb' }));
app.use(cors());

app.use((req, res, next) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
});

app.use(express.static(__dirname));

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
    await loadGamesFromDB();
    console.log(`✅ Games ready to serve: ${allFiles.length} games available`);
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('Games will be stored in memory only (will not persist on restart)');
  }
}

// ===== SCHEMAS =====

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
  adminOnly: { type: Boolean, default: false },
});

const ratingSchema = new mongoose.Schema({
  gameId: Number,
  userId: String,
  rating: Number,
  timestamp: { type: Date, default: Date.now },
});

const commentSchema = new mongoose.Schema({
  gameId: Number,
  userName: String,
  userEmail: String,
  comment: String,
  timestamp: { type: Date, default: Date.now },
});

const favoriteSchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  timestamp: { type: Date, default: Date.now },
});

const viewHistorySchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  timestamp: { type: Date, default: Date.now },
});

const playTimeSchema = new mongoose.Schema({
  sessionId: String,
  gameId: Number,
  playDuration: Number,
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

let allFiles = [];
let nextId = 1;

async function loadGamesFromDB() {
  if (!Game) {
    console.log('📂 Using in-memory storage (no MongoDB)');
    return;
  }

  try {
    console.log('🔍 Querying MongoDB for games...');
    const games = await Game.find().sort({ id: 1 });
    console.log(`   Found ${games.length} game documents in database`);
    allFiles = games.map(g => g.toObject());
    nextId = allFiles.length > 0 ? Math.max(...allFiles.map(g => g.id)) + 1 : 1;
    console.log(`✅ Loaded ${allFiles.length} games from MongoDB`);
  } catch (err) {
    console.error('❌ Error loading games from MongoDB:', err.message);
  }
}

async function saveGamesToDB(game) {
  if (!Game) return;
  try {
    await Game.findOneAndUpdate({ id: game.id }, game, { upsert: true, new: true });
    console.log(`💾 Game saved to MongoDB: ${game.name}`);
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

function generateToken() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isAdmin(password) {
  return password === ADMIN_PASSWORD;
}

// Active players tracking
const activeSessions = new Map();
const bannedPlayers = new Map(); // playerId -> { playerId, username, reason, bannedAt }

function cleanupInactiveSessions() {
  const now = Date.now();
  const timeout = 15000;
  for (const [sessionId, playerData] of activeSessions) {
    const lastActivity = playerData.timestamp || playerData;
    if (now - lastActivity > timeout) {
      activeSessions.delete(sessionId);
      console.log(`🗑️ Cleaned up inactive session: ${sessionId}`);
    }
  }
}

setInterval(cleanupInactiveSessions, 10000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  console.log('📥 Upload request received');

  if (!req.file) return res.status(400).json({ error: 'No HTML file uploaded' });

  const gameName = req.body.name || 'Unnamed Game';
  if (!gameName) return res.status(400).json({ error: 'Game name is required' });

  console.log(`⏳ Processing upload for: ${gameName}`);

  let iconBase64 = null;
  if (req.body.iconData) {
    try {
      iconBase64 = req.body.iconData.includes(',')
        ? req.body.iconData.split(',')[1]
        : req.body.iconData;
      if (iconBase64.length > 1024 * 1024) {
        console.warn('Icon too large, skipping');
        iconBase64 = null;
      }
    } catch (err) {
      iconBase64 = null;
    }
  }

  let htmlContent = '';
  try {
    htmlContent = req.file.buffer.toString('utf-8');
  } catch (err) {
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
    adminOnly: req.body.adminOnly === 'true',
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

app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    mongodb: Game ? 'Connected' : 'Not Connected',
    gridfs: gridFSBucket ? 'Connected' : 'Not Connected',
    gamesInMemory: allFiles.length,
    nextId: nextId,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/files', async (req, res) => {
  console.log(`📋 /api/files called - Games in memory: ${allFiles.length}`);

  if (allFiles.length === 0 && Game) {
    try {
      const gamesFromDB = await Game.find();
      allFiles = gamesFromDB.map(g => g.toObject());
      console.log(`   Reloaded ${allFiles.length} games from DB`);
    } catch (err) {
      console.error('   Error reloading games:', err.message);
    }
  }

  if (Rating && allFiles.length > 0) {
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

  // Return only non-archived, non-adminOnly games to regular players
  const showAll = req.query.showAll === 'true';
  const visibleGames = showAll ? allFiles : allFiles.filter(g => !g.archived && !g.adminOnly);

  res.json(visibleGames);
});

app.get('/api/search', (req, res) => {
  const query = req.query.q?.toLowerCase() || '';
  if (!query) return res.json(allFiles);
  const results = allFiles.filter(game =>
    game.name.toLowerCase().includes(query) ||
    game.description.toLowerCase().includes(query) ||
    (game.tags && game.tags.some(tag => tag.toLowerCase().includes(query)))
  );
  res.json(results);
});

app.get('/api/trending', (req, res) => {
  const trending = [...allFiles].sort((a, b) => {
    const scoreA = (a.views || 0) * 0.6 + (a.downloads || 0) * 0.3 + (a.ratingCount || 0) * 0.1;
    const scoreB = (b.views || 0) * 0.6 + (b.downloads || 0) * 0.3 + (b.ratingCount || 0) * 0.1;
    return scoreB - scoreA;
  }).slice(0, 10);
  res.json(trending);
});

app.get('/api/recent', (req, res) => {
  const recent = [...allFiles].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  res.json(recent);
});

app.post('/api/rate', async (req, res) => {
  try {
    const { gameId, rating, userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

    if (Rating) {
      await Rating.deleteOne({ gameId, userId });
      await new Rating({ gameId, userId, rating }).save();
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
      res.json({ success: true, message: 'Rating saved' });
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error saving rating' });
  }
});

app.post('/api/comment', async (req, res) => {
  try {
    const { gameId, userName, userEmail, comment } = req.body;
    if (!comment || !userName) return res.status(400).json({ error: 'Comment and name required' });
    if (Comment) {
      await new Comment({ gameId, userName, userEmail, comment }).save();
      res.json({ success: true, message: 'Comment saved' });
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error saving comment' });
  }
});

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
    res.json([]);
  }
});

app.post('/api/favorite', async (req, res) => {
  try {
    const { gameId, sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    if (Favorite) {
      const existing = await Favorite.findOne({ gameId, sessionId });
      if (existing) {
        await Favorite.deleteOne({ gameId, sessionId });
        res.json({ success: true, favorited: false });
      } else {
        await new Favorite({ gameId, sessionId }).save();
        res.json({ success: true, favorited: true });
      }
    } else {
      res.status(500).json({ error: 'Database not available' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error updating favorites' });
  }
});

app.get('/api/favorites/:sessionId', async (req, res) => {
  try {
    if (Favorite) {
      const favorites = await Favorite.find({ sessionId: req.params.sessionId });
      res.json(favorites.map(f => f.gameId));
    } else {
      res.json([]);
    }
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/track-view', async (req, res) => {
  try {
    const { gameId, sessionId } = req.body;
    const game = allFiles.find(f => f.id === gameId);
    if (game) {
      game.views = (game.views || 0) + 1;
      await saveGamesToDB(game);
    }
    if (ViewHistory) await new ViewHistory({ gameId, sessionId }).save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error tracking view' });
  }
});

app.post('/api/track-playtime', async (req, res) => {
  try {
    const { gameId, sessionId, playDuration } = req.body;
    if (PlayTime) await new PlayTime({ gameId, sessionId, playDuration }).save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error tracking play time' });
  }
});

app.post('/api/heartbeat', (req, res) => {
  const { sessionId, playerUsername, playerId, gameId, gameName } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  // Check if player is banned
  if (playerId && bannedPlayers.has(playerId)) {
    const ban = bannedPlayers.get(playerId);
    activeSessions.delete(sessionId);
    console.log(`🚫 Banned player tried to connect: ${playerUsername} (${playerId})`);
    return res.status(403).json({ banned: true, reason: ban.reason || 'You have been banned.' });
  }

  activeSessions.set(sessionId, {
    timestamp: Date.now(),
    playerUsername: playerUsername || 'Unknown',
    playerId: playerId || sessionId,
    gameId: gameId || null,
    gameName: gameName || null
  });

  cleanupInactiveSessions();
  res.json({ success: true, activePlayers: activeSessions.size });
});

// ADMIN FILE EDITOR - Read file
app.get('/api/admin/read-file', (req, res) => {
  const { filename, adminPassword } = req.query;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const allowed = ['index.html', 'index.js'];
  if (!allowed.includes(filename)) return res.status(400).json({ error: 'File not allowed' });

  try {
    const filePath = path.join(__dirname, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`📖 Admin read file: ${filename}`);
    res.json({ success: true, content, filename });
  } catch (err) {
    res.status(500).json({ error: 'Could not read file: ' + err.message });
  }
});

// ADMIN FILE EDITOR - List versions
app.get('/api/admin/list-versions', (req, res) => {
  const { filename, adminPassword } = req.query;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const allowed = ['index.html', 'index.js'];
  if (!allowed.includes(filename)) return res.status(400).json({ error: 'File not allowed' });

  try {
    const versionsDir = path.join(__dirname, '.versions', filename);
    if (!fs.existsSync(versionsDir)) return res.json({ success: true, versions: [] });

    const files = fs.readdirSync(versionsDir)
      .filter(f => f.endsWith('.bak'))
      .map(f => {
        const filePath = path.join(versionsDir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
          id: f.replace('.bak', ''),
          filename: f,
          savedAt: stat.mtime.toISOString(),
          size: (content.length / 1024).toFixed(1) + ' KB',
          preview: content.substring(0, 80).replace(/\n/g, ' ').trim() + '...'
        };
      })
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
      .slice(0, 20); // Keep last 20 versions

    res.json({ success: true, versions: files });
  } catch (err) {
    res.status(500).json({ error: 'Could not list versions: ' + err.message });
  }
});

// ADMIN FILE EDITOR - Read a specific version
app.get('/api/admin/read-version', (req, res) => {
  const { filename, versionId, adminPassword } = req.query;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const allowed = ['index.html', 'index.js'];
  if (!allowed.includes(filename)) return res.status(400).json({ error: 'File not allowed' });

  try {
    const versionPath = path.join(__dirname, '.versions', filename, versionId + '.bak');
    if (!fs.existsSync(versionPath)) return res.status(404).json({ error: 'Version not found' });
    const content = fs.readFileSync(versionPath, 'utf-8');
    res.json({ success: true, content });
  } catch (err) {
    res.status(500).json({ error: 'Could not read version: ' + err.message });
  }
});

// ADMIN FILE EDITOR - Write file and restart
app.post('/api/admin/write-file', (req, res) => {
  const { filename, content, adminPassword } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const allowed = ['index.html', 'index.js'];
  if (!allowed.includes(filename)) return res.status(400).json({ error: 'File not allowed' });
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is empty' });

  try {
    const filePath = path.join(__dirname, filename);

    // Save versioned backup with timestamp
    const versionsDir = path.join(__dirname, '.versions', filename);
    if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(versionsDir, `${timestamp}.bak`);
    fs.writeFileSync(backupPath, fs.readFileSync(filePath, 'utf-8'));

    // Prune old versions — keep only the 20 most recent
    const allVersions = fs.readdirSync(versionsDir)
      .filter(f => f.endsWith('.bak'))
      .sort()
      .reverse();
    if (allVersions.length > 20) {
      allVersions.slice(20).forEach(f => fs.unlinkSync(path.join(versionsDir, f)));
    }

    // Write the new file
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`💾 Admin saved: ${filename} — backup: ${timestamp}`);

    res.json({ success: true, message: `${filename} saved! Restarting...` });

    setTimeout(() => {
      console.log('🔄 Restarting after file update...');
      process.exit(0);
    }, 500);
  } catch (err) {
    res.status(500).json({ error: 'Could not save file: ' + err.message });
  }
});

// ADMIN FILE EDITOR - Revert to a version
app.post('/api/admin/revert-version', (req, res) => {
  const { filename, versionId, adminPassword } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const allowed = ['index.html', 'index.js'];
  if (!allowed.includes(filename)) return res.status(400).json({ error: 'File not allowed' });

  try {
    const versionPath = path.join(__dirname, '.versions', filename, versionId + '.bak');
    if (!fs.existsSync(versionPath)) return res.status(404).json({ error: 'Version not found' });

    const restoredContent = fs.readFileSync(versionPath, 'utf-8');
    const filePath = path.join(__dirname, filename);

    // Backup current file before reverting
    const versionsDir = path.join(__dirname, '.versions', filename);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(versionsDir, `${timestamp}.bak`), fs.readFileSync(filePath, 'utf-8'));

    // Restore the old version
    fs.writeFileSync(filePath, restoredContent, 'utf-8');
    console.log(`⏪ Admin reverted ${filename} to version: ${versionId}`);

    res.json({ success: true, message: `Reverted! Restarting...` });

    setTimeout(() => {
      console.log('🔄 Restarting after revert...');
      process.exit(0);
    }, 500);
  } catch (err) {
    res.status(500).json({ error: 'Could not revert: ' + err.message });
  }
});

// TOGGLE ADMIN-ONLY
app.post('/api/admin-only/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const { adminPassword } = req.body;
    if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

    const game = allFiles.find(f => f.id === fileId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    game.adminOnly = !game.adminOnly;
    await saveGamesToDB(game);

    console.log(`🔐 Game "${game.name}" is now ${game.adminOnly ? 'admin-only' : 'public'}`);
    res.json({ success: true, adminOnly: game.adminOnly });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ARCHIVE / UNARCHIVE GAME
app.post('/api/archive/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const { adminPassword } = req.body;

    if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

    const game = allFiles.find(f => f.id === fileId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    game.archived = !game.archived;
    await saveGamesToDB(game);

    console.log(`📦 Game ${game.archived ? 'archived' : 'unarchived'}: ${game.name}`);
    res.json({ success: true, archived: game.archived, message: `Game ${game.archived ? 'archived' : 'unarchived'}!` });
  } catch (err) {
    console.error('Archive error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Appeals storage
const appeals = new Map(); // appealId -> appeal object

// SUBMIT APPEAL
app.post('/api/appeal', (req, res) => {
  const { playerId, playerUsername, banReason, appealText } = req.body;
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });
  if (!appealText || !appealText.trim()) return res.status(400).json({ error: 'Appeal text required' });

  // Only allow one pending appeal per player
  for (const [, appeal] of appeals) {
    if (appeal.playerId === playerId && appeal.status === 'pending') {
      return res.status(400).json({ error: 'You already have a pending appeal.' });
    }
  }

  const appealId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  appeals.set(appealId, {
    id: appealId,
    playerId,
    playerUsername: playerUsername || 'Unknown',
    banReason: banReason || 'No reason given',
    appealText: appealText.trim(),
    status: 'pending', // pending | approved | denied
    submittedAt: new Date().toISOString()
  });

  console.log(`📨 Appeal submitted by ${playerUsername} (${playerId})`);
  res.json({ success: true, message: 'Appeal submitted!' });
});

// GET ALL APPEALS (admin)
app.get('/api/appeals', (req, res) => {
  const { adminPassword } = req.query;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const list = [];
  appeals.forEach(a => list.push(a));
  list.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  res.json({ success: true, count: list.length, appeals: list });
});

// APPROVE APPEAL (admin) - also unbans the player
app.post('/api/appeals/:id/approve', (req, res) => {
  const { adminPassword } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const appeal = appeals.get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

  appeal.status = 'approved';
  appeal.reviewedAt = new Date().toISOString();

  // Unban the player automatically
  bannedPlayers.delete(appeal.playerId);

  console.log(`✅ Appeal approved for ${appeal.playerUsername} — player unbanned`);
  res.json({ success: true, message: 'Appeal approved and player unbanned!' });
});

// DENY APPEAL (admin)
app.post('/api/appeals/:id/deny', (req, res) => {
  const { adminPassword } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const appeal = appeals.get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

  appeal.status = 'denied';
  appeal.reviewedAt = new Date().toISOString();

  console.log(`❌ Appeal denied for ${appeal.playerUsername}`);
  res.json({ success: true, message: 'Appeal denied.' });
});

// BAN PLAYER
app.post('/api/ban', (req, res) => {
  const { adminPassword, playerId, playerUsername, reason } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });

  bannedPlayers.set(playerId, {
    playerId,
    playerUsername: playerUsername || 'Unknown',
    reason: reason || 'Banned by admin',
    bannedAt: new Date().toISOString()
  });

  // Kick from active sessions immediately
  for (const [sessionId, data] of activeSessions) {
    if (data.playerId === playerId) {
      activeSessions.delete(sessionId);
    }
  }

  console.log(`🚫 Player banned: ${playerUsername} (${playerId}) — Reason: ${reason}`);
  res.json({ success: true, message: `${playerUsername} has been banned.` });
});

// UNBAN PLAYER
app.post('/api/unban', (req, res) => {
  const { adminPassword, playerId } = req.body;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });

  const ban = bannedPlayers.get(playerId);
  if (!ban) return res.status(404).json({ error: 'Player not found in ban list' });

  bannedPlayers.delete(playerId);
  console.log(`✅ Player unbanned: ${ban.playerUsername} (${playerId})`);
  res.json({ success: true, message: `${ban.playerUsername} has been unbanned.` });
});

// GET BANNED PLAYERS
app.get('/api/banned-players', (req, res) => {
  const adminPassword = req.query.adminPassword;
  if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

  const banned = [];
  bannedPlayers.forEach((data) => banned.push(data));
  res.json({ count: banned.length, players: banned });
});

app.get('/api/active-players', (req, res) => {
  cleanupInactiveSessions();
  const players = [];
  activeSessions.forEach((playerData, sessionId) => {
    players.push({
      sessionId,
      playerUsername: playerData.playerUsername || 'Unknown',
      playerId: playerData.playerId || sessionId,
      gameId: playerData.gameId,
      gameName: playerData.gameName,
      timestamp: playerData.timestamp
    });
  });
  console.log(`👥 Active players: ${players.length}`);
  res.json({ count: players.length, players });
});

app.get('/api/view/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = allFiles.find(f => f.id === fileId);

    if (!file) return res.status(404).send('<h1 style="color:#ef4444;">Game not found</h1>');

    if (file.htmlFileId && gridFSBucket) {
      const downloadStream = gridFSBucket.openDownloadStream(file.htmlFileId);
      let content = '';
      downloadStream.on('data', (chunk) => { content += chunk.toString('utf-8'); });
      downloadStream.on('end', () => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(content);
      });
      downloadStream.on('error', () => {
        res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
      });
    } else if (file.htmlContent) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(file.htmlContent);
    } else {
      res.status(404).send('<h1 style="color:#ef4444;">Game file not found</h1>');
    }
  } catch (err) {
    res.status(500).send('<h1 style="color:#ef4444;">Error loading game</h1>');
  }
});

app.get('/api/download/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const file = allFiles.find(f => f.id === fileId);
    if (!file) return res.status(404).json({ error: 'Game not found' });

    if (file.htmlFileId && gridFSBucket) {
      const downloadStream = gridFSBucket.openDownloadStream(file.htmlFileId);
      let content = '';
      downloadStream.on('data', (chunk) => { content += chunk.toString('utf-8'); });
      downloadStream.on('end', () => {
        file.downloads++;
        saveGamesToDB(file);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file.name}.html"`);
        res.send(content);
      });
      downloadStream.on('error', () => res.status(404).json({ error: 'Game file not found' }));
    } else if (file.htmlContent) {
      file.downloads++;
      saveGamesToDB(file);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.name}.html"`);
      res.send(file.htmlContent);
    } else {
      res.status(404).json({ error: 'Game file not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Download failed' });
  }
});

// ✅ FIXED: Delete now accepts EITHER a valid uploaderToken OR the admin password
app.delete('/api/delete/:id', async (req, res) => {
  try {
    console.log(`🗑️ Delete request for game ID: ${req.params.id}`);

    const fileId = parseInt(req.params.id);
    const uploaderToken = req.body.uploaderToken;
    const adminPassword = req.body.adminPassword;

    const fileIndex = allFiles.findIndex(f => f.id === fileId);

    if (fileIndex === -1) {
      console.log(`❌ Game not found`);
      return res.status(404).json({ error: 'Game not found' });
    }

    const file = allFiles[fileIndex];
    console.log(`Found game: ${file.name}`);

    // ✅ Allow delete if admin password OR valid uploader token
    const isAdminDelete = adminPassword && adminPassword === ADMIN_PASSWORD;
    const isUploaderDelete = uploaderToken && uploaderToken === file.uploaderToken;

    if (!isAdminDelete && !isUploaderDelete) {
      console.log('❌ Delete attempt with invalid credentials');
      return res.status(401).json({ error: 'Invalid token - you did not upload this game' });
    }

    console.log(isAdminDelete ? '✅ Admin delete authorized' : '✅ Uploader delete authorized');

    allFiles.splice(fileIndex, 1);
    await deleteGameFromDB(fileId);

    console.log(`✅ Game deleted: ${file.name} (ID: ${fileId})`);
    res.json({ success: true, message: 'Game deleted successfully!' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.put('/api/edit/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const { adminPassword, name, description, tags } = req.body;

    if (!isAdmin(adminPassword)) return res.status(401).json({ error: 'Invalid admin password' });

    const fileIndex = allFiles.findIndex(f => f.id === fileId);
    if (fileIndex === -1) return res.status(404).json({ error: 'Game not found' });

    const file = allFiles[fileIndex];
    if (name) file.name = name;
    if (description) file.description = description;
    if (tags) file.tags = tags.split(',').map(t => t.trim());

    await saveGamesToDB(file);
    res.json({ success: true, message: 'Game updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Error editing game' });
  }
});

app.get('/api/dashboard/:password', async (req, res) => {
  try {
    if (!isAdmin(req.params.password)) return res.status(401).json({ error: 'Invalid admin password' });
    res.json({
      totalGames: allFiles.length,
      totalDownloads: allFiles.reduce((sum, g) => sum + (g.downloads || 0), 0),
      totalViews: allFiles.reduce((sum, g) => sum + (g.views || 0), 0),
      games: allFiles.map(g => ({ id: g.id, name: g.name, downloads: g.downloads, views: g.views, avgRating: g.avgRating })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching dashboard' });
  }
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max size is 100MB.' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'File upload error: ' + err.message });
  res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown error') });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, async () => {
  console.log(`\n🎮 GameVault running on port ${PORT}`);
  await connectDB();
  console.log(`\n========= STARTUP STATUS =========`);
  console.log(`📊 Games loaded into memory: ${allFiles.length}`);
  if (allFiles.length > 0) {
    console.log(`✅ First 3 games:`, allFiles.slice(0, 3).map(g => g.name));
  } else {
    console.log(`⚠️  WARNING: No games loaded! Check MongoDB connection.`);
  }
  console.log(`🆔 Next ID: ${nextId}`);
  console.log(`===================================\n`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close();
  if (db) mongoose.connection.close();
});
