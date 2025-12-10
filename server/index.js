const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Embeddings support (lazy loaded)
let embeddingModel = null;
let embeddingsEnabled = true; // Can be disabled if model fails to load

const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];
const STREAM_TIMEOUT = 15000; // 15 seconds - ensure Traefik doesn't timeout first (Traefik default is usually 60s, but safer to be shorter)
const MAX_CONCURRENT_REQUESTS = 5; // Limit concurrent requests to prevent overwhelming system

// Cache TTLs by source type (in hours)
const CACHE_TTL = {
  youtube: 2,      // YouTube URLs (Piped/Invidious) expire quickly - 2 hours
  itunes: 168,     // iTunes URLs are stable - 7 days (168 hours)
  archive: 720     // Archive URLs are permanent - 30 days (720 hours)
};

// Memory management: Cache size limits
const MAX_CACHE_SIZE = 10000; // Maximum cache entries in memory
const MAX_SUCCESS_TRACKER_ENTRIES = 5000; // Maximum tracker entries per type
const MAX_JSON_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB max JSON response size

// Initialize SQLite database for persistent storage
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'trailerio.db');
const dbDir = path.dirname(dbPath);

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// ============ LOGGING UTILITY ============
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const logger = {
  // Format timestamp
  timestamp: () => {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  },
  
  // Request logs
  request: (method, path, status, duration) => {
    const statusColor = status >= 200 && status < 300 ? colors.green : 
                       status >= 400 && status < 500 ? colors.yellow : colors.red;
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.cyan}${method}${colors.reset} ${path} ${statusColor}${status}${colors.reset} ${colors.dim}(${duration}ms)${colors.reset}`);
  },
  
  // Source extraction logs
  source: (source, message, success = null) => {
    const icon = success === true ? '✓' : success === false ? '✗' : '→';
    const color = success === true ? colors.green : success === false ? colors.red : colors.blue;
    const sourceName = source.toUpperCase().padEnd(10);
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${color}${icon}${colors.reset} ${colors.bright}[${sourceName}]${colors.reset} ${message}`);
  },
  
  // Cache logs
  cache: (action, message) => {
    const icon = action === 'hit' ? '💾' : action === 'miss' ? '🔍' : '🗑️';
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${icon} ${colors.magenta}[CACHE]${colors.reset} ${message}`);
  },
  
  // Info logs
  info: (message) => {
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.blue}ℹ${colors.reset} ${message}`);
  },
  
  // Success logs
  success: (message) => {
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.green}✓${colors.reset} ${message}`);
  },
  
  // Warning logs
  warn: (message) => {
    console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.yellow}⚠${colors.reset} ${message}`);
  },
  
  // Error logs
  error: (message, error = null) => {
    console.error(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.red}✗${colors.reset} ${colors.red}[ERROR]${colors.reset} ${message}`);
    if (error) {
      console.error(`${colors.dim}  Stack:${colors.reset} ${error.stack || error.message}`);
    }
  },
  
  // Debug logs (only in development)
  debug: (message) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`${colors.dim}[${logger.timestamp()}]${colors.reset} ${colors.dim}[DEBUG]${colors.reset} ${message}`);
    }
  },
  
  // Section separator
  section: (title) => {
    console.log(`\n${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════${colors.reset}\n`);
  }
};

// Optimize database for better performance and memory usage
db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
db.pragma('synchronous = NORMAL'); // Balance between safety and performance
db.pragma('cache_size = -64000'); // 64MB cache (negative = KB)
db.pragma('temp_store = MEMORY'); // Store temp tables in memory
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    imdb_id TEXT PRIMARY KEY,
    preview_url TEXT,
    track_id TEXT,
    country TEXT,
    youtube_key TEXT,
    source_type TEXT,
    source TEXT,
    timestamp INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS success_tracker (
    type TEXT NOT NULL,
    identifier TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    PRIMARY KEY (type, identifier)
  );
  
  CREATE TABLE IF NOT EXISTS archive_cookies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cookies TEXT NOT NULL,
    email TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_used INTEGER DEFAULT (strftime('%s', 'now')),
    is_valid INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0
  );
  
  CREATE INDEX IF NOT EXISTS idx_cache_timestamp ON cache(timestamp);
  CREATE INDEX IF NOT EXISTS idx_success_tracker_type ON success_tracker(type);
  CREATE INDEX IF NOT EXISTS idx_archive_cookies_valid ON archive_cookies(is_valid, last_used);
`);

// Load cache from database (limit to most recent entries to prevent memory issues)
const cache = new Map();
const loadCacheFromDB = db.prepare(`
  SELECT * FROM cache 
  ORDER BY timestamp DESC 
  LIMIT ?
`);
const cacheRows = loadCacheFromDB.all(MAX_CACHE_SIZE);
for (const row of cacheRows) {
  cache.set(row.imdb_id, {
    preview_url: row.preview_url,
    track_id: row.track_id,
    country: row.country,
    youtube_key: row.youtube_key,
    source_type: row.source_type,
    source: row.source,
    timestamp: row.timestamp
  });
}
logger.info(`Loaded ${cache.size} cached items from database (limited to ${MAX_CACHE_SIZE} most recent)`);

// Load success tracker from database (limit per type to prevent memory issues)
const loadSuccessTracker = db.prepare(`
  SELECT * FROM success_tracker 
  WHERE type = ? 
  ORDER BY total DESC 
  LIMIT ?
`);
const successTrackerData = {
  piped: new Map(),
  invidious: new Map(),
  itunes: new Map(),
  archive: new Map(),
  ytdlp: new Map(),
  sources: new Map()
};

const trackerTypes = ['piped', 'invidious', 'itunes', 'archive', 'ytdlp', 'sources'];
for (const type of trackerTypes) {
  const rows = loadSuccessTracker.all(type, MAX_SUCCESS_TRACKER_ENTRIES);
  for (const row of rows) {
    successTrackerData[type].set(row.identifier, {
      success: row.success,
      total: row.total
    });
  }
}
const totalTrackerEntries = Object.values(successTrackerData).reduce((sum, map) => sum + map.size, 0);
console.log(`Loaded ${totalTrackerEntries} success tracker entries from database (limited to ${MAX_SUCCESS_TRACKER_ENTRIES} per type)`);

let activeRequests = 0;
let totalRequests = 0;
let cacheWriteQueue = []; // Queue for batched cache writes
let cacheWriteTimer = null; // Timer for batched cache writes
const requestQueue = []; // Queue for requests when at max concurrency

// Periodic cache cleanup to prevent memory growth
function cleanupCache() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [imdbId, cached] of cache.entries()) {
    const hoursSinceCheck = (now - cached.timestamp) / (1000 * 60 * 60);
    const sourceType = cached.source_type || 'youtube';
    const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
    
    // Remove expired entries
    if (hoursSinceCheck >= ttlHours) {
      cache.delete(imdbId);
      const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
      deleteStmt.run(imdbId);
      cleaned++;
    }
  }
  
  // If cache is still too large, remove oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, cache.size - MAX_CACHE_SIZE);
    for (const [imdbId] of toRemove) {
      cache.delete(imdbId);
      const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
      deleteStmt.run(imdbId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Memory] Cleaned up ${cleaned} cache entries (current size: ${cache.size})`);
  }
}

// Cleanup success tracker to prevent unbounded growth
function cleanupSuccessTracker() {
  const trackerTypes = ['piped', 'invidious', 'itunes', 'archive', 'ytdlp', 'sources'];
  
  for (const type of trackerTypes) {
    const map = successTracker[type];
    if (!map || map.size <= MAX_SUCCESS_TRACKER_ENTRIES) {
      continue;
    }
    
    // Keep entries with highest total (most active)
    const entries = Array.from(map.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, MAX_SUCCESS_TRACKER_ENTRIES);
    
    map.clear();
    for (const [identifier, stats] of entries) {
      map.set(identifier, stats);
    }
    
    // Also clean database - keep only the entries we're keeping
    if (entries.length > 0) {
      const placeholders = entries.map(() => '?').join(',');
      const stmt = db.prepare(`DELETE FROM success_tracker WHERE type = ? AND identifier NOT IN (${placeholders})`);
      stmt.run(type, ...entries.map(e => e[0]));
    } else {
      const stmt = db.prepare('DELETE FROM success_tracker WHERE type = ?');
      stmt.run(type);
    }
    
    console.log(`[Memory] Cleaned up success tracker for ${type} (kept ${map.size} entries)`);
  }
}

// Memory monitoring endpoint (for debugging)
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    },
    cache: {
      size: cache.size,
      maxSize: MAX_CACHE_SIZE
    },
    successTracker: {
      piped: successTracker.piped.size,
      invidious: successTracker.invidious.size,
      itunes: successTracker.itunes.size,
      archive: successTracker.archive.size,
      ytdlp: successTracker.ytdlp.size,
      sources: successTracker.sources.size
    },
    requests: {
      active: activeRequests,
      total: totalRequests
    }
  });
});

// Circuit breaker for instances (tracks failures and temporarily disables dead instances)
const circuitBreakers = {
  piped: new Map(), // instance URL -> { failures: number, lastFailure: timestamp, open: boolean }
  invidious: new Map(), // instance URL -> { failures: number, lastFailure: timestamp, open: boolean }
  CIRCUIT_OPEN_THRESHOLD: 5, // Open circuit after 5 consecutive failures
  CIRCUIT_RESET_TIME: 10 * 60 * 1000, // Reset after 10 minutes
};

// Source response time tracking (for dynamic timeouts)
const sourceResponseTimes = {
  itunes: [],
  piped: [],
  invidious: [],
  ytdlp: [],
  archive: [],
  MAX_SAMPLES: 50, // Keep last 50 response times per source
  getAverageTime(source) {
    const times = this[source] || [];
    if (times.length === 0) return null;
    return times.reduce((a, b) => a + b, 0) / times.length;
  },
  recordTime(source, duration) {
    if (!this[source]) this[source] = [];
    this[source].push(duration);
    if (this[source].length > this.MAX_SAMPLES) {
      this[source].shift(); // Remove oldest
    }
  },
  getTimeout(source, defaultTimeout) {
    const avgTime = this.getAverageTime(source);
    if (!avgTime) return defaultTimeout;
    // Use 3x average time, but cap at defaultTimeout and minimum 2s
    return Math.max(2000, Math.min(defaultTimeout, avgTime * 3));
  }
};

// Quality tracking for sources (prefer sources that return higher quality)
const qualityTracker = {
  sources: new Map(), // source -> { totalQuality: number, count: number, avgQuality: number }
  QUALITY_SCORES: {
    '2160p': 4, '4k': 4,
    '1440p': 3.5, '2k': 3.5,
    '1080p': 3, '1080': 3,
    '720p': 2, '720': 2,
    '480p': 1, '480': 1,
    '360p': 0.5, '360': 0.5,
    '240p': 0.25, '240': 0.25,
    'best': 2.5, // Default "best" quality
    'unknown': 1.5 // Unknown quality
  },
  getQualityScore(quality) {
    if (!quality) return this.QUALITY_SCORES.unknown;
    const qualityLower = quality.toLowerCase();
    for (const [key, score] of Object.entries(this.QUALITY_SCORES)) {
      if (qualityLower.includes(key)) return score;
    }
    return this.QUALITY_SCORES.unknown;
  },
  recordQuality(source, quality) {
    if (!this.sources.has(source)) {
      this.sources.set(source, { totalQuality: 0, count: 0, avgQuality: 0 });
    }
    const stats = this.sources.get(source);
    const score = this.getQualityScore(quality);
    stats.totalQuality += score;
    stats.count++;
    stats.avgQuality = stats.totalQuality / stats.count;
  },
  getAvgQuality(source) {
    const stats = this.sources.get(source);
    return stats ? stats.avgQuality : 1.5; // Default to unknown quality
  }
};

// Success rate tracking for smart sorting
const successTracker = {
  // Source-level tracking (overall success rate for each source)
  sources: successTrackerData.sources || new Map(), // 'itunes' | 'piped' | 'invidious' | 'archive' -> { success: number, total: number }
  // Instance/strategy-level tracking (within each source)
  piped: successTrackerData.piped || new Map(), // instance URL -> { success: number, total: number }
  invidious: successTrackerData.invidious || new Map(), // instance URL -> { success: number, total: number }
  itunes: successTrackerData.itunes || new Map(), // country code -> { success: number, total: number }
  archive: successTrackerData.archive || new Map(), // strategy ID -> { success: number, total: number }
  ytdlp: successTrackerData.ytdlp || new Map(), // extraction identifier -> { success: number, total: number }
  
  // Database operations - with timeout protection
  // Batch DB writes to reduce CPU overhead (async, non-blocking)
  _dbWriteQueue: [],
  _dbWriteTimer: null,
  _saveToDB(type, identifier, success, total) {
    // Queue write instead of blocking
    this._dbWriteQueue.push({ type, identifier, success, total });
    
    // Batch writes every 100ms to reduce CPU overhead
    if (!this._dbWriteTimer) {
      this._dbWriteTimer = setImmediate(() => {
        this._flushDBWrites();
        this._dbWriteTimer = null;
      });
    }
  },
  _flushDBWrites() {
    if (this._dbWriteQueue.length === 0) return;
    
    const writes = this._dbWriteQueue.splice(0); // Clear queue
    const stmt = db.prepare(`
      INSERT INTO success_tracker (type, identifier, success, total)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type, identifier) DO UPDATE SET success = ?, total = ?
    `);
    
    // Batch execute all writes in a transaction (much faster)
    const transaction = db.transaction((writes) => {
      for (const { type, identifier, success, total } of writes) {
        stmt.run(type, identifier, success, total, success, total);
      }
    });
    
    try {
      transaction(writes);
    } catch (error) {
      // Don't spam logs for database locked errors
      if (!error.message.includes('database is locked') && !error.message.includes('SQLITE_BUSY')) {
        console.error(`[SuccessTracker] Database error: ${error.message}`);
      }
    }
  },
  
  recordSuccess(type, identifier) {
    const map = this[type];
    if (!map.has(identifier)) {
      map.set(identifier, { success: 0, total: 0 });
    }
    const stats = map.get(identifier);
    stats.success++;
    stats.total++;
    // Save to database
    this._saveToDB(type, identifier, stats.success, stats.total);
    
    // Reset circuit breaker on success
    if (type === 'piped' || type === 'invidious') {
      const breaker = circuitBreakers[type].get(identifier);
      if (breaker) {
        breaker.failures = 0;
        breaker.open = false;
      }
    }
  },
  
  recordFailure(type, identifier) {
    const map = this[type];
    if (!map.has(identifier)) {
      map.set(identifier, { success: 0, total: 0 });
    }
    const stats = map.get(identifier);
    stats.total++;
    // Save to database
    this._saveToDB(type, identifier, stats.success, stats.total);
    
    // Update circuit breaker on failure
    if (type === 'piped' || type === 'invidious') {
      if (!circuitBreakers[type].has(identifier)) {
        circuitBreakers[type].set(identifier, { failures: 0, lastFailure: 0, open: false });
      }
      const breaker = circuitBreakers[type].get(identifier);
      breaker.failures++;
      breaker.lastFailure = Date.now();
      
      // Open circuit if threshold reached
      if (breaker.failures >= circuitBreakers.CIRCUIT_OPEN_THRESHOLD) {
        breaker.open = true;
        console.log(`  [Circuit Breaker] ${type}/${identifier} opened after ${breaker.failures} failures`);
      }
    }
  },
  
  // Check if instance is available (circuit breaker)
  isInstanceAvailable(type, identifier) {
    if (type !== 'piped' && type !== 'invidious') return true;
    
    const breaker = circuitBreakers[type].get(identifier);
    if (!breaker) return true;
    
    // Check if circuit should be reset
    if (breaker.open && Date.now() - breaker.lastFailure > circuitBreakers.CIRCUIT_RESET_TIME) {
      breaker.open = false;
      breaker.failures = 0;
      console.log(`  [Circuit Breaker] ${type}/${identifier} reset after timeout`);
      return true;
    }
    
    return !breaker.open;
  },
  
  getSuccessRate(type, identifier) {
    const map = this[type];
    const stats = map.get(identifier);
    if (!stats || stats.total === 0) return 0.5; // Default to 50% for untested
    return stats.success / stats.total;
  },
  
  sortBySuccessRate(type, list) {
    return [...list]
      .filter(item => this.isInstanceAvailable(type, item)) // Filter out circuit-broken instances
      .sort((a, b) => {
        const rateA = this.getSuccessRate(type, a);
        const rateB = this.getSuccessRate(type, b);
        return rateB - rateA; // Sort descending (highest success rate first)
      });
  },
  
  // Source-level tracking methods
  recordSourceSuccess(source) {
    if (!this.sources.has(source)) {
      this.sources.set(source, { success: 0, total: 0 });
    }
    const stats = this.sources.get(source);
    stats.success++;
    stats.total++;
    // Save to database
    this._saveToDB('sources', source, stats.success, stats.total);
  },
  
  recordSourceFailure(source) {
    if (!this.sources.has(source)) {
      this.sources.set(source, { success: 0, total: 0 });
    }
    const stats = this.sources.get(source);
    stats.total++;
    // Save to database
    this._saveToDB('sources', source, stats.success, stats.total);
  },
  
  getSourceSuccessRate(source) {
    const stats = this.sources.get(source);
    if (!stats || stats.total === 0) return 0.5; // Default to 50% for untested
    return stats.success / stats.total;
  },
  
  getSortedSources(availableSources, contentType = 'movie') {
    return [...availableSources].sort((a, b) => {
      const rateA = this.getSourceSuccessRate(a);
      const rateB = this.getSourceSuccessRate(b);
      
      // FIXED: Proper source priority order (YTDLP > Apple Trailers > Archive)
      // This ensures we prefer official high-quality sources over Archive fallbacks
      let priorityA = 0, priorityB = 0;
      
      // Source priority (higher = better):
      // - ytdlp: 0.5 (highest - official YouTube trailers from TMDB)
      // - appletrailers: 0.3 (high quality, official)
      // - itunes: 0.3 (for TV shows)
      // - archive: 0.1 (fallback for older/obscure content)
      
      if (a === 'ytdlp') priorityA = 0.5;
      else if (a === 'appletrailers') priorityA = 0.3;
      else if (a === 'itunes') priorityA = 0.3;
      else if (a === 'archive') priorityA = 0.1;
      
      if (b === 'ytdlp') priorityB = 0.5;
      else if (b === 'appletrailers') priorityB = 0.3;
      else if (b === 'itunes') priorityB = 0.3;
      else if (b === 'archive') priorityB = 0.1;
      
      // Quality-based weighting (prefer sources that return higher quality)
      const qualityA = qualityTracker.getAvgQuality(a);
      const qualityB = qualityTracker.getAvgQuality(b);
      const qualityWeight = 0.15; // 15% weight for quality (increased from 10%)
      
      // Combined score: success rate + source priority + quality
      const scoreA = rateA + priorityA + (qualityA * qualityWeight);
      const scoreB = rateB + priorityB + (qualityB * qualityWeight);
      
      return scoreB - scoreA; // Sort descending (highest score first)
    });
  }
};

// Run cleanup every hour (after successTracker is defined)
setInterval(() => {
  cleanupCache();
  cleanupSuccessTracker();
}, 60 * 60 * 1000); // 1 hour

// Also run cleanup on startup
cleanupCache();
cleanupSuccessTracker();

// Cache warming: Pre-cache popular content
async function warmCache() {
  if (!TMDB_API_KEY) {
    console.log('[Cache Warming] TMDB_API_KEY not set, skipping cache warming');
    return;
  }
  
  console.log('[Cache Warming] Starting cache warming for popular content...');
  
  try {
    // Get popular movies and TV shows from TMDB
    const [moviesResponse, tvResponse] = await Promise.allSettled([
      fetch(`https://api.themoviedb.org/3/movie/popular?api_key=${TMDB_API_KEY}&page=1&limit=50`),
      fetch(`https://api.themoviedb.org/3/tv/popular?api_key=${TMDB_API_KEY}&page=1&limit=50`)
    ]);
    
    const popularItems = [];
    
    if (moviesResponse.status === 'fulfilled' && moviesResponse.value.ok) {
      const moviesData = await moviesResponse.value.json();
      for (const movie of (moviesData.results || []).slice(0, 25)) {
        if (movie.external_ids?.imdb_id) {
          popularItems.push({ imdbId: movie.external_ids.imdb_id, type: 'movie' });
        }
      }
    }
    
    if (tvResponse.status === 'fulfilled' && tvResponse.value.ok) {
      const tvData = await tvResponse.value.json();
      for (const show of (tvData.results || []).slice(0, 25)) {
        if (show.external_ids?.imdb_id) {
          popularItems.push({ imdbId: show.external_ids.imdb_id, type: 'series' });
        }
      }
    }
    
    console.log(`[Cache Warming] Found ${popularItems.length} popular items to cache`);
    
    // Cache items sequentially to avoid overwhelming the system
    let cached = 0;
    let skipped = 0;
    
    for (const item of popularItems) {
      // Check if already cached
      const existing = getCached(item.imdbId);
      if (existing && existing.preview_url) {
        skipped++;
        continue;
      }
      
      try {
        // Resolve preview (this will cache it)
        // Convert 'series' to 'series' (already correct) or 'movie' to 'movie'
        const resolveType = item.type === 'series' ? 'series' : 'movie';
        await resolvePreview(item.imdbId, resolveType);
        cached++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.log(`[Cache Warming] Failed to cache ${item.imdbId}: ${error.message}`);
      }
    }
    
    console.log(`[Cache Warming] Complete: ${cached} cached, ${skipped} already cached, ${popularItems.length - cached - skipped} failed`);
  } catch (error) {
    console.error(`[Cache Warming] Error: ${error.message}`);
  }
}

// Run cache warming on startup (after 30 seconds) and then every 6 hours
setTimeout(() => {
  warmCache();
}, 30 * 1000); // 30 seconds after startup

setInterval(() => {
  warmCache();
}, 6 * 60 * 60 * 1000); // Every 6 hours

app.use(cors());
app.use(express.json());

// Request queue management
function processQueue() {
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const { req, res, next } = requestQueue.shift();
    activeRequests++;
    next();
  }
}

// Request tracking and concurrency limiting middleware
app.use((req, res, next) => {
  // Skip queue for non-stream requests (health, manifest, etc.)
  if (!req.path.includes('/stream/')) {
    return next();
  }
  
  totalRequests++;
  const requestId = totalRequests;
  let finished = false;
  
  // Check if we're at max concurrency
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    console.log(`[REQ ${requestId}] Queueing request (${activeRequests} active, ${requestQueue.length} queued)`);
    requestQueue.push({ req, res, next: () => {
      activeRequests++;
      console.log(`[REQ ${requestId}] ${req.method} ${req.path} - Active: ${activeRequests}`);
      
      res.on('finish', () => {
        if (!finished) {
          finished = true;
          activeRequests--;
          console.log(`[REQ ${requestId}] Finished - Active: ${activeRequests}`);
          processQueue(); // Process next in queue
        }
      });
      
      res.on('close', () => {
        if (!finished) {
          finished = true;
          activeRequests--;
          console.log(`[REQ ${requestId}] Closed - Active: ${activeRequests}`);
          processQueue(); // Process next in queue
        }
      });
      
      next();
    }});
    return;
  }
  
  // Process immediately
  activeRequests++;
  console.log(`[REQ ${requestId}] ${req.method} ${req.path} - Active: ${activeRequests}`);
  
  res.on('finish', () => {
    if (!finished) {
      finished = true;
      activeRequests--;
      console.log(`[REQ ${requestId}] Finished - Active: ${activeRequests}`);
      processQueue(); // Process next in queue
    }
  });
  
  res.on('close', () => {
    if (!finished) {
      finished = true;
      activeRequests--;
      console.log(`[REQ ${requestId}] Closed - Active: ${activeRequests}`);
      processQueue(); // Process next in queue
    }
  });
  
  next();
});

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cache fuzzy match results to reduce CPU usage
const fuzzyMatchCache = new Map();
const MAX_FUZZY_CACHE = 1000;

function fuzzyMatch(str1, str2) {
  // Fast path: exact match
  if (str1 === str2) return 1.0;
  
  // Check cache (reduces CPU-intensive Levenshtein calculations)
  const cacheKey = `${str1}|${str2}`;
  if (fuzzyMatchCache.has(cacheKey)) {
    return fuzzyMatchCache.get(cacheKey);
  }
  
  const norm1 = normalizeTitle(str1);
  const norm2 = normalizeTitle(str2);
  
  if (norm1 === norm2) {
    fuzzyMatchCache.set(cacheKey, 1.0);
    return 1.0;
  }
  
  // Fast substring check (much faster than Levenshtein)
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    fuzzyMatchCache.set(cacheKey, 0.85);
    return 0.85;
  }
  
  // Skip Levenshtein for very long strings (too CPU-intensive)
  if (norm1.length > 50 || norm2.length > 50) {
    fuzzyMatchCache.set(cacheKey, 0.5);
    return 0.5; // Conservative score for long strings
  }
  
  const longer = norm1.length > norm2.length ? norm1 : norm2;
  const shorter = norm1.length > norm2.length ? norm2 : norm1;
  
  if (longer.length === 0) {
    fuzzyMatchCache.set(cacheKey, 1.0);
    return 1.0;
  }
  
  const editDistance = levenshteinDistance(longer, shorter);
  const score = (longer.length - editDistance) / longer.length;
  
  // Cache result (limit cache size to prevent memory bloat)
  if (fuzzyMatchCache.size >= MAX_FUZZY_CACHE) {
    // Remove oldest entries (simple FIFO)
    const firstKey = fuzzyMatchCache.keys().next().value;
    fuzzyMatchCache.delete(firstKey);
  }
  fuzzyMatchCache.set(cacheKey, score);
  
  return score;
}

function levenshteinDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

async function getTMDBMetadata(imdbId, type) {
  console.log(`Fetching TMDB metadata for ${imdbId}, type: ${type}`);
  
  const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const findResponse = await fetch(findUrl);
  const findData = await findResponse.json();
  
  let result = null;
  let mediaType = type === 'movie' ? 'movie' : 'tv';
  
  if (type === 'movie' && findData.movie_results?.length > 0) {
    result = findData.movie_results[0];
    mediaType = 'movie';
  } else if (type === 'series' && findData.tv_results?.length > 0) {
    result = findData.tv_results[0];
    mediaType = 'tv';
  } else if (findData.movie_results?.length > 0) {
    result = findData.movie_results[0];
    mediaType = 'movie';
  } else if (findData.tv_results?.length > 0) {
    result = findData.tv_results[0];
    mediaType = 'tv';
  }
  
  if (!result) {
    console.log('No TMDB results found');
    return null;
  }
  
  const tmdbId = result.id;
  
  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=videos`;
  const altTitlesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
  
  const [detailResponse, altTitlesResponse] = await Promise.all([
    fetch(detailUrl),
    fetch(altTitlesUrl)
  ]);
  
  const [detail, altTitlesData] = await Promise.all([
    detailResponse.json(),
    altTitlesResponse.json()
  ]);
  
  const mainTitle = mediaType === 'movie' ? detail.title : detail.name;
  const originalTitle = mediaType === 'movie' ? detail.original_title : detail.original_name;
  const releaseDate = mediaType === 'movie' ? detail.release_date : detail.first_air_date;
  const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : null;
  const runtime = detail.runtime || null;
  
  // Supported video sites (yt-dlp can extract from these)
  // TMDB can return trailers from: YouTube, Vimeo, Dailymotion, Apple, Facebook, Twitter, Instagram
  const SUPPORTED_SITES = ['YouTube', 'Vimeo', 'Dailymotion', 'Apple', 'Facebook', 'Twitter', 'Instagram'];
  
  let youtubeTrailerKey = null;
  let trailerUrl = null; // For non-YouTube sites
  let trailerSite = null;
  const videos = detail.videos?.results || [];
  
  // Priority: Official Trailer > Official Teaser > Any Trailer > Official Clip > Any video
  // Filter out behind-the-scenes, featurettes, etc.
  const excludeTypes = ['Behind the Scenes', 'Featurette', 'Bloopers', 'Opening Credits'];
  const excludeNames = ['behind', 'featurette', 'bloopers', 'opening', 'credits', 'making of'];
  
  // Filter videos from supported sites
  const filteredVideos = videos.filter(v => {
    if (!SUPPORTED_SITES.includes(v.site)) return false;
    const name = (v.name || '').toLowerCase();
    return !excludeTypes.includes(v.type) && 
           !excludeNames.some(exclude => name.includes(exclude));
  });
  
  // Helper to build video URL based on site
  const buildVideoUrl = (video) => {
    const site = video.site;
    const key = video.key;
    
    if (site === 'YouTube') {
      return { url: `https://www.youtube.com/watch?v=${key}`, site: 'YouTube' };
    } else if (site === 'Vimeo') {
      return { url: `https://vimeo.com/${key}`, site: 'Vimeo' };
    } else if (site === 'Dailymotion') {
      return { url: `https://www.dailymotion.com/video/${key}`, site: 'Dailymotion' };
    } else if (site === 'Apple') {
      // Apple Trailers - key is usually a full URL or path
      return { url: key.startsWith('http') ? key : `https://trailers.apple.com/${key}`, site: 'Apple' };
    } else if (site === 'Facebook') {
      return { url: `https://www.facebook.com/watch/?v=${key}`, site: 'Facebook' };
    } else if (site === 'Twitter') {
      return { url: `https://twitter.com/i/videos/${key}`, site: 'Twitter' };
    } else if (site === 'Instagram') {
      return { url: `https://www.instagram.com/p/${key}`, site: 'Instagram' };
    }
    return null;
  };
  
  // Priority 1: Official Trailer
  let trailer = filteredVideos.find(v => 
    v.type === 'Trailer' && 
    v.official === true
  );
  let youtubeTrailerTitle = null;
  if (trailer) {
    const videoInfo = buildVideoUrl(trailer);
    if (videoInfo) {
      if (trailer.site === 'YouTube') {
        youtubeTrailerKey = trailer.key;
      } else {
        trailerUrl = videoInfo.url;
        trailerSite = videoInfo.site;
      }
      youtubeTrailerTitle = trailer.name || null;
      console.log(`Found official trailer: ${youtubeTrailerTitle || 'Trailer'} (${videoInfo.site})`);
    }
  } else {
    // Priority 2: Official Teaser
    trailer = filteredVideos.find(v => 
      v.type === 'Teaser' && 
      v.official === true
    );
    if (trailer) {
      const videoInfo = buildVideoUrl(trailer);
      if (videoInfo) {
        if (trailer.site === 'YouTube') {
          youtubeTrailerKey = trailer.key;
        } else {
          trailerUrl = videoInfo.url;
          trailerSite = videoInfo.site;
        }
        youtubeTrailerTitle = trailer.name || null;
        console.log(`Found official teaser: ${youtubeTrailerTitle || 'Teaser'} (${videoInfo.site})`);
      }
    } else {
      // Priority 3: Any Trailer (not official)
      trailer = filteredVideos.find(v => v.type === 'Trailer');
      if (trailer) {
        const videoInfo = buildVideoUrl(trailer);
        if (videoInfo) {
          if (trailer.site === 'YouTube') {
            youtubeTrailerKey = trailer.key;
          } else {
            trailerUrl = videoInfo.url;
            trailerSite = videoInfo.site;
          }
          youtubeTrailerTitle = trailer.name || null;
          console.log(`Found trailer: ${youtubeTrailerTitle || 'Trailer'} (${videoInfo.site})`);
        }
      } else {
        // Priority 4: Official Clip
        trailer = filteredVideos.find(v => 
          v.type === 'Clip' && 
          v.official === true
        );
        if (trailer) {
          const videoInfo = buildVideoUrl(trailer);
          if (videoInfo) {
            if (trailer.site === 'YouTube') {
              youtubeTrailerKey = trailer.key;
            } else {
              trailerUrl = videoInfo.url;
              trailerSite = videoInfo.site;
            }
            youtubeTrailerTitle = trailer.name || null;
            console.log(`Found official clip: ${youtubeTrailerTitle || 'Clip'} (${videoInfo.site})`);
          }
        } else {
          // Last resort: Any video (but prefer official)
          trailer = filteredVideos.find(v => v.official === true) || filteredVideos[0];
          if (trailer) {
            const videoInfo = buildVideoUrl(trailer);
            if (videoInfo) {
              if (trailer.site === 'YouTube') {
                youtubeTrailerKey = trailer.key;
              } else {
                trailerUrl = videoInfo.url;
                trailerSite = videoInfo.site;
              }
              youtubeTrailerTitle = trailer.name || null;
              console.log(`Found video: ${youtubeTrailerTitle || 'Video'} (${videoInfo.site}, ${trailer.type})`);
            }
          }
        }
      }
    }
  }
  
  const altTitlesArray = [];
  const englishCountries = ['US', 'GB', 'CA', 'AU'];
  const titles = mediaType === 'movie' ? altTitlesData.titles : altTitlesData.results;
  
  if (titles) {
    for (const t of titles) {
      const country = t.iso_3166_1;
      const titleText = t.title;
      if (englishCountries.includes(country) && titleText && !altTitlesArray.includes(titleText)) {
        altTitlesArray.push(titleText);
      }
    }
  }
  
  console.log(`TMDB: "${mainTitle}" (${year}), YouTube: ${youtubeTrailerKey || 'none'}, Other: ${trailerSite || 'none'}, altTitles: ${altTitlesArray.length}`);
  
  return {
    tmdbId,
    mediaType,
    title: mainTitle,
    originalTitle: originalTitle || mainTitle,
    year,
    runtime,
    altTitles: altTitlesArray,
    youtubeTrailerKey,
    youtubeTrailerTitle,
    trailerUrl, // For non-YouTube sites (Vimeo, Dailymotion, etc.)
    trailerSite // Site name (Vimeo, Dailymotion, etc.)
  };
}

async function searchITunes(params) {
  const { term, country, type } = params;
  
  // Optimized search function with better parameters
  const trySearch = async (extraParams, filterKind) => {
    const queryParams = new URLSearchParams({
      term,
      country,
      limit: '50', // Increased from 25 to 50 for better coverage (max is 200)
      lang: 'en_us', // Language parameter for better results
      ...extraParams
    });
    
    const url = `https://itunes.apple.com/search?${queryParams}`;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!response.ok) {
        // Don't log every 403/429 to reduce spam - only log occasionally
        if (response.status === 403 || response.status === 429) {
          // Rate limited - will be handled by sequential requests
          return [];
        }
        // For HTTP 400, try to get error details
        if (response.status === 400) {
          try {
            const errorText = await response.text();
            console.log(`  [iTunes] Search failed: HTTP 400 - ${errorText.substring(0, 200)}`);
          } catch {
            console.log(`  [iTunes] Search failed: HTTP 400 (Bad Request - likely invalid entity/parameters)`);
          }
        } else {
          console.log(`  [iTunes] Search failed: HTTP ${response.status}`);
        }
        return [];
      }
      
      const data = await response.json();
      let results = data.results || [];
      
      console.log(`  [iTunes] Raw API returned ${results.length} results for "${term}" in ${country}`);
      
      // Filter by kind if specified
      if (filterKind) {
        const beforeFilter = results.length;
        results = results.filter(r => r.kind === filterKind);
        console.log(`  [iTunes] After kind filter (${filterKind}): ${results.length} results (was ${beforeFilter})`);
      }
      
      // CRITICAL: Only return results with previewUrl (trailers/previews)
      // This ensures we only get items that actually have video content
      const beforePreviewFilter = results.length;
      results = results.filter(r => r.previewUrl && r.previewUrl.trim().length > 0);
      
      if (beforePreviewFilter > 0 && results.length === 0) {
        console.log(`  [iTunes] WARNING: ${beforePreviewFilter} results found but NONE have previewUrl!`);
        // Log first few results to debug
        const sample = data.results.slice(0, 3).map(r => ({
          trackName: r.trackName || r.collectionName,
          kind: r.kind,
          hasPreviewUrl: !!r.previewUrl
        }));
        console.log(`  [iTunes] Sample results:`, JSON.stringify(sample, null, 2));
      }
      
      return results;
    } catch (e) {
      console.log(`  [iTunes] Search error: ${e.message || 'unknown'}`);
      return [];
    }
  };
  
  if (type === 'movie') {
    // Strategy 1: Search all movie media types (no entity filter) - this gets everything
    console.log(`  [iTunes] Strategy 1: Searching with media=movie (no entity filter)`);
    let results = await trySearch({ media: 'movie' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} movie results with previews (no entity filter)`);
      return results;
    }
    
    // Strategy 2: Regular movie search with movieTerm attribute
    console.log(`  [iTunes] Strategy 2: Searching with media=movie, entity=movie, attribute=movieTerm`);
    results = await trySearch({ media: 'movie', entity: 'movie', attribute: 'movieTerm' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} movie results with previews`);
      return results;
    }
    
    // Strategy 3: Movie search without attribute
    console.log(`  [iTunes] Strategy 3: Searching with media=movie, entity=movie (no attribute)`);
    results = await trySearch({ media: 'movie', entity: 'movie' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} movie results (no attribute)`);
      return results;
    }
    
    // Strategy 4: Search all movies, filter by kind
    console.log(`  [iTunes] Strategy 4: Searching with media=movie, filtering by kind=feature-movie`);
    results = await trySearch({ media: 'movie' }, 'feature-movie');
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} feature-movie results with previews`);
      return results;
    }
  } else {
    // TV Show search strategies
    // Strategy 1: tvEpisode with showTerm attribute
    let results = await trySearch({ media: 'tvShow', entity: 'tvEpisode', attribute: 'showTerm' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} tvEpisode results`);
      return results;
    }
    
    // Strategy 2: tvEpisode without attribute
    results = await trySearch({ media: 'tvShow', entity: 'tvEpisode' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} tvEpisode results (no attribute)`);
      return results;
    }
    
    // Strategy 3: Search all TV, filter by kind
    results = await trySearch({ media: 'tvShow' }, 'tv-episode');
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} tv-episode results with previews`);
      return results;
    }
  }
  
  console.log(`  [iTunes] No results found for "${term}" in ${country}`);
  return [];
}

function scoreItem(tmdbMeta, item) {
  let score = 0;
  
  const nameToMatch = tmdbMeta.mediaType === 'tv' 
    ? (item.artistName || item.collectionName || '') 
    : (item.trackName || item.collectionName || '');
  
  const normNameToMatch = normalizeTitle(nameToMatch);
  const normTitle = normalizeTitle(tmdbMeta.title);
  const normOriginal = normalizeTitle(tmdbMeta.originalTitle);
  const normAltTitles = tmdbMeta.altTitles.map(t => normalizeTitle(t));
  
  if (normNameToMatch === normTitle) {
    score += 0.5;
  } else if (normNameToMatch === normOriginal) {
    score += 0.4;
  } else if (normAltTitles.includes(normNameToMatch)) {
    score += 0.4;
  } else {
    const fuzzyScore = Math.max(
      fuzzyMatch(nameToMatch, tmdbMeta.title),
      fuzzyMatch(nameToMatch, tmdbMeta.originalTitle)
    );
    if (fuzzyScore > 0.8) {
      score += 0.3;
    } else if (fuzzyScore > 0.6) {
      score += 0.15;
    }
  }
  
  const itunesYear = item.releaseDate ? parseInt(item.releaseDate.substring(0, 4)) : null;
  if (tmdbMeta.year && itunesYear) {
    const diff = Math.abs(itunesYear - tmdbMeta.year);
    if (tmdbMeta.mediaType === 'tv') {
      if (diff === 0) {
        score += 0.35;
      } else if (diff <= 2) {
        score += 0.25;
      } else if (diff <= 5) {
        score += 0.15;
      } else if (diff <= 10) {
        score += 0.05;
      }
    } else {
      if (diff === 0) {
        score += 0.35;
      } else if (diff === 1) {
        score += 0.2;
      } else if (diff > 2) {
        score -= 0.5;
      }
    }
  }
  
  if (tmdbMeta.mediaType === 'movie' && tmdbMeta.runtime && item.trackTimeMillis) {
    const itunesMinutes = Math.round(item.trackTimeMillis / 60000);
    const runtimeDiff = Math.abs(itunesMinutes - tmdbMeta.runtime);
    if (runtimeDiff <= 5) {
      score += 0.15;
    } else if (runtimeDiff > 15) {
      score -= 0.2;
    }
  }
  
  // previewUrl is already filtered in searchITunes, but double-check
  if (!item.previewUrl) {
    score -= 1.0;
  }
  
  // Bonus for longer previews (more likely to be full trailers)
  if (item.trackTimeMillis) {
    const durationSeconds = item.trackTimeMillis / 1000;
    if (durationSeconds >= 60) {
      score += 0.1; // Bonus for trailers over 1 minute
    } else if (durationSeconds < 30) {
      score -= 0.1; // Penalty for very short previews (< 30s)
    }
  }
  
  return score;
}

function findBestMatch(results, tmdbMeta) {
  let bestScore = -Infinity;
  let bestItem = null;
  
  for (const item of results) {
    const score = scoreItem(tmdbMeta, item);
    const trackName = item.trackName || item.collectionName || 'Unknown';
    const itunesYear = item.releaseDate ? item.releaseDate.substring(0, 4) : 'N/A';
    
    console.log(`  Score ${score.toFixed(2)}: "${trackName}" (${itunesYear})`);
    
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  
  if (bestScore >= MIN_SCORE_THRESHOLD && bestItem) {
    console.log(`✓ Best match score: ${bestScore.toFixed(2)}`);
    return { score: bestScore, item: bestItem };
  }
  
  return null;
}

// ============ PIPED EXTRACTOR ============

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.in.projectsegfau.lt',
  'https://api.piped.private.coffee',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.darkness.services',
  // Additional instances to try
  'https://pipedapi.frontendfocused.xyz',
  'https://pipedapi.osphost.fi',
  'https://pipedapi.smnz.de',
  'https://pipedapi.privacyredirect.com',
];

async function extractViaPiped(youtubeKey) {
  // Sort instances by success rate (highest first)
  const sortedInstances = successTracker.sortBySuccessRate('piped', PIPED_INSTANCES);
  const top3 = sortedInstances.slice(0, 3).map(inst => {
    const rate = successTracker.getSuccessRate('piped', inst);
    return `${inst.split('//')[1].split('/')[0]} (${(rate * 100).toFixed(0)}%)`;
  }).join(', ');
  console.log(`  [Piped] Trying ${sortedInstances.length} instances for ${youtubeKey} (sorted by success rate - top 3: ${top3})...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // 4s timeout - balance between speed and reliability
    const startTime = Date.now();
    
    try {
      const url = `${instance}/streams/${youtubeKey}`;
      console.log(`  [Piped] Trying ${instance}...`);
      
      const response = await fetch(url, {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      
      if (!response.ok) {
        const statusText = response.statusText || 'Unknown';
        console.log(`  [Piped] ✗ ${instance}: HTTP ${response.status} ${statusText} (${duration}ms)`);
        successTracker.recordFailure('piped', instance);
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        const preview = text.substring(0, 150).replace(/\n/g, ' ');
        console.log(`  [Piped] ✗ ${instance}: non-JSON response (${contentType || 'no content-type'}): ${preview}`);
        successTracker.recordFailure('piped', instance);
        return null;
      }
      
      const data = await response.json();
      
      // Check for error in response
      if (data.error) {
        console.log(`  [Piped] ✗ ${instance}: API error: ${data.error} (${duration}ms)`);
        successTracker.recordFailure('piped', instance);
        return null;
      }
      
      console.log(`  [Piped] ✓ ${instance}: got response (${duration}ms), has dash: ${!!data.dash}, videoStreams: ${data.videoStreams?.length || 0}, audioStreams: ${data.audioStreams?.length || 0}`);
      
      // PRIORITY 1: DASH manifest (best for AVPlayer - native support, adaptive streaming, highest quality)
      if (data.dash) {
        logger.source('piped', `${instance}: got DASH manifest (adaptive quality)`, true);
        successTracker.recordSuccess('piped', instance);
        return { url: data.dash, isDash: true };
      }
      
      // PRIORITY 2: Video streams (fallback if no DASH)
      if (data.videoStreams?.length > 0) {
        const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
        const getQualityRank = (q) => {
          if (!q) return 999;
          const qLower = String(q).toLowerCase();
          const idx = qualityPriority.findIndex(p => qLower.includes(p));
          return idx === -1 ? 998 : idx;
        };
        
        const sorted = [...data.videoStreams]
          .filter(s => s.mimeType?.startsWith('video/') && s.url)
          .sort((a, b) => {
            const rankA = getQualityRank(a.quality);
            const rankB = getQualityRank(b.quality);
            return rankA - rankB;
          });
        
        // Prefer combined streams (video + audio), but fall back to video-only if no combined streams exist
        if (sorted.length > 0) {
          const bestCombined = sorted.find(s => !s.videoOnly);
          if (bestCombined) {
            console.log(`  ✓ [Piped] ${instance}: selected ${bestCombined.quality || 'unknown'} (combined, highest quality)`);
            successTracker.recordSuccess('piped', instance);
            return { url: bestCombined.url, quality: bestCombined.quality, isDash: false };
          }
          // Fallback to video-only if no combined streams available
          const bestVideoOnly = sorted[0];
          console.log(`  ✓ [Piped] ${instance}: selected ${bestVideoOnly.quality || 'unknown'} (video-only, no combined available)`);
          successTracker.recordSuccess('piped', instance);
          return { url: bestVideoOnly.url, quality: bestVideoOnly.quality, isDash: false };
        }
      }
      
      successTracker.recordFailure('piped', instance);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      let errorType = 'ERROR';
      let errorMsg = e.message || 'unknown error';
      
      if (e.name === 'AbortError') {
        errorType = 'TIMEOUT';
        errorMsg = 'Request aborted (timeout)';
      } else if (e.code === 'ENOTFOUND') {
        errorType = 'DNS_ERROR';
        errorMsg = `DNS lookup failed: ${e.hostname || 'unknown host'}`;
      } else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') {
        errorType = 'CONNECTION_ERROR';
        errorMsg = `${e.code}: ${e.message}`;
      } else if (e.code) {
        errorType = e.code;
      }
      
      console.log(`  [Piped] ✗ ${instance}: ${errorType} after ${duration}ms - ${errorMsg}`);
      successTracker.recordFailure('piped', instance);
      return null;
    }
  };
  
  const results = await Promise.allSettled(sortedInstances.map(tryInstance));
  const successfulResults = results
    .map((r) => r.status === 'fulfilled' && r.value ? r.value : null)
    .filter(r => r !== null);
  
  if (successfulResults.length === 0) {
    logger.source('piped', `All ${sortedInstances.length} instances failed or timed out`, false);
    return null;
  }
  
  logger.source('piped', `${successfulResults.length}/${sortedInstances.length} instances succeeded`, true);
  
  // Find best quality result (prefer DASH, then highest quality combined stream)
  const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
  const sortedResults = successfulResults.sort((a, b) => {
    if (a.isDash && !b.isDash) return -1;
    if (!a.isDash && b.isDash) return 1;
    const rankA = qualityPriority.findIndex(p => (a.quality || '').toLowerCase().includes(p));
    const rankB = qualityPriority.findIndex(p => (b.quality || '').toLowerCase().includes(p));
    return (rankA === -1 ? 999 : rankA) - (rankB === -1 ? 999 : rankB);
  });
  
  if (sortedResults.length > 0 && sortedResults[0].isDash) {
    console.log(`  ✓ [Piped] Selected DASH manifest (highest quality available)`);
    return sortedResults[0];
  }
  
  if (sortedResults.length > 0) {
    console.log(`  ✓ [Piped] Got URL from Piped (quality: ${sortedResults[0].quality || 'unknown'}, from ${successfulResults.length}/${sortedInstances.length} instances)`);
    return sortedResults[0];
  }
  
  return null;
}

// ============ INVIDIOUS EXTRACTOR ============

const INVIDIOUS_INSTANCES = [
  'https://yewtu.be',
  'https://vid.puffyan.us',
  'https://invidious.kavin.rocks',
  'https://invidious.private.coffee',
  'https://inv.tux.pizza',
  'https://invidious.darkness.services',
  'https://invidious.f5.si',
  'https://inv.perditum.com',
  'https://invidious.privacyredirect.com',
  'https://invidious.slipfox.xyz',
  'https://inv.zzls.xyz',
  'https://inv.nadeko.net',
  // Additional instances to try
  'https://invidious.flokinet.to',
  'https://invidious.osi.kr',
  'https://invidious.io.lol',
  'https://invidious.nerdvpn.de',
  'https://invidious.esmailelbob.xyz',
];

async function extractViaInvidious(youtubeKey) {
  // Sort instances by success rate (highest first)
  const sortedInstances = successTracker.sortBySuccessRate('invidious', INVIDIOUS_INSTANCES);
  const top3 = sortedInstances.slice(0, 3).map(inst => {
    const rate = successTracker.getSuccessRate('invidious', inst);
    return `${inst.split('//')[1].split('/')[0]} (${(rate * 100).toFixed(0)}%)`;
  }).join(', ');
  console.log(`  [Invidious] Trying ${sortedInstances.length} instances for ${youtubeKey} (sorted by success rate - top 3: ${top3})...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // 4s timeout - balance between speed and reliability
    const startTime = Date.now();
    
    try {
      const url = `${instance}/api/v1/videos/${youtubeKey}`;
      console.log(`  [Invidious] Trying ${instance}...`);
      
      const response = await fetch(url, {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      
      if (!response.ok) {
        const statusText = response.statusText || 'Unknown';
        console.log(`  [Invidious] ✗ ${instance}: HTTP ${response.status} ${statusText} (${duration}ms)`);
        successTracker.recordFailure('invidious', instance);
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        const preview = text.substring(0, 150).replace(/\n/g, ' ');
        console.log(`  [Invidious] ✗ ${instance}: non-JSON response (${contentType || 'no content-type'}): ${preview}`);
        successTracker.recordFailure('invidious', instance);
        return null;
      }
      
      const data = await response.json();
      
      // Check for error in response
      if (data.error) {
        console.log(`  [Invidious] ✗ ${instance}: API error: ${data.error} (${duration}ms)`);
        successTracker.recordFailure('invidious', instance);
        return null;
      }
      
      console.log(`  [Invidious] ✓ ${instance}: got response (${duration}ms), formatStreams: ${data.formatStreams?.length || 0}, adaptiveFormats: ${data.adaptiveFormats?.length || 0}`);
      
      const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
      const getQualityRank = (label) => {
        if (!label) return 999;
        const labelLower = String(label).toLowerCase();
        const idx = qualityPriority.findIndex(q => labelLower.includes(q));
        return idx === -1 ? 998 : idx;
      };
      
      // PRIORITY 1: Try adaptiveFormats first (usually higher quality, DASH)
      if (data.adaptiveFormats?.length > 0) {
        // Filter for video formats with quality label
        const videoFormats = data.adaptiveFormats
          .filter(f => f.type?.startsWith('video/') && f.qualityLabel)
          .map(f => ({
            url: f.url,
            quality: f.qualityLabel,
            mimeType: f.type,
            itag: f.itag
          }));
        
        if (videoFormats.length > 0) {
          // Sort by quality (highest first)
          const sorted = videoFormats.sort((a, b) => getQualityRank(a.quality) - getQualityRank(b.quality));
          const best = sorted[0];
          console.log(`  ✓ [Invidious] ${instance}: got ${best.quality || 'unknown'} from adaptiveFormats`);
          successTracker.recordSuccess('invidious', instance);
          return { url: best.url, quality: best.quality, isDash: false };
        }
      }
      
      // PRIORITY 2: Fallback to formatStreams (combined video+audio, lower quality)
      if (data.formatStreams?.length > 0) {
        const sorted = [...data.formatStreams]
          .filter(s => s.container === 'mp4' || s.mimeType?.includes('mp4'))
          .sort((a, b) => getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel));
        
        if (sorted.length > 0) {
          const best = sorted[0];
          console.log(`  ✓ [Invidious] ${instance}: got ${best.qualityLabel || 'unknown'} from formatStreams`);
          successTracker.recordSuccess('invidious', instance);
          return { url: best.url, quality: best.qualityLabel || 'unknown', isDash: false };
        }
      }
      
      console.log(`  ✗ [Invidious] ${instance}: No valid video streams found`);
      successTracker.recordFailure('invidious', instance);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      let errorType = 'ERROR';
      let errorMsg = e.message || 'unknown error';
      
      if (e.name === 'AbortError') {
        errorType = 'TIMEOUT';
        errorMsg = 'Request aborted (timeout)';
      } else if (e.code === 'ENOTFOUND') {
        errorType = 'DNS_ERROR';
        errorMsg = `DNS lookup failed: ${e.hostname || 'unknown host'}`;
      } else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') {
        errorType = 'CONNECTION_ERROR';
        errorMsg = `${e.code}: ${e.message}`;
      } else if (e.code) {
        errorType = e.code;
      }
      
      console.log(`  [Invidious] ✗ ${instance}: ${errorType} after ${duration}ms - ${errorMsg}`);
      successTracker.recordFailure('invidious', instance);
      return null;
    }
  };
  
  const results = await Promise.allSettled(sortedInstances.map(tryInstance));
  const successfulResults = results
    .map((r) => r.status === 'fulfilled' && r.value ? r.value : null)
    .filter(r => r !== null);
  
  if (successfulResults.length > 0) {
    // Sort by quality and return best
    const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
    const sorted = successfulResults.sort((a, b) => {
      const rankA = qualityPriority.findIndex(p => (a.quality || '').toLowerCase().includes(p));
      const rankB = qualityPriority.findIndex(p => (b.quality || '').toLowerCase().includes(p));
      return (rankA === -1 ? 999 : rankA) - (rankB === -1 ? 999 : rankB);
    });
    
    const best = sorted[0];
    const successCount = successfulResults.length;
    console.log(`  ✓ [Invidious] Got URL from Invidious (quality: ${best.quality || 'unknown'}, from ${successCount}/${sortedInstances.length} instances)`);
    return best;
  }
  
  console.log(`  ✗ [Invidious] All ${sortedInstances.length} instances failed or timed out`);
  return null;
}

// ============ SITE-SPECIFIC URL RESOLVERS ============
// These functions search each site and return the actual trailer page URL

async function resolveRottenTomatoesSlug(tmdbMeta, imdbId) {
  // RottenTomatoes: yt-dlp does NOT have a dedicated extractor
  // These sites typically embed YouTube videos anyway
  // DISABLED - not supported by yt-dlp
  return null;
}

async function resolveMetacriticSlug(tmdbMeta, imdbId) {
  // Metacritic: yt-dlp may not have a dedicated extractor
  // Try constructing URL - if yt-dlp doesn't support it, it will fail gracefully
  const slug = tmdbMeta.title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return `https://www.metacritic.com/movie/${slug}`;
}

async function resolveAppleTrailersUrl(tmdbMeta, imdbId) {
  // Apple Trailers: yt-dlp supports appletrailers extractor
  // But search queries don't work reliably - need to find the actual movie page
  // Try using Apple's quickfind API to get the actual trailer page URL
  try {
    const searchUrl = `https://trailers.apple.com/trailers/home/scripts/quickfind.php?q=${encodeURIComponent(tmdbMeta.title)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      // Look for matching movie in results
      if (Array.isArray(data) && data.length > 0) {
        for (const item of data) {
          const titleMatch = normalizeTitle(item.title || '') === normalizeTitle(tmdbMeta.title);
          if (titleMatch && item.location) {
            return `https://trailers.apple.com${item.location}`;
          }
        }
        // If no exact match, return first result
        if (data[0] && data[0].location) {
          return `https://trailers.apple.com${data[0].location}`;
        }
      }
    }
  } catch (error) {
    // Fallback: return search page (yt-dlp might handle it)
  }
  
  // Fallback: return search page (yt-dlp may be able to extract from it)
  return `https://trailers.apple.com/trailers/search/?q=${encodeURIComponent(tmdbMeta.title)}`;
}

async function resolveAllocineUrl(tmdbMeta, imdbId) {
  // Allocine: yt-dlp has allocine extractor but it's unreliable
  // DISABLED - not reliable enough
  return null;
}

async function resolveMoviepilotUrl(tmdbMeta, imdbId) {
  // Moviepilot: yt-dlp does NOT have a dedicated extractor
  // DISABLED - not supported by yt-dlp
  return null;
}

async function resolveImdbTrailerUrl(tmdbMeta, imdbId) {
  // IMDb: yt-dlp supports imdb extractor but only from specific pages
  // The title page doesn't work - need to use videogallery or video page
  if (!imdbId || !imdbId.startsWith('tt')) {
    return null;
  }
  
  // IMDb videogallery page - yt-dlp can extract from this
  // Format: https://www.imdb.com/title/{imdbId}/videogallery
  return `https://www.imdb.com/title/${imdbId}/videogallery`;
}

async function resolveIvaUrl(tmdbMeta, imdbId) {
  // Internet Video Archive structure: https://www.internetvideoarchive.com/video/{imdbId}
  // If we have IMDb ID, use it directly (most reliable)
  if (imdbId && imdbId.startsWith('tt')) {
    return `https://www.internetvideoarchive.com/video/${imdbId}`;
  }
  
  // Fallback: search by title
  try {
    const searchUrl = `https://www.internetvideoarchive.com/search?q=${encodeURIComponent(tmdbMeta.title)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const html = await response.text();
      // Look for video links in search results
      // IVA video URLs: /video/{imdbId} or /video/{title-slug}
      const videoLinkRegex = /href="(\/video\/[^"]+)"/g;
      const matches = [...html.matchAll(videoLinkRegex)];
      
      if (matches.length > 0) {
        // Return first match
        return `https://www.internetvideoarchive.com${matches[0][1]}`;
      }
    }
  } catch (error) {
    // Fallback: return search URL
  }
  
  // Fallback: return search URL (yt-dlp may be able to extract from it)
  return `https://www.internetvideoarchive.com/search?q=${encodeURIComponent(tmdbMeta.title)}`;
}

async function resolveVimeoUrl(tmdbMeta, imdbId) {
  // Vimeo: TMDB provides the video ID/key, construct URL directly
  // Vimeo URLs: https://vimeo.com/{videoId}
  // If we have it from TMDB, use it; otherwise search
  if (tmdbMeta.trailerUrl && tmdbMeta.trailerSite === 'Vimeo') {
    return tmdbMeta.trailerUrl;
  }
  
  // Fallback: search Vimeo (yt-dlp supports vimeo:search)
  // For now, return null - we'll rely on TMDB providing the URL
  return null;
}

async function resolveDailymotionUrl(tmdbMeta, imdbId) {
  // Dailymotion: TMDB provides the video ID/key, construct URL directly
  // Dailymotion URLs: https://www.dailymotion.com/video/{videoId}
  // If we have it from TMDB, use it; otherwise search
  if (tmdbMeta.trailerUrl && tmdbMeta.trailerSite === 'Dailymotion') {
    return tmdbMeta.trailerUrl;
  }
  
  // Fallback: search Dailymotion (yt-dlp supports dailymotion:search)
  // For now, return null - we'll rely on TMDB providing the URL
  return null;
}

// ============ YT-DLP EXTRACTOR (Generic - supports multiple sites) ============

// YouTube-specific extractor (wrapper around generic)
async function extractViaYtDlp(youtubeKey) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  return await extractViaYtDlpGeneric(youtubeUrl, 'YouTube');
}

// Proxy rotation for multiple Cloudflare Warp instances
const proxyInstances = [
  // gluetun-1 removed - using only gluetun-2 and gluetun-3
  { name: 'gluetun-2', proxy: 'http://gluetun-2:8888', status: 'http://gluetun-2:8000/v1/openvpn/status' },
  { name: 'gluetun-3', proxy: 'http://gluetun-3:8888', status: 'http://gluetun-3:8000/v1/openvpn/status' }
];

// Track proxy success rates for smart selection
const proxyTracker = {
  proxies: new Map(), // proxy name -> { success: number, total: number, lastUsed: timestamp }
  
  recordSuccess(proxyName) {
    if (!this.proxies.has(proxyName)) {
      this.proxies.set(proxyName, { success: 0, total: 0, lastUsed: 0 });
    }
    const stats = this.proxies.get(proxyName);
    stats.success++;
    stats.total++;
    stats.lastUsed = Date.now();
  },
  
  recordFailure(proxyName) {
    if (!this.proxies.has(proxyName)) {
      this.proxies.set(proxyName, { success: 0, total: 0, lastUsed: 0 });
    }
    const stats = this.proxies.get(proxyName);
    stats.total++;
    stats.lastUsed = Date.now();
  },
  
  getSuccessRate(proxyName) {
    const stats = this.proxies.get(proxyName);
    if (!stats || stats.total === 0) return 0.5; // Default 50% for untested
    return stats.success / stats.total;
  },
  
  // Get available proxies sorted by success rate (best first)
  getAvailableProxies() {
    return proxyInstances.filter(instance => {
      // Check if proxy is available (we'll check health in real-time)
      return true; // Assume available, check health when using
    }).sort((a, b) => {
      const rateA = this.getSuccessRate(a.name);
      const rateB = this.getSuccessRate(b.name);
      return rateB - rateA; // Sort descending (best first)
    });
  }
};

// Generic extractor that works with any URL supported by yt-dlp
// Uses multiple Cloudflare Warp proxies with IP rotation to avoid bot detection
async function extractViaYtDlpGeneric(videoUrl, siteName = 'unknown') {
  console.log(`  [yt-dlp] Extracting streamable URL from ${siteName}: ${videoUrl}...`);
  
  const startTime = Date.now();
  const EXTRACTION_TIMEOUT = 15000; // 15 seconds - proxy can be slow, yt-dlp needs time
  
  // Get available proxies sorted by success rate
  const availableProxies = proxyTracker.getAvailableProxies();
  
  // Check which proxies are actually available (health check with better error handling)
  const proxyChecks = await Promise.allSettled(
    availableProxies.map(async (instance) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000); // 2 second timeout
        
        try {
          const response = await fetch(instance.status, {
            signal: controller.signal,
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });
          clearTimeout(timeout);
          
          if (response && response.ok) {
            console.log(`  [yt-dlp] ✓ Proxy ${instance.name} is healthy`);
            return instance;
          } else {
            console.log(`  [yt-dlp] ⚠ Proxy ${instance.name} health check returned ${response?.status || 'no response'}`);
            return null;
          }
        } catch (error) {
          clearTimeout(timeout);
          // Log the error for debugging
          if (error.name !== 'AbortError') {
            console.log(`  [yt-dlp] ⚠ Proxy ${instance.name} health check failed: ${error.message}`);
          }
          return null;
        }
      } catch (error) {
        console.log(`  [yt-dlp] ⚠ Proxy ${instance.name} health check error: ${error.message}`);
        return null;
      }
    })
  );
  
  const workingProxies = proxyChecks
    .map((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        return result.value;
      } else if (result.status === 'rejected') {
        console.log(`  [yt-dlp] ⚠ Proxy check rejected: ${result.reason?.message || 'unknown error'}`);
      }
      return null;
    })
    .filter(p => p !== null);
  
  // If health check failed but we have proxy instances configured, try them anyway
  // Health check might fail due to network issues, but proxies might still work
  const proxiesToTry = workingProxies.length > 0 ? workingProxies : availableProxies;
  
  if (workingProxies.length === 0 && availableProxies.length > 0) {
    console.log(`  [yt-dlp] ⚠ Health check failed for all proxies, but will try them anyway (${availableProxies.length} configured)`);
    console.log(`  [yt-dlp] ⚠ Proxy instances: ${availableProxies.map(p => `${p.name} (${p.proxy})`).join(', ')}`);
  } else if (workingProxies.length > 0) {
    console.log(`  [yt-dlp] ✓ Found ${workingProxies.length}/${availableProxies.length} Cloudflare Warp proxy(ies) available: ${workingProxies.map(p => p.name).join(', ')}`);
  } else {
    console.log(`  [yt-dlp] ⚠ No Cloudflare Warp proxies configured, will try direct (may get blocked)`);
  }
  
  // Optimized yt-dlp command (use proxy if available)
  const buildCommand = (proxyUrl) => {
    const proxyFlag = proxyUrl ? `--proxy ${proxyUrl}` : '';
    // Format: Get single streamable URL (progressive mp4 preferred for direct streaming)
    // Avoid DASH formats that require merging - use progressive formats when possible
    // For --get-url, we want a single URL, so prefer formats that don't need merging
    return `yt-dlp ${proxyFlag} \
      --no-download \
      --no-warnings \
      --quiet \
      --no-playlist \
      --format "best[height<=1080][ext=mp4][protocol=https]/best[height<=1080][ext=mp4]/best[height<=1080][protocol=https]/best[height<=1080]/best[ext=mp4]/best" \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
      --referer "${videoUrl}" \
      --socket-timeout 20 \
      --extractor-args "youtube:player_client=android,web;youtube:player_skip=webpage" \
      --get-url \
      "${videoUrl}"`.replace(/\s+/g, ' ').trim();
  };
  
  const tryExtraction = async (proxyInstance, attemptName) => {
    const proxyUrl = proxyInstance ? proxyInstance.proxy : null;
    const command = buildCommand(proxyUrl);
    const proxyName = proxyInstance ? proxyInstance.name : 'direct';
    console.log(`  [yt-dlp] Attempt ${attemptName} (proxy: ${proxyName})...`);
    
    try {
      // execAsync already has timeout built-in, no need for Promise.race
      const { stdout, stderr } = await execAsync(command, {
        timeout: EXTRACTION_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024
      });
      
      if (stderr && !stderr.includes('WARNING') && stderr.trim().length > 0) {
        console.log(`  [yt-dlp] Warning: ${stderr.substring(0, 200)}`);
      }
      
      const url = stdout.trim();
      if (url && url.startsWith('http')) {
        // Record success for this proxy
        if (proxyInstance) {
          proxyTracker.recordSuccess(proxyInstance.name);
        }
        
        // Verify it's a streamable URL (not a manifest or download link)
        // YouTube DASH manifests end with .m3u8 or have 'manifest' in URL - we want direct video URLs
        if (url.includes('.m3u8') || url.includes('manifest') || url.includes('googlevideo.com/videoplayback')) {
          // This is a streamable URL (YouTube uses googlevideo.com for streaming)
          const duration = Date.now() - startTime;
          console.log(`  [yt-dlp] ✓ Got streamable URL (${duration}ms, ${attemptName})`);
          return url;
        } else if (url.includes('googlevideo.com') || url.endsWith('.mp4') || url.endsWith('.m4v') || url.endsWith('.webm')) {
          // Direct video file URL - streamable
          const duration = Date.now() - startTime;
          console.log(`  [yt-dlp] ✓ Got streamable URL (${duration}ms, ${attemptName})`);
          return url;
        } else {
          // Might be a manifest or unsupported format - log it but return anyway
          console.log(`  [yt-dlp] ⚠ Got URL but format unclear: ${url.substring(0, 100)}...`);
          const duration = Date.now() - startTime;
          console.log(`  [yt-dlp] ✓ Got URL (${duration}ms, ${attemptName})`);
          return url; // Return anyway, let the player handle it
        }
      }
      
      return null;
    } catch (error) {
      // Record failure for this proxy
      if (proxyInstance) {
        proxyTracker.recordFailure(proxyInstance.name);
      }
      
      const duration = Date.now() - startTime;
      const errorMsg = (error.stderr || error.message || '').toString();
      
      // Bot detection - YouTube is blocking
      if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot') || errorMsg.includes('bot')) {
        console.log(`  [yt-dlp] ⚠ Bot detection triggered (YouTube blocking): ${videoUrl}`);
        console.log(`  [yt-dlp] Will try next proxy in rotation`);
        return null;
      }
      
      // Age-restricted videos can't be extracted without cookies
      if (errorMsg.includes('age-restricted')) {
        console.log(`  [yt-dlp] ⚠ Age-restricted video (requires cookies): ${videoUrl}`);
        return null;
      }
      
      // Log timeout or other errors
      if (error.message === 'yt-dlp timeout' || errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
        console.log(`  [yt-dlp] ✗ ${attemptName} timed out after ${duration}ms`);
      } else {
        const stderrMsg = error.stderr ? `\n    stderr: ${error.stderr.substring(0, 300)}` : '';
        console.log(`  [yt-dlp] ✗ ${attemptName} failed: ${errorMsg.substring(0, 200)}${stderrMsg}`);
      }
      
      return null;
    }
  };
  
  // Strategy 1: Try each available proxy in order (sorted by success rate)
  // Use proxiesToTry which includes all configured proxies even if health check failed
  for (const proxyInstance of proxiesToTry) {
    const result = await tryExtraction(proxyInstance, `proxy (${proxyInstance.name})`);
    if (result) {
      successTracker.recordSuccess('ytdlp', 'extraction');
      return { url: result, quality: 'best', isDash: false };
    }
    // If this proxy failed, try next one
    console.log(`  [yt-dlp] Proxy ${proxyInstance.name} failed, trying next...`);
  }
  
  // Strategy 2: If all proxies failed, try direct connection as last resort
  if (proxiesToTry.length > 0) {
    console.log(`  [yt-dlp] All ${proxiesToTry.length} proxy(ies) failed, trying direct connection...`);
  } else {
    console.log(`  [yt-dlp] No proxies configured, trying direct connection...`);
  }
  const result = await tryExtraction(null, 'direct');
  if (result) {
    successTracker.recordSuccess('ytdlp', 'extraction');
    return { url: result, quality: 'best', isDash: false };
  }
  
  // All attempts failed
  const duration = Date.now() - startTime;
  console.log(`  [yt-dlp] ✗ All extraction attempts failed after ${duration}ms`);
  successTracker.recordFailure('ytdlp', 'extraction');
  return null;
}

// ============ INTERNET ARCHIVE EXTRACTOR ============

// Archive.org cookie management
const archiveCookieManager = {
  // Get a valid cookie string for Archive.org requests
  getCookie() {
    const stmt = db.prepare(`
      SELECT cookies FROM archive_cookies 
      WHERE is_valid = 1 
      ORDER BY last_used ASC, use_count ASC 
      LIMIT 1
    `);
    const row = stmt.get();
    if (row) {
      // Update last_used and increment use_count
      db.prepare(`
        UPDATE archive_cookies 
        SET last_used = strftime('%s', 'now'), use_count = use_count + 1 
        WHERE cookies = ?
      `).run(row.cookies);
      return row.cookies;
    }
    return null;
  },
  
  // Add a new cookie (from manually logged-in session)
  addCookie(cookies, email = null) {
    try {
      db.prepare(`
        INSERT INTO archive_cookies (cookies, email, created_at, last_used, is_valid, use_count)
        VALUES (?, ?, strftime('%s', 'now'), strftime('%s', 'now'), 1, 0)
      `).run(cookies, email);
      console.log(`[Archive.org] Added new cookie${email ? ` for ${email}` : ''}`);
      return true;
    } catch (error) {
      console.error(`[Archive.org] Failed to add cookie: ${error.message}`);
      return false;
    }
  },
  
  // Mark cookie as invalid (if it stops working)
  invalidateCookie(cookies) {
    db.prepare(`UPDATE archive_cookies SET is_valid = 0 WHERE cookies = ?`).run(cookies);
    console.log(`[Archive.org] Marked cookie as invalid`);
  },
  
  // Validate cookie by making a test request
  async validateCookie(cookies) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('https://archive.org/account/index.php', {
        method: 'HEAD',
        headers: {
          'Cookie': cookies,
          'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      return response.ok || response.status === 200;
    } catch (error) {
      return false;
    }
  }
};

async function extractViaInternetArchive(tmdbMeta, imdbId) {
  console.log(`  [Internet Archive] Searching for "${tmdbMeta.title}" (${tmdbMeta.year || ''})...`);
  
  // Get Archive.org cookie for authenticated requests (to avoid 401 errors)
  const archiveCookie = archiveCookieManager.getCookie();
  const cookieHeader = archiveCookie ? { 'Cookie': archiveCookie } : {};
  
  if (archiveCookie) {
    console.log(`  [Internet Archive] Using authenticated session (cookie available)`);
  } else {
    console.log(`  [Internet Archive] ⚠ No authenticated session - some files may return 401. Add cookies via POST /admin/archive-cookie`);
  }
  
  try {
    // Build search queries - use better Internet Archive query syntax
    const titleQuery = tmdbMeta.title.replace(/[^\w\s]/g, ' ').trim().replace(/\s+/g, ' ');
    const yearQuery = tmdbMeta.year ? ` AND year:${tmdbMeta.year}` : '';
    
    // Define search strategies with IDs for tracking
    // HIGHEST PRIORITY: IMDb ID exact match (gold standard - eliminates false positives)
    const searchStrategies = [];
    
    if (imdbId && imdbId.startsWith('tt')) {
      searchStrategies.push({
        id: 'archive_imdb_exact',
        query: `collection:movie_trailers AND external-identifier:("urn:imdb:${imdbId}")`,
        description: `IMDb ID ${imdbId} in movie_trailers (exact match)`
      });
      console.log(`  [Internet Archive] Added IMDb ID search strategy for ${imdbId}`);
    }
    
    // Add title-based strategies (fallback if no IMDb ID or IMDb ID doesn't match)
    const titleStrategies = [
      {
        id: 'archive_collection_title_year',
        query: `collection:movie_trailers AND title:${encodeURIComponent(titleQuery)}${yearQuery}`,
        description: 'Title + year in movie_trailers collection'
      },
      {
        id: 'archive_collection_title',
        query: `collection:movie_trailers AND title:${encodeURIComponent(titleQuery)}`,
        description: 'Title in movie_trailers (no year)'
      },
      {
        id: 'archive_title_trailer_year',
        query: `title:${encodeURIComponent(titleQuery + ' trailer')}${yearQuery}`,
        description: 'Title + "trailer" with year'
      },
      {
        id: 'archive_title_trailer',
        query: `title:${encodeURIComponent(titleQuery + ' trailer')}`,
        description: 'Title + "trailer" (no year)'
      }
    ];
    searchStrategies.push(...titleStrategies);
    
    // Add original title strategy if different
    if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
      const originalTitleQuery = tmdbMeta.originalTitle.replace(/[^\w\s]/g, ' ').trim();
      searchStrategies.push({
        id: 'archive_collection_original_year',
        query: `collection:movie_trailers AND title:${encodeURIComponent(originalTitleQuery)}${yearQuery}`,
        description: 'Original title + year in movie_trailers'
      });
    }
    
    // Add TMDB trailer title strategy if available (high priority - exact match)
    if (tmdbMeta.youtubeTrailerTitle && tmdbMeta.youtubeTrailerTitle.trim().length > 0) {
      // Clean up the trailer title - remove common prefixes/suffixes that might not be in Archive
      let trailerTitle = tmdbMeta.youtubeTrailerTitle
        .replace(/^(Official\s+)?(International\s+)?(Trailer|Teaser|Clip)/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      // Only use if it's meaningful (not just "Trailer" or empty)
      if (trailerTitle.length > 3 && trailerTitle.toLowerCase() !== 'trailer') {
        const trailerTitleQuery = trailerTitle.replace(/[^\w\s]/g, ' ').trim();
        searchStrategies.push({
          id: 'archive_trailer_title',
          query: `collection:movie_trailers AND title:${encodeURIComponent(trailerTitleQuery)}`,
          description: `TMDB trailer title "${trailerTitle}" in movie_trailers`
        });
        
        // Also try with year if available
        if (tmdbMeta.year) {
          searchStrategies.push({
            id: 'archive_trailer_title_year',
            query: `collection:movie_trailers AND title:${encodeURIComponent(trailerTitleQuery)}${yearQuery}`,
            description: `TMDB trailer title "${trailerTitle}" + year in movie_trailers`
          });
        }
      }
    }
    
    // Sort strategies by success rate (highest first)
    const strategyIds = searchStrategies.map(s => s.id);
    const sortedIds = successTracker.sortBySuccessRate('archive', strategyIds);
    const sortedStrategies = sortedIds.map(id => searchStrategies.find(s => s.id === id)).filter(s => s !== undefined);
    
    const strategyRates = sortedStrategies.slice(0, 3).map(s => {
      const rate = successTracker.getSuccessRate('archive', s.id);
      return `${s.description} (${(rate * 100).toFixed(0)}%)`;
    }).join(', ');
    // Limit to top 3 strategies for speed (instead of trying all 7)
    const strategiesToTry = sortedStrategies.slice(0, 3);
    console.log(`  [Internet Archive] Trying ${strategiesToTry.length} strategies (top 3 by success rate: ${strategyRates})...`);
    
    for (const strategy of strategiesToTry) {
      // Use AdvancedSearch API (the correct API for Internet Archive)
      // Optimized field list: only request what we need (30% faster responses)
      // Added external-identifier to get IMDb IDs for better matching
      // Format: https://archive.org/advancedsearch.php?q=query&fl=fields&sort[]=field+order&rows=N&output=json
      const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(strategy.query)}&fl=identifier,title,year,external-identifier,downloads&sort[]=downloads+desc&rows=20&output=json&page=1`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
      const startTime = Date.now();
      
      try {
        // Retry logic for 502/503/504 errors (temporary server issues)
        let response = null;
        const maxRetries = 2;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), 8000);
            
            response = await fetch(searchUrl, { 
              signal: retryController.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)',
                'Accept': 'application/json',
                ...cookieHeader
              }
            });
            clearTimeout(retryTimeout);
            
            if (response.ok) {
              break; // Success, exit retry loop
            }
            
            // If 502/503/504 and we have retries left, wait and retry
            if ([502, 503, 504].includes(response.status) && attempt < maxRetries) {
              console.log(`  [Internet Archive] HTTP ${response.status} on attempt ${attempt + 1}, retrying...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
              continue;
            }
            
            // Not a retryable error or out of retries
            break;
          } catch (fetchError) {
            if (attempt < maxRetries && fetchError.name !== 'AbortError') {
              console.log(`  [Internet Archive] Network error on attempt ${attempt + 1}: ${fetchError.message}, retrying...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
              continue;
            }
            if (fetchError.name === 'AbortError') {
              console.log(`  [Internet Archive] Request aborted (timeout) on attempt ${attempt + 1}`);
            }
            throw fetchError;
          }
        }
        
        clearTimeout(timeout);
        const duration = Date.now() - startTime;
        
        if (!response || !response.ok) {
          const status = response ? response.status : 'NO_RESPONSE';
          const statusText = response ? response.statusText : 'No response';
          console.log(`  [Internet Archive] ✗ Search failed: HTTP ${status} ${statusText} (${duration}ms) for strategy "${strategy.description}" after ${maxRetries + 1} attempts`);
          successTracker.recordFailure('archive', strategy.id);
          continue;
        }
        
        // Check content type before parsing
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          const text = await response.text();
          const preview = text.substring(0, 200).replace(/\n/g, ' ');
          console.log(`  [Internet Archive] ✗ Non-JSON response (${contentType}): ${preview}`);
          successTracker.recordFailure('archive', strategy.id);
          continue;
        }
        
        // Parse AdvancedSearch API response
        const data = await response.json();
        const docs = data.response?.docs || [];
        
        console.log(`  [Internet Archive] ✓ AdvancedSearch API returned ${docs.length} results (${duration}ms) for strategy "${strategy.description}"`);
        
        if (docs.length === 0) {
          successTracker.recordFailure('archive', strategy.id);
          continue;
        }
        
        // Find best match using fuzzy matching (like iTunes)
        // Filter out YouTube shorts, clips, and non-trailer content
        let bestMatch = null;
        let bestScore = 0;
        
        for (const doc of docs) {
          const docTitle = doc.title || '';
          const docYear = doc.year || null;
          
          // Skip YouTube shorts, clips, and non-trailer content
          const titleLower = docTitle.toLowerCase();
          if (titleLower.includes('#shorts') || titleLower.includes('shorts') || 
              (titleLower.includes('clip') && !titleLower.includes('trailer')) ||
              titleLower.includes('behind the scenes') || titleLower.includes('featurette')) {
            continue; // Skip shorts and non-trailer content
          }
          
          // Extract IMDb ID from external-identifier if present (for better matching)
          const externalIds = Array.isArray(doc['external-identifier']) ? doc['external-identifier'] : (doc['external-identifier'] ? [doc['external-identifier']] : []);
          const docImdbId = externalIds.find(id => id && id.startsWith('urn:imdb:'))?.replace('urn:imdb:', '') || null;
          
          // GOLD STANDARD: If this result has an IMDb ID and it matches, this is definitely correct
          if (imdbId && docImdbId && docImdbId === imdbId) {
            console.log(`  [Internet Archive] ✓ Found exact IMDb ID match: ${imdbId} for "${docTitle}"`);
            // This is the best possible match - use it immediately
            bestMatch = doc;
            bestScore = 1.0; // Perfect score
            break; // Exit loop, we found the best match
          }
          
          // Use fuzzy matching for better accuracy
          const normTitle = normalizeTitle(docTitle);
          const normSearchTitle = normalizeTitle(tmdbMeta.title);
          const normOriginalTitle = normalizeTitle(tmdbMeta.originalTitle);
          
          // Calculate fuzzy match first to use as a filter
          const titleFuzzy = fuzzyMatch(normTitle, normSearchTitle);
          const originalFuzzy = fuzzyMatch(normTitle, normOriginalTitle);
          const bestFuzzy = Math.max(titleFuzzy, originalFuzzy);
          
          // Require minimum fuzzy match (0.5) to even consider this result
          // This prevents completely unrelated matches like "War" matching "Wire"
          if (bestFuzzy < 0.5) {
            continue; // Skip this result entirely
          }
          
          let score = 0;
          
          // Bonus for IMDb ID match (even if not exact, suggests it's the right movie)
          if (imdbId && docImdbId && docImdbId === imdbId) {
            score += 0.5; // Strong indicator this is correct
          }
          
          // CRITICAL: Reject if IMDb ID exists but doesn't match (for any title length)
          if (imdbId && docImdbId && docImdbId !== imdbId) {
            // Different IMDb ID - definitely wrong movie/show
            continue; // Reject immediately
          }
          
          // For short/generic titles (1-2 words), require much stricter matching
          const searchWords = normSearchTitle.split(' ').filter(w => w.length > 2); // Ignore short words
          const isShortTitle = searchWords.length <= 2;
          const isSingleWord = searchWords.length === 1;
          const titleWords = normTitle.split(' ');
          const matchingWords = searchWords.filter(word => titleWords.includes(word));
          const wordMatchRatio = searchWords.length > 0 ? matchingWords.length / searchWords.length : 0;
          
          // Check if result title has a colon (subtitle) - this often indicates a different movie
          // e.g., "Rocketman" should not match "Rocketman: Mad Mike's Mission..."
          const hasSubtitle = normTitle.includes(':');
          const titlePrefix = hasSubtitle ? normTitle.split(':')[0].trim() : normTitle;
          
          // CRITICAL: For single-word titles, require the word to START the result title
          // e.g., "Friends" should NOT match "Hart to Hart: Old Friends Never Die"
          // e.g., "Coco" should NOT match "Coco Chanel" or "Coco Before Chanel"
          if (isSingleWord) {
            const searchWord = searchWords[0];
            // Check if the search word appears at the START of the title (or is the whole title)
            const titleStartsWithSearch = normTitle.startsWith(searchWord + ' ') || 
                                          normTitle.startsWith(searchWord + ':') ||
                                          normTitle.startsWith(searchWord + '-') ||
                                          normTitle === searchWord;
            
            if (!titleStartsWithSearch) {
              // Search word appears but not at start - likely a different movie/show
              // Only allow if IMDb ID matches exactly (already checked above)
              if (!imdbId || !docImdbId || docImdbId !== imdbId) {
                continue; // Reject - this is a false positive
              }
            }
          }
          
          // Use docTitle (not title) for all references below
          
          // Title matching (most important) - be more strict
          if (normTitle === normSearchTitle) {
            score += 1.0; // Exact match
          } else if (normTitle === normOriginalTitle) {
            score += 0.9; // Exact match with original title
          } else {
            // For short titles, require very high word match ratio AND no subtitle mismatch
            if (isShortTitle) {
              // For single-word titles, require IMDb ID match OR very high fuzzy match
              if (isSingleWord) {
                // If we have IMDb ID, it must match (already checked above)
                // If no IMDb ID, require very high fuzzy match (0.9+) AND exact word match
                if (!imdbId || !docImdbId) {
                  if (bestFuzzy < 0.9 || wordMatchRatio < 1.0) {
                    // Not confident enough without IMDb ID - reject
                    continue;
                  }
                }
              }
              
              // If result has a subtitle, check if the prefix matches exactly
              if (hasSubtitle) {
                // For short titles with subtitles, require exact prefix match
                // "Rocketman" should match "Rocketman - Official Trailer" but NOT "Rocketman: Mad Mike's..."
                // unless the subtitle is just "Official Trailer" or similar
                const subtitle = normTitle.split(':')[1]?.trim().toLowerCase() || '';
                const isOfficialTrailer = subtitle.includes('official') || subtitle.includes('trailer') || subtitle.includes('teaser');
                
                if (titlePrefix !== normSearchTitle && titlePrefix !== normOriginalTitle) {
                  // Prefix doesn't match - different movie
                  if (!isOfficialTrailer) {
                    // Not an official trailer subtitle - reject
                    continue;
                  }
                }
              }
              
              // Short titles like "Stephen" or "Troll 2" need almost perfect word matches
              if (wordMatchRatio >= 0.9 && searchWords.length === matchingWords.length) {
                // All words must match for short titles
                score += 0.7;
              } else if (wordMatchRatio >= 0.7 && bestFuzzy > 0.9) {
                // Very high fuzzy + good word match for short titles
                score += 0.5;
              } else {
                // Reject short titles that don't match well
                continue;
              }
            } else {
              // Longer titles can be more lenient
              if (wordMatchRatio >= 0.8) {
                // Most words match - likely correct
                score += 0.7;
              } else if (wordMatchRatio >= 0.5) {
                // Half words match - possible match
                score += 0.4;
              }
              
              // Fuzzy match as secondary check (already calculated above)
              // Only add fuzzy score if it's high enough and we have some word matches
              if (bestFuzzy > 0.85 && wordMatchRatio > 0.3) {
                score += 0.3;
              } else if (bestFuzzy > 0.9 && wordMatchRatio > 0.5) {
                score += 0.4;
              }
            }
          }
          
          // Check if title contains the movie title as a substring (but require it to be significant)
          const titleWithoutTrailer = normTitle.split(' trailer')[0].trim();
          const searchWithoutTrailer = normSearchTitle.split(' trailer')[0].trim();
          
          if (titleWithoutTrailer.includes(searchWithoutTrailer) && searchWithoutTrailer.length >= 5) {
            score += 0.2; // Reduced from 0.3
          } else if (searchWithoutTrailer.includes(titleWithoutTrailer) && titleWithoutTrailer.length >= 5) {
            score += 0.2; // Reduced from 0.3
          }
          
          // Trailer keyword bonus
          const lowerTitle = docTitle.toLowerCase();
          if (lowerTitle.includes('trailer')) {
            score += 0.2;
          } else if (lowerTitle.includes('preview') || lowerTitle.includes('teaser')) {
            score += 0.15;
          }
          
          // Year matching (using year field from API) - stricter for short/generic titles
          if (tmdbMeta.year && docYear) {
            const yearDiff = Math.abs(parseInt(docYear) - tmdbMeta.year);
            if (yearDiff === 0) {
              score += 0.3; // Exact year match
            } else if (yearDiff === 1) {
              score += 0.2; // Within 1 year (common for trailers)
            } else if (yearDiff <= 3) {
              score += 0.1; // Within 3 years
            } else if (yearDiff > 5) {
              // For short/generic titles, reject if year is very different
              if (isShortTitle && yearDiff > 10) {
                // Very different year for short title - likely wrong movie
                continue; // Reject
              }
              score -= 0.3; // Penalty for very different years
            }
          } else if (tmdbMeta.year && !docYear) {
            // No year in result - for short titles, this is risky
            if (isShortTitle && !imdbId) {
              // Short title without year and no IMDb ID - reject to avoid false positives
              continue;
            }
            score -= 0.1; // Slight penalty
          }
          
          // IMDb ID matching bonus (strongest indicator of correctness)
          if (docImdbId) {
            if (imdbId && docImdbId === imdbId) {
              // Exact match - already handled above with early exit, but keep for scoring
              score += 0.4; // Strong bonus
            } else {
              // Has IMDb ID but doesn't match - slight bonus (at least it's a real movie)
              score += 0.1;
            }
          }
          
          // Downloads bonus (more popular = more likely to be correct)
          if (doc.downloads) {
            const downloads = parseInt(doc.downloads) || 0;
            if (downloads > 1000) score += 0.1;
            if (downloads > 10000) score += 0.1;
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = doc;
          }
        }
        
        // If we have multiple candidates with uncertain scores (0.7-0.9) and no IMDb ID match,
        // use embeddings to rerank for better accuracy
        if (docs.length > 1 && bestScore >= 0.7 && bestScore < 0.9 && bestMatch) {
          // Check if we already had an IMDb ID match (if so, skip embeddings - we're confident)
          const hadImdbMatch = imdbId && docs.some(doc => {
            const externalIds = Array.isArray(doc['external-identifier']) ? doc['external-identifier'] : (doc['external-identifier'] ? [doc['external-identifier']] : []);
            const docImdbId = externalIds.find(id => id && id.startsWith('urn:imdb:'))?.replace('urn:imdb:', '');
            return docImdbId === imdbId;
          });
          
          if (!hadImdbMatch) {
            // Collect all candidates with decent scores for reranking
            const candidates = [];
            for (const doc of docs) {
              const title = doc.title || '';
              const normTitle = normalizeTitle(title);
              const normSearchTitle = normalizeTitle(tmdbMeta.title);
              const titleFuzzy = fuzzyMatch(normTitle, normSearchTitle);
              
              if (titleFuzzy >= 0.5) { // Only consider reasonable candidates
                candidates.push({
                  doc,
                  title,
                  year: doc.year || null,
                  score: titleFuzzy
                });
              }
            }
            
          }
        }
        
        // FIXED: Stricter matching requirements to avoid false positives (e.g., Alien → 911.mp4)
        // Use higher threshold for matches (0.75 - prioritize accuracy over coverage to avoid false positives)
        // For short titles or popular/recent titles, require even higher threshold OR IMDb ID match
        const isShortTitle = (tmdbMeta.title.split(' ').filter(w => w.length > 2).length <= 2);
        const isRecentTitle = tmdbMeta.year && (new Date().getFullYear() - tmdbMeta.year) < 10; // Last 10 years
        const requiresImdbMatch = isShortTitle && imdbId;
        // Higher threshold for short titles or recent popular titles (to avoid false positives)
        const matchThreshold = (requiresImdbMatch || isRecentTitle) ? 1.0 : 0.85; // Stricter: 1.0 for short/recent, 0.85 for others
        
        if (bestMatch) {
          const bestMatchImdbId = Array.isArray(bestMatch['external-identifier']) 
            ? bestMatch['external-identifier'].find(id => id && id.startsWith('urn:imdb:'))?.replace('urn:imdb:', '')
            : (bestMatch['external-identifier']?.startsWith('urn:imdb:') 
                ? bestMatch['external-identifier'].replace('urn:imdb:', '') 
                : null);
          
          const hasImdbMatch = imdbId && bestMatchImdbId && bestMatchImdbId === imdbId;
          
          // FIXED: Require "trailer"/"teaser"/"tv spot" keyword in title (to avoid matching random videos)
          const lowerTitle = (bestMatch.title || '').toLowerCase();
          const hasTrailerKeyword = lowerTitle.includes('trailer') || 
                                   lowerTitle.includes('teaser') || 
                                   lowerTitle.includes('tv spot') ||
                                   lowerTitle.includes('preview');
          
          // FIXED: Require all main title tokens (ignoring stop words like "the", "a", "an")
          const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
          const titleTokens = tmdbMeta.title.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));
          const matchTitleTokens = lowerTitle.split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));
          const allTokensMatch = titleTokens.length > 0 && 
            titleTokens.every(token => matchTitleTokens.some(mt => mt.includes(token) || token.includes(mt)));
          
          console.log(`  [Internet Archive] Best candidate: "${bestMatch.title}" (score: ${bestScore.toFixed(2)}, threshold: ${matchThreshold}, IMDb match: ${hasImdbMatch ? 'yes' : 'no'}, has trailer keyword: ${hasTrailerKeyword}, all tokens match: ${allTokensMatch})`);
          
          // FIXED: Additional validation - reject if missing critical requirements
          if (!hasImdbMatch && (!hasTrailerKeyword || !allTokensMatch)) {
            console.log(`  [Internet Archive] ✗ Rejected: missing trailer keyword or title tokens don't match`);
            successTracker.recordFailure('archive', strategy.id);
            continue; // Try next strategy
          }
        }
        
        if (bestMatch && bestScore >= matchThreshold) {
          console.log(`  [Internet Archive] ✓ Best match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
          // Get the video URL from the item metadata
          const identifier = bestMatch.identifier;
          const metadataUrl = `https://archive.org/metadata/${identifier}`;
          
          const metaController = new AbortController();
          const metaTimeout = setTimeout(() => metaController.abort(), 5000);
          
          try {
            const metaResponse = await fetch(metadataUrl, { 
              signal: metaController.signal,
              headers: { 
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)',
                ...cookieHeader
              }
            });
            clearTimeout(metaTimeout);
            if (!metaResponse.ok) {
              console.log(`  [Internet Archive] Metadata fetch failed: HTTP ${metaResponse.status} for "${bestMatch.title}"`);
              successTracker.recordFailure('archive', strategy.id);
              continue;
            }
            
            // Check response size to prevent memory issues
            const contentLength = metaResponse.headers.get('content-length');
            if (contentLength && parseInt(contentLength) > MAX_JSON_RESPONSE_SIZE) {
              console.log(`  [Internet Archive] Metadata too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB), skipping`);
              successTracker.recordFailure('archive', strategy.id);
              continue;
            }
            
            const metadata = await metaResponse.json();
            
            // Find the best video file (prefer mp4, then webm)
            const files = metadata.files || [];
            console.log(`  [Internet Archive] Metadata has ${files.length} files`);
            
            const videoFiles = files.filter(f => {
              if (!f.name) return false;
              
              const name = f.name.toLowerCase();
              const format = (f.format || '').toLowerCase();
              
              // Skip thumbnails, samples, images
              if (name.includes('thumb') || name.includes('sample') || 
                  name.includes('.jpg') || name.includes('.png') || name.includes('.gif') ||
                  name.includes('.txt') || name.includes('.xml') || name.includes('.json')) {
                return false;
              }
              
              // Check by format field
              if (format.includes('mp4') || format.includes('webm') || format.includes('h.264') || 
                  format.includes('mpeg') || format.includes('quicktime')) {
                return true;
              }
              
              // Check by file extension
              if (name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov') || 
                  name.endsWith('.avi') || name.endsWith('.mkv') || name.endsWith('.m4v')) {
                return true;
              }
              
              // Check by mime type if available
              if (f.mimeType && (f.mimeType.includes('video') || f.mimeType.includes('mp4') || f.mimeType.includes('webm'))) {
                return true;
              }
              
              return false;
            });
            
            console.log(`  [Internet Archive] Found ${videoFiles.length} potential video files out of ${files.length} total files`);
            
            if (videoFiles.length > 0) {
              // FIXED: Filter by duration bounds (20-300 seconds for trailers)
              // Archive.org metadata may have duration in seconds or as a string
              const filteredByDuration = videoFiles.filter(f => {
                if (!f.length) return true; // If no duration info, allow it (better than rejecting)
                
                let durationSeconds = null;
                if (typeof f.length === 'number') {
                  durationSeconds = f.length;
                } else if (typeof f.length === 'string') {
                  // Try to parse duration string (e.g., "00:02:30" or "150")
                  const parts = f.length.split(':');
                  if (parts.length === 3) {
                    // HH:MM:SS format
                    durationSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
                  } else {
                    durationSeconds = parseInt(f.length);
                  }
                }
                
                // Trailers should be 20-300 seconds (reject full movies or very short clips)
                if (durationSeconds !== null) {
                  if (durationSeconds < 20 || durationSeconds > 300) {
                    return false; // Too short (clip) or too long (full movie)
                  }
                }
                
                return true;
              });
              
              // If duration filtering removed all files, use original list (better than nothing)
              const filesToUse = filteredByDuration.length > 0 ? filteredByDuration : videoFiles;
              
              if (filteredByDuration.length < videoFiles.length) {
                console.log(`  [Internet Archive] Filtered ${videoFiles.length - filteredByDuration.length} files by duration (trailers should be 20-300 seconds)`);
              }
              
              // Sort by: 1) format preference (mp4 > webm > others), 2) size (larger = better quality)
              filesToUse.sort((a, b) => {
                const formatA = (a.format || '').toLowerCase();
                const formatB = (b.format || '').toLowerCase();
                
                // Prefer MP4
                const aIsMp4 = formatA.includes('mp4') || formatA.includes('h.264');
                const bIsMp4 = formatB.includes('mp4') || formatB.includes('h.264');
                if (aIsMp4 && !bIsMp4) return -1;
                if (!aIsMp4 && bIsMp4) return 1;
                
                // Then by size
                return (b.size || 0) - (a.size || 0);
              });
              
              const bestFile = filesToUse[0];
              // Archive.org direct video file URL for streaming
              // The metadata API may provide a direct URL, or we construct it
              let videoUrl;
              if (bestFile.name) {
                // Check if metadata provides a direct URL (some files have this)
                if (bestFile.url && bestFile.url.startsWith('http') && bestFile.url.includes(identifier)) {
                  // Use the URL from metadata if available
                  videoUrl = bestFile.url;
                } else {
                  // Construct direct download URL - this serves the actual video file
                  // Format: https://archive.org/download/{identifier}/{filename}
                  // The /download/ endpoint serves files directly and supports HTTP Range requests for streaming
                  // CRITICAL: Archive.org requires proper URL encoding, but some special characters need special handling
                  const filename = bestFile.name;
                  
                  // Archive.org URL encoding rules:
                  // - Spaces should be encoded as %20 (not +)
                  // - Slashes in filenames should remain as / (not %2F)
                  // - Most other special chars should be encoded
                  // - But Archive.org is lenient, so we try both encoded and unencoded
                  // First, try with proper encoding (spaces as %20, keep / as /)
                  let encodedFilename = filename
                    .replace(/\s/g, '%20')  // Spaces to %20
                    .replace(/#/g, '%23')   // # to %23
                    .replace(/\?/g, '%3F')   // ? to %3F
                    .replace(/&/g, '%26')   // & to %26
                    .replace(/=/g, '%3D')    // = to %3D
                    .replace(/\+/g, '%2B'); // + to %2B
                  
                  // Keep forward slashes as-is (Archive.org uses them for subdirectories)
                  // Don't encode other characters that might be valid in filenames
                  
                  videoUrl = `https://archive.org/download/${identifier}/${encodedFilename}`;
                  
                  // Validate URL format
                  try {
                    new URL(videoUrl); // Will throw if invalid
                  } catch (urlError) {
                    console.log(`  [Internet Archive] Invalid URL constructed, trying unencoded filename`);
                    // Fallback: try with minimal encoding (just spaces)
                    videoUrl = `https://archive.org/download/${identifier}/${filename.replace(/\s/g, '%20')}`;
                  }
                }
              } else {
                console.log(`  [Internet Archive] No video file name found in metadata`);
                successTracker.recordFailure('archive', strategy.id);
                continue;
              }
              
              // CRITICAL: Validate the URL is accessible before returning it
              // Archive.org sometimes returns 401 for restricted files, so we need to check
              try {
                const controller = new AbortController();
                const validationTimeout = setTimeout(() => controller.abort(), 3000); // 3s timeout for validation
                
                const validationResponse = await fetch(videoUrl, {
                  method: 'HEAD',
                  signal: controller.signal,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)',
                    'Range': 'bytes=0-1', // Just check first 2 bytes to validate access
                    ...cookieHeader
                  }
                });
                
                clearTimeout(validationTimeout);
                
                // Check if URL is accessible (200, 206 Partial Content, or 302 redirect are OK)
                if (validationResponse.status === 401 || validationResponse.status === 403) {
                  console.log(`  [Internet Archive] ⚠ URL requires authentication or is restricted (${validationResponse.status}): ${videoUrl.substring(0, 80)}...`);
                  // Try alternative: use /stream/ endpoint which might work for restricted files
                  // But /stream/ serves HTML, not direct video, so we need to extract the actual video URL
                  // For now, skip this file and try next match
                  successTracker.recordFailure('archive', strategy.id);
                  continue;
                } else if (validationResponse.status >= 400) {
                  console.log(`  [Internet Archive] ⚠ URL returned ${validationResponse.status}, trying next match...`);
                  successTracker.recordFailure('archive', strategy.id);
                  continue;
                } else {
                  console.log(`  [Internet Archive] ✓ URL validated (${validationResponse.status})`);
                }
              } catch (validationError) {
                // If validation fails (timeout, network error), still return the URL
                // The client can try to access it - might work even if HEAD fails
                console.log(`  [Internet Archive] ⚠ URL validation failed (${validationError.message}), but returning URL anyway`);
              }
              
              // Estimate quality from file size and format (Archive doesn't provide explicit quality)
              let quality = 'unknown';
              const fileSizeMB = (bestFile.size || 0) / 1024 / 1024;
              if (fileSizeMB > 100) quality = '1080p';
              else if (fileSizeMB > 50) quality = '720p';
              else if (fileSizeMB > 20) quality = '480p';
              else quality = '360p';
              
              console.log(`  ✓ [Internet Archive] Found: "${bestMatch.title}" (${bestFile.format || 'video'}, ${Math.round(fileSizeMB)}MB, est. ${quality}) via strategy "${strategy.description}"`);
              successTracker.recordSuccess('archive', strategy.id);
              return { url: videoUrl, quality: quality, isDash: false };
            } else {
              // Log first few file names for debugging
              const fileNames = files.slice(0, 5).map(f => f.name || 'unnamed').join(', ');
              console.log(`  [Internet Archive] No video files found. Sample files: ${fileNames}${files.length > 5 ? '...' : ''}`);
              successTracker.recordFailure('archive', strategy.id);
            }
          } catch (metaError) {
            clearTimeout(metaTimeout);
            console.log(`  [Internet Archive] Metadata fetch error for "${bestMatch.title}": ${metaError.message || 'timeout'}`);
            successTracker.recordFailure('archive', strategy.id);
            continue;
          }
        } else if (bestMatch) {
          // Match found but score too low (bestScore < 0.75) - rejected to avoid false positives
          console.log(`  [Internet Archive] ✗ Rejected match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)} < 0.75 threshold)`);
          successTracker.recordFailure('archive', strategy.id);
        } else {
          // No match found at all
          successTracker.recordFailure('archive', strategy.id);
        }
      } catch (e) {
        clearTimeout(timeout);
        console.log(`  [Internet Archive] Search error for strategy "${strategy.description}": ${e.message || 'timeout'}`);
        successTracker.recordFailure('archive', strategy.id);
        continue;
      }
    }
    
    console.log(`  ✗ [Internet Archive] No trailer found`);
    return null;
  } catch (e) {
    console.log(`  ✗ [Internet Archive] Error: ${e.message || 'unknown'}`);
    return null;
  }
}

async function multiPassSearch(tmdbMeta) {
  const searchType = tmdbMeta.mediaType === 'movie' ? 'movie' : 'tv';
  
  const titlesToTry = [tmdbMeta.title];
  
  if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
    titlesToTry.push(tmdbMeta.originalTitle);
  }
  
  const firstAlt = tmdbMeta.altTitles.find(t => !titlesToTry.includes(t));
  if (firstAlt) titlesToTry.push(firstAlt);
  
  console.log(`Titles to try: ${titlesToTry.join(', ')}`);
  
  const searchWithCountry = async (title, country) => {
    try {
      const results = await searchITunes({ term: title, country, type: searchType });
      if (results.length > 0) {
        successTracker.recordSuccess('itunes', country);
        return { results, country };
      } else {
        successTracker.recordFailure('itunes', country);
        return null;
      }
    } catch {
      successTracker.recordFailure('itunes', country);
      return null;
    }
  };
  
  // Search sequentially with delays to avoid rate limiting
  for (const title of titlesToTry) {
    console.log(`\nSearching countries sequentially for "${title}" (to avoid rate limiting)`);
    
    let bestOverall = null;
    
    // Sort countries by success rate (highest first)
    const sortedCountries = successTracker.sortBySuccessRate('itunes', COUNTRY_VARIANTS);
    const countryRates = sortedCountries.map(c => {
      const rate = successTracker.getSuccessRate('itunes', c);
      return `${c.toUpperCase()} (${(rate * 100).toFixed(0)}%)`;
    }).join(', ');
    console.log(`  [iTunes] Searching countries in order: ${countryRates}`);
    
    // Search countries one at a time with delays to avoid rate limiting
    for (const country of sortedCountries) {
      // Add delay between requests to avoid rate limiting (except first request)
      if (bestOverall) {
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
      }
      
      const result = await searchWithCountry(title, country);
      if (!result) continue;
      
      const match = findBestMatch(result.results, tmdbMeta);
      if (match && (!bestOverall || match.score > bestOverall.score)) {
        bestOverall = { ...match, country: result.country };
        // If we found a good match, stop searching other countries
        if (match.score >= MIN_SCORE_THRESHOLD + 0.2) {
          console.log(`✓ Good match found (score: ${match.score.toFixed(2)}), stopping search`);
          break;
        }
      }
    }
    
    if (bestOverall) {
      console.log(`✓ Best match from ${bestOverall.country.toUpperCase()}, score: ${bestOverall.score.toFixed(2)}`);
      return {
        found: true,
        previewUrl: bestOverall.item.previewUrl,
        trackId: bestOverall.item.trackId || bestOverall.item.collectionId,
        country: bestOverall.country
      };
    }
    
    // Add delay between title searches
    if (titlesToTry.indexOf(title) < titlesToTry.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  console.log('No match found across all passes');
  return { found: false };
}

// Quick URL validation - checks if URL is still accessible
// FIXED: Less aggressive validation - only invalidate on clear "gone" errors (404, 410)
// Don't invalidate on 403/429/5xx which might be temporary (rate limits, geo-blocking, etc.)
async function validateUrl(url, timeout = 3000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'Range': 'bytes=0-1', // Just check first byte to minimize bandwidth
        'User-Agent': 'Mozilla/5.0 (compatible; TrailerIO/1.0)'
      }
    });
    
    clearTimeout(timeoutId);
    
    // Accept 200 (OK) or 206 (Partial Content) as valid
    if (response.ok || response.status === 206) {
      return true;
    }
    
    // Only invalidate on clear "gone" errors (404, 410)
    // For 403/429/5xx, keep cache - might be temporary (rate limits, geo-blocking, CDN issues)
    if (response.status === 404 || response.status === 410) {
      return false; // File is gone - invalidate
    }
    
    // For other errors (403, 429, 5xx), keep cache - might work from client's network
    return true;
  } catch (error) {
    // Network errors, timeouts, etc. - don't invalidate, might work from client
    // Only invalidate on clear DNS/connection errors that indicate URL is truly broken
    if (error.name === 'AbortError') {
      // Timeout - keep cache, might work from client
      return true;
    }
    // Other network errors - keep cache (might be temporary)
    return true;
  }
}

function getCached(imdbId) {
  const cached = cache.get(imdbId);
  if (cached) {
    const hoursSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
    const sourceType = cached.source_type || 'youtube'; // Default to shortest TTL
    const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
    
    if (hoursSinceCheck < ttlHours) {
      return cached;
    }
  }
  return null;
}

async function getCachedWithValidation(imdbId) {
  const cached = getCached(imdbId);
  if (!cached || !cached.preview_url) {
    return cached;
  }
  
  // FIXED: Don't validate very fresh entries (< 12 hours) - just trust them
  // This prevents cache thrashing from temporary CDN issues (403/429 from googlevideo.com)
  const hoursSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
  const sourceType = cached.source_type || 'youtube';
  const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
  
  // Skip validation for very fresh entries (< 12 hours) - trust them
  if (hoursSinceCheck < 12) {
    return cached;
  }
  
  // For older entries, validate if 80% through TTL
  const shouldValidate = hoursSinceCheck > (ttlHours * 0.8);
  
  if (shouldValidate) {
    logger.cache('validate', `Validating cached URL for ${imdbId} (${sourceType}, ${hoursSinceCheck.toFixed(1)}h old)`);
    const isValid = await validateUrl(cached.preview_url);
    
    if (!isValid) {
      logger.cache('miss', `Cached URL is no longer valid, invalidating cache for ${imdbId}`);
      cache.delete(imdbId);
      // Also delete from database
      const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
      deleteStmt.run(imdbId);
      return null;
    }
    
    logger.cache('hit', `Cached URL is still valid for ${imdbId}`);
  }
  
  return cached;
}

function setCache(imdbId, data) {
  // Use try-catch with timeout protection for database writes
  // If DB is locked or slow, skip write (cache is in-memory anyway)
  // Determine source type from preview URL
  let sourceType = 'youtube'; // default
  if (data.preview_url) {
    if (data.preview_url.includes('itunes.apple.com') || data.preview_url.includes('video-ssl.itunes')) {
      sourceType = 'itunes';
    } else if (data.preview_url.includes('archive.org')) {
      sourceType = 'archive';
    } else {
      sourceType = 'youtube'; // Piped/Invidious
    }
  } else if (data.source) {
    // Use source from data if available
    sourceType = data.source === 'youtube' ? 'youtube' : data.source;
  }
  
  const timestamp = Date.now();
  const cacheData = {
    ...data,
    source_type: sourceType,
    timestamp: timestamp
  };
  
  // Save to in-memory cache immediately (non-blocking, no CPU overhead)
  cache.set(imdbId, cacheData);
  
  // Queue database write (batched for CPU efficiency)
  cacheWriteQueue.push({ imdbId, cacheData, sourceType, timestamp });
  
  // Batch writes every 200ms to reduce CPU overhead
  if (!cacheWriteTimer) {
    cacheWriteTimer = setImmediate(() => {
      _flushCacheWrites();
      cacheWriteTimer = null;
    });
  }
}

function _flushCacheWrites() {
  if (!cacheWriteQueue || cacheWriteQueue.length === 0) return;
  
  const writes = cacheWriteQueue.splice(0); // Clear queue
  
  // Batch execute all writes in a transaction (much faster, less CPU)
  const transaction = db.transaction((writes) => {
    const stmt = db.prepare(`
      INSERT INTO cache (imdb_id, preview_url, track_id, country, youtube_key, source_type, source, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(imdb_id) DO UPDATE SET
        preview_url = excluded.preview_url,
        track_id = excluded.track_id,
        country = excluded.country,
        youtube_key = excluded.youtube_key,
        source_type = excluded.source_type,
        source = excluded.source,
        timestamp = excluded.timestamp
    `);
    
    for (const { imdbId, cacheData, sourceType, timestamp } of writes) {
      stmt.run(
        imdbId,
        cacheData.preview_url || null,
        cacheData.track_id || null,
        cacheData.country || null,
        cacheData.youtube_key || null,
        sourceType,
        cacheData.source || null,
        timestamp
      );
    }
  });
  
  try {
    transaction(writes);
  } catch (error) {
    // Don't spam logs for database locked errors
    if (!error.message.includes('database is locked') && !error.message.includes('SQLITE_BUSY')) {
      console.error(`[Cache] Database write error: ${error.message}`);
    }
  }
}

async function resolvePreview(imdbId, type, episodeInfo = null) {
  const episodeContext = episodeInfo ? ` (S${episodeInfo.season}E${episodeInfo.episode})` : '';
  logger.section(`RESOLVING: ${imdbId} (${type})${episodeContext}`);
  
  // For first episode of series, prioritize show trailer over episode previews
  const isFirstEpisode = episodeInfo?.isFirstEpisode === true;
  
  // Check cache with validation (use show ID for caching, not episode ID)
  const cached = await getCachedWithValidation(imdbId);
  
  if (cached) {
    if (cached.preview_url) {
      const sourceType = cached.source_type || 'unknown';
      console.log(`Cache hit: returning cached ${sourceType} preview (validated)`);
      return {
        found: true,
        source: cached.source || (sourceType === 'itunes' ? 'itunes' : sourceType === 'archive' ? 'archive' : 'youtube'),
        previewUrl: cached.preview_url,
        trackId: cached.track_id,
        country: cached.country
      };
    }
    // If cache exists but has no preview_url, don't use negative cache - always search again
    if (!cached.preview_url) {
      console.log('Cache hit: no preview_url found previously, but searching again anyway...');
    } else {
      console.log('Cache expired, refreshing...');
    }
  }
  
  const tmdbMeta = await getTMDBMetadata(imdbId, type);
  if (!tmdbMeta) {
    // Don't cache negative results - always search again
    return { found: false };
  }
  
  // Build list of available sources based on what we have
  // For series: Prioritize show trailers (YouTube) over episode previews (iTunes)
  // This allows testing with show trailers in the first episode
  const availableSources = [];
  
  // Add video sources (YouTube via yt-dlp with Cloudflare Warp proxy) - HIGHEST PRIORITY
  // For series, this gives us the show's trailer instead of episode previews
  if (tmdbMeta.youtubeTrailerKey) {
    // YouTube: yt-dlp only (Piped/Invidious removed - unreliable)
    availableSources.push('ytdlp');
  }
  
  // iTunes episode previews - FALLBACK (only if no trailer found)
  // Skip iTunes for movies - iTunes doesn't have movie previews, only TV episode previews
  // For series: Include iTunes as fallback (even for first episode, if YouTube trailer fails)
  if (type === 'series') {
    availableSources.push('itunes'); // iTunes works for TV shows (episode previews) - fallback if no trailer
  }
  
  
  // HIGH-VALUE DIRECT TRAILER SOURCES (work independently, don't need TMDB URLs)
  // Priority order: YTDLP (from TMDB) > Apple Trailers > Internet Archive
  // 
  // DISABLED SOURCES (not working or not appropriate):
  // - IMDB_TRAILER: yt-dlp does not support /title/ttXXXXXX URLs (always fails with "Unsupported URL")
  // - IVA: redirects to fabricdata.com which yt-dlp doesn't support
  // - RottenTomatoes, Metacritic, Allocine, Moviepilot: don't host videos, just embed YouTube (which we already handle)
  
  // Apple Trailers - high quality, good for cinema releases (yt-dlp supports appletrailers)
  if (tmdbMeta.title && type === 'movie') {
    availableSources.push('appletrailers');
  }
  
  // Internet Archive - fallback for older/obscure content (after YTDLP and Apple)
  availableSources.push('archive');
  
  // Sort sources by success rate, quality, and content type (highest first)
  const contentType = type === 'series' ? 'series' : 'movie';
  const sortedSources = successTracker.getSortedSources(availableSources, contentType);
  const sourceRates = sortedSources.map(s => {
    const rate = successTracker.getSourceSuccessRate(s);
    const quality = qualityTracker.getAvgQuality(s);
    return `${s.toUpperCase()} (${(rate * 100).toFixed(0)}%, q:${quality.toFixed(1)})`;
  }).join(', ');
  logger.info(`Trying sources (sorted by success rate + quality + content type): ${sourceRates}`);
  
  // PARALLEL SOURCE ATTEMPTS: Try top 3 sources simultaneously
  const PARALLEL_SOURCES = 3;
  const topSources = sortedSources.slice(0, PARALLEL_SOURCES);
  const fallbackSources = sortedSources.slice(PARALLEL_SOURCES);
  
  // Helper function to attempt a source with timeout and response time tracking
  // FIXED: Added abortSignal parameter for cancellation support
  const attemptSource = async (source, abortSignal = null) => {
    const startTime = Date.now();
    logger.source(source, `Attempting extraction...`);
    
    // Check if already cancelled
    if (abortSignal && abortSignal.aborted) {
      return null;
    }
    
    // Get dynamic timeout for this source (optimized for speed)
    // Faster sources get shorter timeouts, slower sources get longer but capped
    let defaultTimeout = 6000; // 6 seconds default
    if (source === 'archive') defaultTimeout = 8000; // Archive: 8s (needs time for metadata fetch)
    if (source === 'ytdlp') defaultTimeout = 18000; // yt-dlp: 18s (proxy adds latency, extraction takes 10-15s)
    if (source === 'itunes') defaultTimeout = 5000; // iTunes: usually fast, 5s max
    if (source === 'appletrailers' || source === 'vimeo' || source === 'dailymotion') defaultTimeout = 10000; // Other yt-dlp sources: 10s
    // IVA, RottenTomatoes, Metacritic, Allocine, Moviepilot - DISABLED (broken/not supported)
    
    const sourceTimeout = sourceResponseTimes.getTimeout(source, defaultTimeout);
    
    try {
      // Wrap each source attempt in a timeout to prevent hanging
      const sourceAttempt = async () => {
        if (source === 'itunes') {
          const itunesResult = await multiPassSearch(tmdbMeta);
          console.log(`iTunes search result: ${itunesResult.found ? 'FOUND' : 'NOT FOUND'}`);
          
          if (itunesResult.found) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('itunes', duration);
            qualityTracker.recordQuality('itunes', '480p'); // iTunes typically 480p
            
            setCache(imdbId, {
              track_id: itunesResult.trackId,
              preview_url: itunesResult.previewUrl,
              country: itunesResult.country || 'us',
              youtube_key: tmdbMeta.youtubeTrailerKey || null,
              source: 'itunes'
            });
            console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
            successTracker.recordSourceSuccess('itunes');
            return { ...itunesResult, source: 'itunes', quality: '480p' };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('itunes', duration);
            successTracker.recordSourceFailure('itunes');
            return null;
          }
        } else if (source === 'ytdlp') {
          if (!tmdbMeta.youtubeTrailerKey) {
            console.log(`  Skipping yt-dlp: no YouTube key available`);
            successTracker.recordSourceFailure('ytdlp');
            return null;
          }
          console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
          const ytdlpResult = await extractViaYtDlp(tmdbMeta.youtubeTrailerKey);
          if (ytdlpResult && ytdlpResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = ytdlpResult.quality || 'best';
            qualityTracker.recordQuality('ytdlp', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: ytdlpResult.url,
              country: 'yt',
              youtube_key: tmdbMeta.youtubeTrailerKey,
              source: 'youtube'
            });
            console.log(`✓ Got URL from yt-dlp`);
            successTracker.recordSourceSuccess('ytdlp');
            return {
              found: true,
              source: 'youtube',
              previewUrl: ytdlpResult.url,
              youtubeKey: tmdbMeta.youtubeTrailerKey,
              country: 'yt',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('ytdlp');
            return null;
          }
        } else if (source === 'vimeo') {
          // Vimeo - resolve URL and extract
          const vimeoUrl = await resolveVimeoUrl(tmdbMeta, imdbId);
          if (!vimeoUrl) {
            console.log(`  Skipping Vimeo: no URL available`);
            successTracker.recordSourceFailure('vimeo');
            return null;
          }
          console.log(`  [Vimeo] Resolved URL: ${vimeoUrl}`);
          const vimeoResult = await extractViaYtDlpGeneric(vimeoUrl, 'Vimeo');
          if (vimeoResult && vimeoResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = vimeoResult.quality || 'best';
            qualityTracker.recordQuality('vimeo', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: vimeoResult.url,
              country: 'vimeo',
              youtube_key: null,
              source: 'vimeo'
            });
            console.log(`✓ Got URL from Vimeo`);
            successTracker.recordSourceSuccess('vimeo');
            return {
              found: true,
              source: 'vimeo',
              previewUrl: vimeoResult.url,
              youtubeKey: null,
              country: 'vimeo',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('vimeo');
            return null;
          }
        } else if (source === 'dailymotion') {
          // Dailymotion - resolve URL and extract
          const dailymotionUrl = await resolveDailymotionUrl(tmdbMeta, imdbId);
          if (!dailymotionUrl) {
            console.log(`  Skipping Dailymotion: no URL available`);
            successTracker.recordSourceFailure('dailymotion');
            return null;
          }
          console.log(`  [Dailymotion] Resolved URL: ${dailymotionUrl}`);
          const dailymotionResult = await extractViaYtDlpGeneric(dailymotionUrl, 'Dailymotion');
          if (dailymotionResult && dailymotionResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = dailymotionResult.quality || 'best';
            qualityTracker.recordQuality('dailymotion', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: dailymotionResult.url,
              country: 'dailymotion',
              youtube_key: null,
              source: 'dailymotion'
            });
            console.log(`✓ Got URL from Dailymotion`);
            successTracker.recordSourceSuccess('dailymotion');
            return {
              found: true,
              source: 'dailymotion',
              previewUrl: dailymotionResult.url,
              youtubeKey: null,
              country: 'dailymotion',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('dailymotion');
            return null;
          }
        } else if (source === 'ytdlp_other') {
          // Handle other video sites (Facebook, Twitter, Instagram, etc.) via generic yt-dlp extractor
          if (!tmdbMeta.trailerUrl || !tmdbMeta.trailerSite) {
            console.log(`  Skipping yt-dlp (other): no trailer URL available`);
            successTracker.recordSourceFailure('ytdlp');
            return null;
          }
          console.log(`${tmdbMeta.trailerSite} URL: ${tmdbMeta.trailerUrl}`);
          const ytdlpResult = await extractViaYtDlpGeneric(tmdbMeta.trailerUrl, tmdbMeta.trailerSite);
          if (ytdlpResult && ytdlpResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = ytdlpResult.quality || 'best';
            qualityTracker.recordQuality('ytdlp', quality);
            
            // Determine source type for cache
            const sourceType = tmdbMeta.trailerSite.toLowerCase();
            setCache(imdbId, {
              track_id: null,
              preview_url: ytdlpResult.url,
              country: sourceType,
              youtube_key: null,
              source: sourceType
            });
            console.log(`✓ Got URL from yt-dlp (${tmdbMeta.trailerSite})`);
            successTracker.recordSourceSuccess('ytdlp');
            return {
              found: true,
              source: sourceType,
              previewUrl: ytdlpResult.url,
              youtubeKey: null,
              country: sourceType,
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('ytdlp');
            return null;
          }
        } else if (source === 'imdb_trailer') {
          // IMDb trailers - DISABLED: yt-dlp does not support /title/ttXXXXXX URLs
          // This always fails with "Unsupported URL", wasting 10-13 seconds per request
          // IMDb should be used for metadata only, not as a video source
          console.log(`  [IMDb] Skipping - yt-dlp does not support IMDb title pages`);
          successTracker.recordSourceFailure('imdb');
          return null;
        } else if (false && source === 'imdb_trailer_OLD') {
          // OLD CODE - KEPT FOR REFERENCE ONLY (DISABLED)
          // IMDb trailers - resolve URL and extract
          const imdbUrl = await resolveImdbTrailerUrl(tmdbMeta, imdbId);
          if (!imdbUrl) {
            console.log(`  Skipping IMDb: could not resolve URL`);
            successTracker.recordSourceFailure('imdb');
            return null;
          }
          console.log(`  [IMDb] Resolved URL: ${imdbUrl}`);
          const imdbResult = await extractViaYtDlpGeneric(imdbUrl, 'IMDb');
          if (imdbResult && imdbResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = imdbResult.quality || 'best';
            qualityTracker.recordQuality('imdb', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: imdbResult.url,
              country: 'imdb',
              youtube_key: null,
              source: 'imdb'
            });
            console.log(`✓ Got URL from IMDb trailers`);
            successTracker.recordSourceSuccess('imdb');
            return {
              found: true,
              source: 'imdb',
              previewUrl: imdbResult.url,
              youtubeKey: null,
              country: 'imdb',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('imdb');
            return null;
          }
        } else if (source === 'appletrailers') {
          // Apple Trailers - search and find actual trailer page
          const appleUrl = await resolveAppleTrailersUrl(tmdbMeta, imdbId);
          console.log(`  [AppleTrailers] Resolved URL: ${appleUrl}`);
          const appleResult = await extractViaYtDlpGeneric(appleUrl, 'AppleTrailers');
          if (appleResult && appleResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = appleResult.quality || 'best';
            qualityTracker.recordQuality('appletrailers', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: appleResult.url,
              country: 'apple',
              youtube_key: null,
              source: 'apple'
            });
            console.log(`✓ Got URL from Apple Trailers`);
            successTracker.recordSourceSuccess('appletrailers');
            return {
              found: true,
              source: 'apple',
              previewUrl: appleResult.url,
              youtubeKey: null,
              country: 'apple',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('appletrailers');
            return null;
          }
        } else if (source === 'iva_trailer') {
          // Internet Video Archive (IVA) - DISABLED
          // IVA redirects to fabricdata.com which yt-dlp doesn't support (401 errors)
          console.log(`  Skipping IVA: disabled (redirects to unsupported site)`);
          successTracker.recordSourceFailure('iva');
          return null;
        } else if (source === 'rottentomatoes') {
          // RottenTomatoes - DISABLED (not supported by yt-dlp)
          const rtUrl = await resolveRottenTomatoesSlug(tmdbMeta, imdbId);
          if (!rtUrl) {
            console.log(`  Skipping RottenTomatoes: not supported`);
            successTracker.recordSourceFailure('rottentomatoes');
            return null;
          }
          if (rtResult && rtResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = rtResult.quality || 'best';
            qualityTracker.recordQuality('rottentomatoes', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: rtResult.url,
              country: 'rt',
              youtube_key: null,
              source: 'rottentomatoes'
            });
            console.log(`✓ Got URL from RottenTomatoes`);
            successTracker.recordSourceSuccess('rottentomatoes');
            return {
              found: true,
              source: 'rottentomatoes',
              previewUrl: rtResult.url,
              youtubeKey: null,
              country: 'rt',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('rottentomatoes');
            return null;
          }
        } else if (source === 'metacritic') {
          // Metacritic - DISABLED (not supported by yt-dlp)
          const mcUrl = await resolveMetacriticSlug(tmdbMeta, imdbId);
          if (!mcUrl) {
            console.log(`  Skipping Metacritic: not supported`);
            successTracker.recordSourceFailure('metacritic');
            return null;
          }
          if (mcResult && mcResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = mcResult.quality || 'best';
            qualityTracker.recordQuality('metacritic', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: mcResult.url,
              country: 'mc',
              youtube_key: null,
              source: 'metacritic'
            });
            console.log(`✓ Got URL from Metacritic`);
            successTracker.recordSourceSuccess('metacritic');
            return {
              found: true,
              source: 'metacritic',
              previewUrl: mcResult.url,
              youtubeKey: null,
              country: 'mc',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('metacritic');
            return null;
          }
        } else if (source === 'moviepilot') {
          // Moviepilot - DISABLED (not supported by yt-dlp)
          const mpUrl = await resolveMoviepilotUrl(tmdbMeta, imdbId);
          if (!mpUrl) {
            console.log(`  Skipping Moviepilot: not supported`);
            successTracker.recordSourceFailure('moviepilot');
            return null;
          }
          if (mpResult && mpResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = mpResult.quality || 'best';
            qualityTracker.recordQuality('moviepilot', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: mpResult.url,
              country: 'mp',
              youtube_key: null,
              source: 'moviepilot'
            });
            console.log(`✓ Got URL from Moviepilot`);
            successTracker.recordSourceSuccess('moviepilot');
            return {
              found: true,
              source: 'moviepilot',
              previewUrl: mpResult.url,
              youtubeKey: null,
              country: 'mp',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('moviepilot');
            return null;
          }
        } else if (source === 'allocine') {
          // Allocine - DISABLED (not reliable)
          const allocineUrl = await resolveAllocineUrl(tmdbMeta, imdbId);
          if (!allocineUrl) {
            console.log(`  Skipping Allocine: not supported`);
            successTracker.recordSourceFailure('allocine');
            return null;
          }
          if (allocineResult && allocineResult.url) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            
            const quality = allocineResult.quality || 'best';
            qualityTracker.recordQuality('allocine', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: allocineResult.url,
              country: 'allocine',
              youtube_key: null,
              source: 'allocine'
            });
            console.log(`✓ Got URL from Allocine`);
            successTracker.recordSourceSuccess('allocine');
            return {
              found: true,
              source: 'allocine',
              previewUrl: allocineResult.url,
              youtubeKey: null,
              country: 'allocine',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('ytdlp', duration);
            successTracker.recordSourceFailure('allocine');
            return null;
          }
        } else if (source === 'archive') {
          const archiveResult = await extractViaInternetArchive(tmdbMeta, imdbId);
          if (archiveResult) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('archive', duration);
            
            const archiveUrl = typeof archiveResult === 'string' ? archiveResult : archiveResult.url;
            const quality = typeof archiveResult === 'object' ? (archiveResult.quality || 'unknown') : 'unknown';
            qualityTracker.recordQuality('archive', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: archiveUrl,
              country: 'archive',
              youtube_key: tmdbMeta.youtubeTrailerKey || null,
              source: 'archive'
            });
            console.log(`✓ Got URL from Internet Archive`);
            successTracker.recordSourceSuccess('archive');
            return {
              found: true,
              source: 'archive',
              previewUrl: archiveUrl,
              country: 'archive',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('archive', duration);
            successTracker.recordSourceFailure('archive');
            return null;
          }
        }
        return null;
      };
      
      // Race the source attempt against a dynamic timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Source ${source} timeout after ${sourceTimeout}ms`)), sourceTimeout)
      );
      
      const result = await Promise.race([sourceAttempt(), timeoutPromise]);
      
      if (result && result.found) {
        return result;
      }
      return null;
    } catch (error) {
      const duration = Date.now() - startTime;
      sourceResponseTimes.recordTime(source, duration);
      
      if (error.message && error.message.includes('timeout')) {
        console.log(`  ⚠️ ${source.toUpperCase()} timed out after ${sourceTimeout}ms`);
      } else {
        console.log(`  ✗ Error in ${source.toUpperCase()}: ${error.message || 'unknown error'}`);
      }
      successTracker.recordSourceFailure(source);
      return null;
    }
  };
  
  // FIXED: Quality-aware parallel source attempts with cancellation support
  // Strategy: Wait up to 2-3 seconds for all sources, then pick best by quality + priority
  // If a high-priority source (YTDLP) succeeds quickly, return immediately
  // Otherwise, wait briefly to compare quality before returning
  if (topSources.length > 0) {
    logger.info(`Trying ${topSources.length} sources in parallel: ${topSources.join(', ')}`);
    
    // Create AbortController for each source attempt (for cancellation)
    const abortControllers = new Map();
    const sourcePromises = topSources.map((source) => {
      const controller = new AbortController();
      abortControllers.set(source, controller);
      
      return attemptSource(source, controller.signal).then(result => {
        return result && result.found ? { source, result } : null;
      }).catch(error => {
        if (error.name === 'AbortError') {
          return null; // Cancelled - not a real error
        }
        return null;
      });
    });
    
    // FIXED: Quality-aware selection - wait briefly (2s) for all sources, then pick best
    // This allows YTDLP (higher quality) to beat Archive (faster but lower quality)
    const QUALITY_WAIT_TIME = 2000; // Wait 2 seconds to compare quality
    
    const raceResult = await Promise.race([
      // Race all source promises
      ...sourcePromises.map(p => p.then(result => ({ type: 'success', result, timestamp: Date.now() }))),
      // Also race a timeout
      new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), QUALITY_WAIT_TIME))
    ]);
    
    // If we got a successful result quickly (within 2s), check if it's high priority
    if (raceResult.type === 'success' && raceResult.result) {
      const winner = raceResult.result;
      const winnerSource = winner.source;
      
      // High-priority sources (YTDLP, Apple) - return immediately
      if (winnerSource === 'ytdlp' || winnerSource === 'appletrailers') {
        // Cancel other sources
        for (const [source, controller] of abortControllers.entries()) {
          if (source !== winnerSource) {
            controller.abort();
          }
        }
        logger.success(`Found via parallel attempt: ${winnerSource} (high priority, returning immediately)`);
        return winner.result;
      }
      
      // Lower priority source (Archive) - wait briefly to see if better source succeeds
      logger.info(`Found ${winnerSource}, waiting ${QUALITY_WAIT_TIME}ms for higher priority sources...`);
      
      // Wait for remaining sources (with timeout)
      const remainingWait = Math.max(0, QUALITY_WAIT_TIME - (Date.now() - raceResult.timestamp));
      if (remainingWait > 0) {
        await new Promise(resolve => setTimeout(resolve, remainingWait));
      }
      
      // Check all results and pick best by quality + priority
      const allResults = await Promise.allSettled(sourcePromises);
      const successfulResults = [];
      
      for (const settled of allResults) {
        if (settled.status === 'fulfilled' && settled.value && settled.value.result) {
          successfulResults.push(settled.value);
        }
      }
      
      // Cancel any remaining sources
      for (const [source, controller] of abortControllers.entries()) {
        controller.abort();
      }
      
      if (successfulResults.length > 0) {
        // Sort by priority + quality (YTDLP > Apple > Archive)
        successfulResults.sort((a, b) => {
          const priorityOrder = { 'ytdlp': 3, 'appletrailers': 2, 'archive': 1, 'itunes': 2 };
          const priorityA = priorityOrder[a.source] || 0;
          const priorityB = priorityOrder[b.source] || 0;
          if (priorityA !== priorityB) return priorityB - priorityA;
          
          // If same priority, prefer higher quality
          const qualityA = qualityTracker.getAvgQuality(a.source);
          const qualityB = qualityTracker.getAvgQuality(b.source);
          return qualityB - qualityA;
        });
        
        const best = successfulResults[0];
        logger.success(`Found via parallel attempt: ${best.source} (best of ${successfulResults.length} results)`);
        return best.result;
      }
      
      // Fallback to original winner
      logger.success(`Found via parallel attempt: ${winnerSource}`);
      return winner.result;
    }
    
    // If timeout, wait for remaining sources to complete (but don't wait too long)
    logger.info(`No quick success, waiting for remaining sources...`);
    const allResults = await Promise.allSettled(sourcePromises);
    
    // Cancel any still-running sources
    for (const [source, controller] of abortControllers.entries()) {
      controller.abort();
    }
    
    // Find best result by priority + quality
    const successfulResults = [];
    for (const settled of allResults) {
      if (settled.status === 'fulfilled' && settled.value && settled.value.result) {
        successfulResults.push(settled.value);
      }
    }
    
    if (successfulResults.length > 0) {
      // Sort by priority + quality
      successfulResults.sort((a, b) => {
        const priorityOrder = { 'ytdlp': 3, 'appletrailers': 2, 'archive': 1, 'itunes': 2 };
        const priorityA = priorityOrder[a.source] || 0;
        const priorityB = priorityOrder[b.source] || 0;
        if (priorityA !== priorityB) return priorityB - priorityA;
        const qualityA = qualityTracker.getAvgQuality(a.source);
        const qualityB = qualityTracker.getAvgQuality(b.source);
        return qualityB - qualityA;
      });
      
      const best = successfulResults[0];
      logger.success(`Found via parallel attempt: ${best.source}`);
      return best.result;
    }
    
    logger.info(`Parallel attempts failed, trying ${fallbackSources.length} fallback sources sequentially`);
  }
  
  // Fallback: Try remaining sources sequentially
  for (const source of fallbackSources) {
    const result = await attemptSource(source);
    if (result && result.found) {
      return result;
    }
  }
  
  // Don't cache negative results - always search again on next request
  console.log('No preview found from iTunes, YouTube, or Internet Archive');
  return { found: false };
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'trailerio-backend', version: '2.0.0' });
});

// Archive.org cookie management endpoint
// Usage: POST /admin/archive-cookie with body: { "cookies": "your-cookie-string", "email": "optional@email.com" }
// To get cookies: 1. Log into archive.org in browser, 2. Open DevTools > Application > Cookies, 3. Copy all cookies as "name=value; name2=value2" format
app.post('/admin/archive-cookie', express.json(), (req, res) => {
  const { cookies, email } = req.body;
  
  if (!cookies || typeof cookies !== 'string') {
    return res.status(400).json({ error: 'cookies field is required (string)' });
  }
  
  const success = archiveCookieManager.addCookie(cookies, email || null);
  if (success) {
    res.json({ success: true, message: 'Cookie added successfully' });
  } else {
    res.status(500).json({ error: 'Failed to add cookie' });
  }
});

// List Archive.org cookies (for debugging)
app.get('/admin/archive-cookies', (req, res) => {
  const stmt = db.prepare(`
    SELECT id, email, created_at, last_used, is_valid, use_count 
    FROM archive_cookies 
    ORDER BY last_used DESC
  `);
  const cookies = stmt.all();
  res.json({ cookies });
});

app.get('/manifest.json', (req, res) => {
  res.json({
    id: "com.trailer.preview",
    name: "Trailer Preview",
    version: "2.0.0",
    description: "Watch trailers and previews for movies and TV shows",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Film_reel.svg/200px-Film_reel.svg.png",
    resources: [
      { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }
    ],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
  });
});

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const requestStart = Date.now();
  
  // Parse Stremio episode format: tt10986410:1:1 (show:season:episode)
  let showImdbId = id;
  let season = null;
  let episode = null;
  let isFirstEpisode = false;
  
  if (id.includes(':')) {
    const parts = id.split(':');
    if (parts.length >= 3) {
      showImdbId = parts[0]; // Extract show IMDb ID
      season = parseInt(parts[1]);
      episode = parseInt(parts[2]);
      isFirstEpisode = (season === 1 && episode === 1);
      logger.info(`Parsed episode request: Show ${showImdbId}, Season ${season}, Episode ${episode}${isFirstEpisode ? ' (FIRST EPISODE - will return show trailer)' : ''}`);
    }
  }
  
  if (!showImdbId.startsWith('tt')) {
    logger.warn(`Skipping non-IMDB ID: ${showImdbId}`);
    return res.json({ streams: [] });
  }
  
  logger.section(`REQUEST: ${type.toUpperCase()} ${id}${season !== null ? ` (S${season}E${episode})` : ''}`);
  logger.info(`Active requests: ${activeRequests}`);
  
  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    console.log(`  ⚠️ Request timeout for ${id} after ${STREAM_TIMEOUT / 1000}s`);
    if (!res.headersSent) {
      try {
        res.json({ streams: [] });
        res.end(); // Force end the response
      } catch (err) {
        console.error(`  [DEBUG] Error in timeout handler for ${id}:`, err.message);
        if (!res.finished) {
          res.end(); // Force end even if json failed
        }
      }
    } else if (!res.finished) {
      res.end(); // Force end if headers sent but not finished
    }
  }, STREAM_TIMEOUT);
  
  try {
    // Wrap resolvePreview in a promise race to ensure it doesn't exceed timeout
    // Use shorter timeout to ensure response is sent before Traefik times out
    // For series episodes, use the show IMDb ID (not the episode ID)
    const resolvePromise = resolvePreview(showImdbId, type, { season, episode, isFirstEpisode });
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), STREAM_TIMEOUT - 1000) // 1s buffer
    );
    
    let result;
    try {
      result = await Promise.race([resolvePromise, timeoutPromise]);
    } catch (err) {
      if (err.message === 'Request timeout') {
        console.log(`  ⚠️ Request timeout for ${id} - aborting`);
        clearTimeout(timeout);
        if (!res.headersSent) {
          res.json({ streams: [] });
        }
        return;
      }
      // Re-throw other errors
      throw err;
    }
    
    if (!result) {
      // This shouldn't happen, but handle it just in case
      console.log(`  ⚠️ No result returned for ${id}`);
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.json({ streams: [] });
      }
      return;
    }
    
    clearTimeout(timeout);
    
    if (timeoutFired) {
      console.log(`  ⚠️ Timeout already fired, skipping response for ${id}`);
      return;
    }
  
    if (result.found && result.previewUrl) {
      const isYouTube = result.source === 'youtube';
      // For series, if we got a YouTube trailer, call it "Show Trailer" instead of "Episode Preview"
      const streamName = isYouTube 
        ? (type === 'series' ? 'Show Trailer' : 'Official Trailer')
        : (type === 'movie' ? 'Movie Preview' : 'Episode Preview');
      const streamTitle = isYouTube 
        ? (type === 'series' ? 'Show Trailer' : 'Official Trailer')
        : `Trailer / Preview (${result.country?.toUpperCase() || 'US'})`;
      
      let finalUrl = result.previewUrl;
      
      // DASH manifests work directly in AVPlayer
      const isDashManifest = finalUrl.includes('.mpd') || finalUrl.endsWith('/dash');
      const isPipedProxy = finalUrl.includes('pipedproxy') || finalUrl.includes('pipedapi');
      const isInvidiousProxy = finalUrl.includes('invidious') || finalUrl.includes('iv.') || finalUrl.includes('yewtu.be');
      
      if (isDashManifest) {
        console.log(`Using DASH manifest directly (AVPlayer native support): ${finalUrl.substring(0, 80)}...`);
      } else if (isPipedProxy || isInvidiousProxy) {
        console.log(`Using Piped/Invidious URL directly (already proxied, AVPlayer compatible): ${finalUrl.substring(0, 80)}...`);
      }
      
      logger.success(`Found trailer for ${id}: ${finalUrl.substring(0, 80)}...`);
      console.log(`  [DEBUG] Before res.json() - headersSent: ${res.headersSent}, finished: ${res.finished}`);
      
      if (!res.headersSent) {
        try {
          const responseData = {
            streams: [{
              name: streamName,
              title: streamTitle,
              url: finalUrl
            }]
          };
          console.log(`  [DEBUG] Calling res.json() with data:`, JSON.stringify(responseData).substring(0, 100));
          
          res.json(responseData);
          
          console.log(`  [DEBUG] After res.json() - headersSent: ${res.headersSent}, finished: ${res.finished}`);
          
          // Track response completion
          res.on('finish', () => {
            const duration = Date.now() - requestStart;
            console.log(`  [DEBUG] Response finished for ${id} (took ${duration}ms total)`);
          });
          
          res.on('close', () => {
            const duration = Date.now() - requestStart;
            console.log(`  [DEBUG] Response closed for ${id} (took ${duration}ms total)`);
          });
          
          res.on('error', (err) => {
            console.error(`  [DEBUG] Response error for ${id}:`, err.message);
          });
          
          // Ensure response is properly ended
          if (!res.finished && !res.closed) {
            console.log(`  [DEBUG] Response not finished/closed, ensuring end for ${id}`);
          }
          
          return;
        } catch (jsonError) {
          console.error(`  [DEBUG] Error in res.json() for ${id}:`, jsonError.message);
          throw jsonError;
        }
      } else {
        console.log(`  [DEBUG] Headers already sent for ${id}, skipping response`);
      }
    }
    
    logger.warn(`No preview found for ${id}`);
    console.log(`  [DEBUG] Before sending empty response - headersSent: ${res.headersSent}`);
    if (!res.headersSent) {
      try {
        res.json({ streams: [] });
        const duration = Date.now() - requestStart;
        console.log(`  [DEBUG] Empty response sent for ${id} (took ${duration}ms total)`);
        return;
      } catch (jsonError) {
        console.error(`  [DEBUG] Error sending empty response for ${id}:`, jsonError.message);
      }
    } else {
      console.log(`  [DEBUG] Headers already sent, cannot send empty response for ${id}`);
    }
  } catch (error) {
    clearTimeout(timeout);
    const isTimeout = error.message === 'Request timeout';
    const duration = Date.now() - requestStart;
    console.error(`  ✗ Error resolving ${id}:`, isTimeout ? 'Request timeout' : (error.message || error));
    console.error(`  [DEBUG] Error stack:`, error.stack);
    console.log(`  [DEBUG] Before error response - headersSent: ${res.headersSent}, timeoutFired: ${timeoutFired} (took ${duration}ms)`);
    if (!res.headersSent && !timeoutFired) {
      try {
        res.json({ streams: [] });
        console.log(`  [DEBUG] Error response sent for ${id}`);
      } catch (jsonError) {
        console.error(`  [DEBUG] Error sending error response for ${id}:`, jsonError.message);
      }
    }
  }
});

// Cache management endpoints
app.delete('/cache/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  
  if (!imdbId || !imdbId.match(/^tt\d+$/)) {
    return res.status(400).json({ error: 'Invalid IMDb ID format' });
  }
  
  // Remove from in-memory cache
  const wasCached = cache.has(imdbId);
  cache.delete(imdbId);
  
  // Remove from database
  const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
  deleteStmt.run(imdbId);
  
  if (wasCached) {
    logger.cache('delete', `Removed cache entry for ${imdbId}`);
    res.json({ success: true, message: `Cache entry for ${imdbId} removed` });
  } else {
    res.json({ success: true, message: `No cache entry found for ${imdbId}` });
  }
});

// Clear all cache entries
app.delete('/cache', (req, res) => {
  const cacheSize = cache.size;
  
  // Clear in-memory cache
  cache.clear();
  
  // Clear database cache
  const deleteAllStmt = db.prepare('DELETE FROM cache');
  deleteAllStmt.run();
  
  logger.cache('delete', `Cleared all ${cacheSize} cache entries`);
  res.json({ success: true, message: `Cleared ${cacheSize} cache entries` });
});

app.get('/stats', (req, res) => {
  const entries = Array.from(cache.values());
  const totalEntries = entries.length;
  const hits = entries.filter(e => e.preview_url !== null || e.youtube_key !== null);
  const misses = entries.filter(e => !e.preview_url && !e.youtube_key);
  const hitRate = totalEntries > 0 ? ((hits.length / totalEntries) * 100).toFixed(1) : '0.0';
  
  const countryStats = {};
  for (const hit of hits) {
    const country = hit.country || 'us';
    countryStats[country] = (countryStats[country] || 0) + 1;
  }
  
  const recentMisses = misses.slice(0, 20).map(m => ({
    imdbId: 'cached',
    lastChecked: new Date(m.timestamp).toISOString()
  }));
  
  const recentHits = hits.slice(0, 10).map(h => ({
    imdbId: 'cached',
    country: h.country,
    lastChecked: new Date(h.timestamp).toISOString()
  }));
  
  res.json({
    cache: {
      totalEntries,
      hits: hits.length,
      misses: misses.length,
      hitRate: `${hitRate}%`
    },
    byCountry: countryStats,
    recentHits,
    recentMisses,
    generatedAt: new Date().toISOString()
  });
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('⚠️  Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - keep server running
});

// Start server with error handling
try {
  console.log('Starting server...');
  console.log(`Port: ${PORT}`);
  console.log(`TMDB_API_KEY: ${TMDB_API_KEY ? 'Set' : 'NOT SET'}`);
  console.log(`Database path: ${dbPath}`);
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.section('SERVER STARTED');
    logger.success(`Server running on port ${PORT}`);
    logger.info(`Listening on 0.0.0.0:${PORT}`);
    logger.info(`Database: ${dbPath}`);
    if (!TMDB_API_KEY) {
      logger.warn('TMDB_API_KEY not set. Please set it as an environment variable.');
    }
  });
  
  app.on('error', (error) => {
    console.error('⚠️  Server error:', error.message);
    console.error('Stack:', error.stack);
  });
} catch (error) {
  console.error('⚠️  Failed to start server:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
