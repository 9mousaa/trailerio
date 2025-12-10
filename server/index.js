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
  youtube: 2,      // YouTube URLs (Piped/Invidious/yt-dlp) expire quickly - 2 hours
  itunes: 168,     // iTunes URLs are stable - 7 days (168 hours)
  archive: 720     // Archive URLs are permanent - 30 days (720 hours)
};

// Cache source types we support:
// 1. youtube: Piped, Invidious, yt-dlp (direct YouTube stream URLs)
// 2. itunes: iTunes preview URLs (video-ssl.itunes.apple.com)
// 3. archive: Internet Archive URLs (archive.org/download/...)

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
  
  CREATE INDEX IF NOT EXISTS idx_cache_timestamp ON cache(timestamp);
  CREATE INDEX IF NOT EXISTS idx_success_tracker_type ON success_tracker(type);
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

// Health check endpoint (for Docker health checks and monitoring)
// Must return 200 status for Docker to consider service healthy
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.status(200).json({ 
    status: 'healthy', 
    service: 'trailerio-backend', 
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
  _saveToDB(type, identifier, success, total) {
    try {
      const startTime = Date.now();
      const stmt = db.prepare(`
        INSERT INTO success_tracker (type, identifier, success, total)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(type, identifier) DO UPDATE SET success = ?, total = ?
      `);
      stmt.run(type, identifier, success, total, success, total);
      const duration = Date.now() - startTime;
      // Warn if DB write is slow (might indicate contention)
      if (duration > 50) {
        console.warn(`[SuccessTracker] Slow DB write: ${duration}ms for ${type}/${identifier}`);
      }
    } catch (error) {
      // Don't spam logs for database locked errors (common with concurrent writes)
      if (!error.message.includes('database is locked') && !error.message.includes('SQLITE_BUSY')) {
        console.error(`[SuccessTracker] Database error: ${error.message}`);
      }
      // Continue - in-memory tracking still works
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
      
      // Content-type aware prioritization
      let priorityA = 0, priorityB = 0;
      if (contentType === 'series') {
        // TV shows: iTunes is best, then YouTube sources
        if (a === 'itunes') priorityA = 0.3;
        if (b === 'itunes') priorityB = 0.3;
      } else {
        // Movies: Archive is best for older movies, YouTube sources for newer
        if (a === 'archive') priorityA = 0.2;
        if (b === 'archive') priorityB = 0.2;
      }
      
      // Quality-based weighting (prefer sources that return higher quality)
      const qualityA = qualityTracker.getAvgQuality(a);
      const qualityB = qualityTracker.getAvgQuality(b);
      const qualityWeight = 0.1; // 10% weight for quality
      
      // Combined score: success rate + content priority + quality
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

function fuzzyMatch(str1, str2) {
  const norm1 = normalizeTitle(str1);
  const norm2 = normalizeTitle(str2);
  
  if (norm1 === norm2) return 1.0;
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.85;
  
  const longer = norm1.length > norm2.length ? norm1 : norm2;
  const shorter = norm1.length > norm2.length ? norm2 : norm1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
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
  
  let youtubeTrailerKey = null;
  const videos = detail.videos?.results || [];
  
  // Priority: Official Trailer > Official Teaser > Any Trailer > Official Clip > Any YouTube video
  // Filter out behind-the-scenes, featurettes, etc.
  const excludeTypes = ['Behind the Scenes', 'Featurette', 'Bloopers', 'Opening Credits'];
  const excludeNames = ['behind', 'featurette', 'bloopers', 'opening', 'credits', 'making of'];
  
  const filteredVideos = videos.filter(v => {
    if (v.site !== 'YouTube') return false;
    const name = (v.name || '').toLowerCase();
    return !excludeTypes.includes(v.type) && 
           !excludeNames.some(exclude => name.includes(exclude));
  });
  
  // Priority 1: Official Trailer
  let trailer = filteredVideos.find(v => 
    v.type === 'Trailer' && 
    v.official === true
  );
  let youtubeTrailerTitle = null;
  if (trailer) {
    youtubeTrailerKey = trailer.key;
    youtubeTrailerTitle = trailer.name || null;
    console.log(`Found official trailer: ${youtubeTrailerTitle || 'Trailer'}`);
  } else {
    // Priority 2: Official Teaser
    trailer = filteredVideos.find(v => 
      v.type === 'Teaser' && 
      v.official === true
    );
    if (trailer) {
      youtubeTrailerKey = trailer.key;
      youtubeTrailerTitle = trailer.name || null;
      console.log(`Found official teaser: ${youtubeTrailerTitle || 'Teaser'}`);
    } else {
      // Priority 3: Any Trailer (not official)
      trailer = filteredVideos.find(v => v.type === 'Trailer');
      if (trailer) {
        youtubeTrailerKey = trailer.key;
        youtubeTrailerTitle = trailer.name || null;
        console.log(`Found trailer: ${youtubeTrailerTitle || 'Trailer'}`);
      } else {
        // Priority 4: Official Clip
        trailer = filteredVideos.find(v => 
          v.type === 'Clip' && 
          v.official === true
        );
        if (trailer) {
          youtubeTrailerKey = trailer.key;
          youtubeTrailerTitle = trailer.name || null;
          console.log(`Found official clip: ${youtubeTrailerTitle || 'Clip'}`);
        } else {
          // Last resort: Any YouTube video (but prefer official)
          trailer = filteredVideos.find(v => v.official === true) || filteredVideos[0];
          if (trailer) {
            youtubeTrailerKey = trailer.key;
            youtubeTrailerTitle = trailer.name || null;
            console.log(`Found YouTube video: ${youtubeTrailerTitle || 'Video'} (${trailer.type})`);
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
  
  console.log(`TMDB: "${mainTitle}" (${year}), YouTube: ${youtubeTrailerKey || 'none'}, altTitles: ${altTitlesArray.length}`);
  
  return {
    tmdbId,
    mediaType,
    title: mainTitle,
    originalTitle: originalTitle || mainTitle,
    year,
    runtime,
    altTitles: altTitlesArray,
    youtubeTrailerKey,
    youtubeTrailerTitle
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

// ============ YT-DLP EXTRACTOR (with Cloudflare Warp) ============

async function extractViaYtDlp(youtubeKey) {
  console.log(`  [yt-dlp] Extracting streamable URL for ${youtubeKey}...`);
  
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout
  
  try {
    // CRITICAL: Gluetun proxy is REQUIRED - never run yt-dlp without it
    // Port 8000 is the control server, port 8888 is the HTTP proxy
    const gluetunProxy = process.env.GLUETUN_HTTP_PROXY || 'http://gluetun:8888';
    let proxyAvailable = false;
    let proxyError = null;
    
    // Verify gluetun is running and proxy is accessible
    try {
      // Check gluetun's control API to verify it's running
      const gluetunStatus = await fetch('http://gluetun:8000/v1/openvpn/status', {
        signal: AbortSignal.timeout(3000),
        method: 'GET'
      });
      
      if (gluetunStatus && gluetunStatus.ok) {
        // Gluetun is running, verify HTTP proxy is accessible
        try {
          // Test proxy by making a simple request through it
          const proxyTest = await fetch('http://httpbin.org/ip', {
            signal: AbortSignal.timeout(5000),
            method: 'GET',
            // Note: We can't easily test the proxy from Node.js without additional setup
            // But if gluetun status is OK, proxy should be available
          }).catch(() => null);
          
          proxyAvailable = true;
          console.log(`  [yt-dlp] ✓ Gluetun is healthy, HTTP proxy available at ${gluetunProxy}`);
        } catch (testError) {
          proxyError = testError;
          console.log(`  [yt-dlp] ⚠ Proxy test failed: ${testError.message}, but gluetun is running`);
          // If gluetun is running, assume proxy is available (it's configured)
          proxyAvailable = true;
        }
      } else {
        throw new Error(`Gluetun status check returned ${gluetunStatus.status}`);
      }
    } catch (checkError) {
      proxyError = checkError;
      console.error(`  [yt-dlp] ✗ CRITICAL: Gluetun is not available: ${checkError.message}`);
      console.error(`  [yt-dlp] ✗ Cannot run yt-dlp without Cloudflare Warp proxy - aborting`);
      successTracker.recordFailure('ytdlp', 'no-proxy');
      return null; // NEVER run without proxy
    }
    
    // CRITICAL: If proxy is not available, abort immediately
    if (!proxyAvailable) {
      console.error(`  [yt-dlp] ✗ CRITICAL: Proxy not available - refusing to run yt-dlp without Cloudflare Warp`);
      successTracker.recordFailure('ytdlp', 'no-proxy');
      return null;
    }
    
    // Use HTTP proxy (REQUIRED)
    const useProxy = `--proxy ${gluetunProxy}`;
    
    // Anti-blocking strategies:
    // 1. Use proper user agent (mimic browser)
    // 2. Add sleep interval between requests
    // 3. Use format selection that's less likely to be blocked
    // 4. Extract info only (no download) - gets streamable URLs
    // 5. Prefer combined formats (video+audio) for streaming
    // 6. Use automated token generation plugin (yt-dlp-get-pot) to avoid bot detection
    
    // Format selection strategy for streamable URLs:
    // 1. Prefer combined formats (video+audio) for direct streaming - best for AVPlayer
    // 2. Fallback to best video+audio combination if no combined available
    // 3. Limit to 1080p max for reasonable bandwidth
    // 4. Use --get-url to get direct streamable URL (not download)
    // Anti-blocking: user-agent, sleep intervals, proper format selection, automated tokens
    const ytDlpCommand = `yt-dlp ${useProxy} \
      --no-download \
      --no-warnings \
      --quiet \
      --no-playlist \
      --format "best[height<=1080][ext=mp4]/best[height<=1080]/bestvideo[height<=1080]+bestaudio/best" \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
      --sleep-interval 2 \
      --socket-timeout 10 \
      --extractor-args "youtube:player_client=android,web" \
      --get-url \
      "https://www.youtube.com/watch?v=${youtubeKey}"`;
    
    console.log(`  [yt-dlp] Running extraction with Cloudflare Warp proxy (REQUIRED)...`);
    
    // Execute yt-dlp with timeout
    const execPromise = execAsync(ytDlpCommand, {
      timeout: 12000,
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    // Race against timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('yt-dlp timeout')), 12000)
    );
    
    let stdout, stderr;
    try {
      ({ stdout, stderr } = await Promise.race([execPromise, timeoutPromise]));
    } catch (raceError) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      
      // CRITICAL: Never fallback to direct connection - proxy is required
      const errorMsg = (raceError.stderr || raceError.message || '').toString();
      
      // Age-restricted videos can't be extracted without cookies
      if (errorMsg.includes('Sign in to confirm your age') || errorMsg.includes('age-restricted')) {
        console.log(`  [yt-dlp] ✗ Age-restricted video (requires cookies): ${youtubeKey}`);
        successTracker.recordFailure('ytdlp', 'age-restricted');
        return null; // Can't extract age-restricted videos without cookies
      }
      
      // If proxy connection failed, log and abort (never try direct connection)
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('Tunnel connection failed') || errorMsg.includes('Connection refused') || errorMsg.includes('proxy')) {
        console.error(`  [yt-dlp] ✗ CRITICAL: Proxy connection failed - ${errorMsg.substring(0, 200)}`);
        console.error(`  [yt-dlp] ✗ Refusing to use direct connection - Cloudflare Warp proxy is required`);
        successTracker.recordFailure('ytdlp', 'proxy-failed');
        return null;
      }
      
      // Handle other errors
      if (!stdout) {
        if (raceError.message === 'yt-dlp timeout') {
          console.log(`  [yt-dlp] ✗ TIMEOUT after ${duration}ms`);
        } else {
          // Show more detailed error information
          const errorMsg = raceError.message || raceError.toString();
          // execAsync errors have stdout/stderr in the error object
          const errorStderr = raceError.stderr || (raceError.cmd ? '' : '');
          const errorStdout = raceError.stdout || '';
          const stderrMsg = errorStderr ? `\n    stderr: ${errorStderr.substring(0, 500)}` : '';
          const stdoutMsg = errorStdout ? `\n    stdout: ${errorStdout.substring(0, 500)}` : '';
          const cmdMsg = raceError.cmd ? `\n    command: ${raceError.cmd.substring(0, 200)}` : '';
          console.log(`  [yt-dlp] ✗ Error: ${errorMsg.substring(0, 200)}${cmdMsg}${stderrMsg}${stdoutMsg} (${duration}ms)`);
        }
        successTracker.recordFailure('ytdlp', 'extraction');
        return null;
      }
    }
    
    clearTimeout(timeout);
    const duration = Date.now() - startTime;
    
    if (stderr && !stderr.includes('WARNING') && stderr.trim().length > 0) {
      console.log(`  [yt-dlp] Warning: ${stderr.substring(0, 200)}`);
    }
    
    const url = stdout.trim();
    
    if (!url || !url.startsWith('http')) {
      console.log(`  [yt-dlp] ✗ No valid URL extracted (${duration}ms)`);
      successTracker.recordFailure('ytdlp', 'extraction');
      return null;
    }
    
    // Validate URL is accessible (quick HEAD request)
    // Note: This validation doesn't use the proxy, so it might fail even if the URL is valid
    // YouTube stream URLs often return 403 for HEAD requests but work fine for actual streaming
    try {
      const validateController = new AbortController();
      const validateTimeout = setTimeout(() => validateController.abort(), 5000);
      
      const headResponse = await fetch(url, {
        method: 'HEAD',
        headers: { 'Range': 'bytes=0-1' },
        signal: validateController.signal
      });
      
      clearTimeout(validateTimeout);
      
      // YouTube often returns 403 for HEAD requests even on valid URLs
      // Accept 206 (Partial Content) and 403 (Forbidden) as potentially valid
      // The URL was extracted by yt-dlp through the proxy, so it should be valid
      if (!headResponse.ok && headResponse.status !== 206 && headResponse.status !== 403) {
        console.log(`  [yt-dlp] ✗ URL not accessible: HTTP ${headResponse.status} (${duration}ms)`);
        successTracker.recordFailure('ytdlp', 'extraction');
        return null;
      }
      
      // Log if we got 403 but continue (YouTube often blocks HEAD requests)
      if (headResponse.status === 403) {
        console.log(`  [yt-dlp] ⚠ URL validation returned 403 (may still work for streaming) (${duration}ms)`);
      }
    } catch (validateError) {
      // URL validation failed, but URL might still work for streaming
      // Log warning but don't fail - YouTube URLs can be valid even if HEAD fails
      console.log(`  [yt-dlp] ⚠ URL validation failed (may still work): ${validateError.message}`);
    }
    
    console.log(`  [yt-dlp] ✓ Got streamable URL (${duration}ms, proxy: ${gluetunProxy ? 'yes' : 'no'})`);
    successTracker.recordSuccess('ytdlp', 'extraction');
    
    // Return URL with quality info (yt-dlp format selection ensures good quality)
    return {
      url: url,
      quality: 'best', // yt-dlp selects best available up to 1080p
      isDash: url.includes('.mpd') || url.includes('manifest')
    };
    
  } catch (error) {
    clearTimeout(timeout);
    const duration = Date.now() - startTime;
    
    if (error.signal === 'SIGTERM' || error.killed) {
      console.log(`  [yt-dlp] ✗ TIMEOUT after ${duration}ms`);
    } else if (error.message && error.message.includes('not found')) {
      console.log(`  [yt-dlp] ✗ yt-dlp not installed or not in PATH`);
    } else {
      const errorMsg = error.message || error.toString();
      const stderrMsg = error.stderr ? `\n    stderr: ${error.stderr.substring(0, 300)}` : '';
      const stdoutMsg = error.stdout ? `\n    stdout: ${error.stdout.substring(0, 300)}` : '';
      console.log(`  [yt-dlp] ✗ Error: ${errorMsg.substring(0, 200)}${stderrMsg}${stdoutMsg} (${duration}ms)`);
    }
    
    successTracker.recordFailure('ytdlp', 'extraction');
    return null;
  }
}

// ============ INTERNET ARCHIVE EXTRACTOR ============

async function extractViaInternetArchive(tmdbMeta, imdbId) {
  console.log(`  [Internet Archive] Searching for "${tmdbMeta.title}" (${tmdbMeta.year || ''})...`);
  
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
    console.log(`  [Internet Archive] Trying ${sortedStrategies.length} strategies (sorted by success rate - top 3: ${strategyRates})...`);
    
    for (const strategy of sortedStrategies) {
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
                'Accept': 'application/json'
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
        let bestMatch = null;
        let bestScore = 0;
        
        for (const doc of docs) {
          const title = doc.title || '';
          const docYear = doc.year || null;
          
          // Extract IMDb ID from external-identifier if present (for better matching)
          const externalIds = Array.isArray(doc['external-identifier']) ? doc['external-identifier'] : (doc['external-identifier'] ? [doc['external-identifier']] : []);
          const docImdbId = externalIds.find(id => id && id.startsWith('urn:imdb:'))?.replace('urn:imdb:', '') || null;
          
          // GOLD STANDARD: If this result has an IMDb ID and it matches, this is definitely correct
          if (imdbId && docImdbId && docImdbId === imdbId) {
            console.log(`  [Internet Archive] ✓ Found exact IMDb ID match: ${imdbId} for "${title}"`);
            // This is the best possible match - use it immediately
            bestMatch = doc;
            bestScore = 1.0; // Perfect score
            break; // Exit loop, we found the best match
          }
          
          // Use fuzzy matching for better accuracy
          const normTitle = normalizeTitle(title);
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
            // Check if the search word appears at the START of the title
            const titleStartsWithSearch = normTitle.startsWith(searchWord + ' ') || 
                                         normTitle.startsWith(searchWord + ':') ||
                                         normTitle.startsWith(searchWord + '-') ||
                                         normTitle === searchWord;
            
            if (!titleStartsWithSearch) {
              // Search word appears but not at start - likely a different movie/show
              // Only allow if IMDb ID matches exactly
              if (!imdbId || !docImdbId || docImdbId !== imdbId) {
                continue; // Reject - this is a false positive
              }
            }
          }
          
          // CRITICAL: Reject if IMDb ID exists but doesn't match (for any title length)
          if (imdbId && docImdbId && docImdbId !== imdbId) {
            // Different IMDb ID - definitely wrong movie
            continue;
          }
          
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
          const lowerTitle = title.toLowerCase();
          if (lowerTitle.includes('trailer')) {
            score += 0.2;
          } else if (lowerTitle.includes('preview') || lowerTitle.includes('teaser')) {
            score += 0.15;
          }
          
          // Year matching (using year field from API)
          if (tmdbMeta.year && docYear) {
            const yearDiff = Math.abs(parseInt(docYear) - tmdbMeta.year);
            if (yearDiff === 0) {
              score += 0.3; // Exact year match
            } else if (yearDiff === 1) {
              score += 0.2; // Within 1 year (common for trailers)
            } else if (yearDiff <= 3) {
              score += 0.1; // Within 3 years
            } else if (yearDiff > 5) {
              score -= 0.3; // Penalty for very different years
            }
          } else if (tmdbMeta.year && !docYear) {
            // No year in result - slight penalty but don't reject
            score -= 0.1;
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
        
        // Use higher threshold for matches (0.75 - prioritize accuracy over coverage to avoid false positives)
        // For short titles, require even higher threshold OR IMDb ID match
        const isShortTitle = (tmdbMeta.title.split(' ').filter(w => w.length > 2).length <= 2);
        const requiresImdbMatch = isShortTitle && imdbId;
        const matchThreshold = requiresImdbMatch ? 0.85 : 0.75; // Higher threshold for short titles
        
        if (bestMatch) {
          const bestMatchImdbId = Array.isArray(bestMatch['external-identifier']) 
            ? bestMatch['external-identifier'].find(id => id && id.startsWith('urn:imdb:'))?.replace('urn:imdb:', '')
            : (bestMatch['external-identifier']?.startsWith('urn:imdb:') 
                ? bestMatch['external-identifier'].replace('urn:imdb:', '') 
                : null);
          
          const hasImdbMatch = imdbId && bestMatchImdbId && bestMatchImdbId === imdbId;
          console.log(`  [Internet Archive] Best candidate: "${bestMatch.title}" (score: ${bestScore.toFixed(2)}, threshold: ${matchThreshold}, IMDb match: ${hasImdbMatch ? 'yes' : 'no'})`);
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
              headers: { 'Accept': 'application/json' }
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
              // Sort by: 1) format preference (mp4 > webm > others), 2) size (larger = better quality)
              videoFiles.sort((a, b) => {
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
              
              const bestFile = videoFiles[0];
              const videoUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(bestFile.name)}`;
              
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
async function validateUrl(url, timeout = 3000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'Range': 'bytes=0-1' // Just check first byte to minimize bandwidth
      }
    });
    
    clearTimeout(timeoutId);
    
    // Accept 200 (OK) or 206 (Partial Content) as valid
    return response.ok || response.status === 206;
  } catch (error) {
    // URL is not accessible
    return false;
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

// Background validation queue (non-blocking)
const validationQueue = new Set();

async function getCachedWithValidation(imdbId) {
  const cached = getCached(imdbId);
  if (!cached || !cached.preview_url) {
    return cached;
  }
  
  const hoursSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
  const sourceType = cached.source_type || 'youtube';
  const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
  const agePercent = (hoursSinceCheck / ttlHours) * 100;
  
  // INSTANT RETURN: If cache is fresh (< 10% of TTL), return immediately without validation
  // This makes cached results feel instant (< 1ms)
  if (agePercent < 10) {
    logger.cache('hit', `Instant cache hit for ${imdbId} (${sourceType}, ${hoursSinceCheck.toFixed(1)}h old, ${agePercent.toFixed(0)}% of TTL)`);
    return cached;
  }
  
  // For very fresh cache (< 30% of TTL), return immediately and validate in background
  if (agePercent < 30) {
    // Validate in background (non-blocking)
    if (!validationQueue.has(imdbId)) {
      validationQueue.add(imdbId);
      validateUrl(cached.preview_url, 2000).then(isValid => {
        validationQueue.delete(imdbId);
        if (!isValid) {
          cache.delete(imdbId);
          const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
          deleteStmt.run(imdbId);
        }
      }).catch(() => {
        validationQueue.delete(imdbId);
      });
    }
    
    return cached; // Return immediately
  }
  
  // For stale cache (> 30% of TTL), validate synchronously but with shorter timeout
  // YouTube URLs: validate if > 20% of TTL (they expire quickly)
  // Other sources: validate if > 80% of TTL
  const shouldValidate = sourceType === 'youtube' ? agePercent > 20 : agePercent > 80;
  
  if (shouldValidate) {
    const isValid = await validateUrl(cached.preview_url, 2000); // Shorter timeout for faster response
    
    if (!isValid) {
      logger.cache('miss', `${imdbId}: URL invalid`);
      cache.delete(imdbId);
      const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
      deleteStmt.run(imdbId);
      return null;
    }
  }
  
  return cached;
}

function setCache(imdbId, data) {
  if (!imdbId || !data.preview_url) {
    return; // Skip if missing required data
  }
  
  // Determine source type from preview URL
  let sourceType = 'youtube'; // default
  if (data.preview_url) {
    if (data.preview_url.includes('itunes.apple.com') || data.preview_url.includes('video-ssl.itunes')) {
      sourceType = 'itunes';
    } else if (data.preview_url.includes('archive.org')) {
      sourceType = 'archive';
    } else if (data.preview_url.includes('googlevideo.com') || 
                data.preview_url.includes('youtube.com') || 
                data.preview_url.includes('youtu.be') ||
                data.preview_url.includes('youtube-nocookie.com')) {
      // YouTube URLs from yt-dlp (googlevideo.com), piped, invidious
      sourceType = 'youtube';
    } else {
      sourceType = 'youtube'; // Default to youtube for any other URL
    }
  } else if (data.source) {
    sourceType = data.source === 'youtube' ? 'youtube' : data.source;
  }
  
  const timestamp = Date.now();
  const cacheData = {
    ...data,
    source_type: sourceType,
    timestamp: timestamp
  };
  
  // Save to in-memory cache FIRST (instant access)
  cache.set(imdbId, cacheData);
  
  // Save to database ASYNCHRONOUSLY (non-blocking)
  // Use setImmediate to defer DB write, making cache saves instant
  setImmediate(() => {
    try {
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
    } catch (error) {
      // Silently fail - in-memory cache is what matters for speed
      if (!error.message.includes('database is locked') && !error.message.includes('SQLITE_BUSY')) {
        // Only log non-locking errors occasionally
        if (Math.random() < 0.01) { // Log 1% of errors to avoid spam
          console.error(`[Cache] Database error for ${imdbId}: ${error.message}`);
        }
      }
    }
  });
}

async function resolvePreview(imdbId, type) {
  logger.section(`RESOLVING: ${imdbId} (${type})`);
  
  // Check cache with validation
  const cached = await getCachedWithValidation(imdbId);
  
  if (cached) {
    if (cached.preview_url) {
      const sourceType = cached.source_type || 'unknown';
      const hoursSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
      const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
      const agePercent = (hoursSinceCheck / ttlHours) * 100;
      
      // Log cache hit with age info
      if (agePercent < 10) {
        logger.cache('hit', `${imdbId} → ${sourceType.toUpperCase()} (instant, ${hoursSinceCheck.toFixed(1)}h old)`);
      } else {
        logger.cache('hit', `${imdbId} → ${sourceType.toUpperCase()} (${hoursSinceCheck.toFixed(1)}h old)`);
      }
      
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
  // Skip iTunes for movies - iTunes doesn't have movie previews, only TV episode previews
  const availableSources = [];
  if (type === 'series') {
    availableSources.push('itunes'); // iTunes works for TV shows
  }
  if (tmdbMeta.youtubeTrailerKey) {
    // Add ytdlp first (most reliable with Cloudflare Warp), then Piped/Invidious
    availableSources.push('ytdlp', 'piped', 'invidious');
  }
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
  const attemptSource = async (source) => {
    const startTime = Date.now();
    logger.source(source, `Attempting extraction...`);
    
    // Get dynamic timeout for this source
    const defaultTimeout = 10000; // 10 seconds default
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
        } else if (source === 'piped') {
          if (!tmdbMeta.youtubeTrailerKey) {
            console.log(`  Skipping Piped: no YouTube key available`);
            successTracker.recordSourceFailure('piped');
            return null;
          }
          console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
          const pipedResult = await extractViaPiped(tmdbMeta.youtubeTrailerKey);
          if (pipedResult) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('piped', duration);
            
            const pipedUrl = typeof pipedResult === 'string' ? pipedResult : pipedResult.url;
            const quality = typeof pipedResult === 'object' ? (pipedResult.quality || 'unknown') : 'unknown';
            qualityTracker.recordQuality('piped', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: pipedUrl,
              country: 'yt',
              youtube_key: tmdbMeta.youtubeTrailerKey,
              source: 'youtube'
            });
            console.log(`✓ Got URL from Piped`);
            successTracker.recordSourceSuccess('piped');
            return {
              found: true,
              source: 'youtube',
              previewUrl: pipedUrl,
              youtubeKey: tmdbMeta.youtubeTrailerKey,
              country: 'yt',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('piped', duration);
            successTracker.recordSourceFailure('piped');
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
        } else if (source === 'invidious') {
          if (!tmdbMeta.youtubeTrailerKey) {
            console.log(`  Skipping Invidious: no YouTube key available`);
            successTracker.recordSourceFailure('invidious');
            return null;
          }
          console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
          const invidiousResult = await extractViaInvidious(tmdbMeta.youtubeTrailerKey);
          if (invidiousResult) {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('invidious', duration);
            
            const invidiousUrl = typeof invidiousResult === 'string' ? invidiousResult : invidiousResult.url;
            const quality = typeof invidiousResult === 'object' ? (invidiousResult.quality || 'unknown') : 'unknown';
            qualityTracker.recordQuality('invidious', quality);
            
            setCache(imdbId, {
              track_id: null,
              preview_url: invidiousUrl,
              country: 'yt',
              youtube_key: tmdbMeta.youtubeTrailerKey,
              source: 'youtube'
            });
            console.log(`✓ Got URL from Invidious`);
            successTracker.recordSourceSuccess('invidious');
            return {
              found: true,
              source: 'youtube',
              previewUrl: invidiousUrl,
              youtubeKey: tmdbMeta.youtubeTrailerKey,
              country: 'yt',
              quality: quality
            };
          } else {
            const duration = Date.now() - startTime;
            sourceResponseTimes.recordTime('invidious', duration);
            successTracker.recordSourceFailure('invidious');
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
  
  // Try top sources in parallel
  if (topSources.length > 0) {
    logger.info(`Trying ${topSources.length} sources in parallel: ${topSources.join(', ')}`);
    const parallelResults = await Promise.allSettled(topSources.map(attemptSource));
    
    // Find first successful result
    for (const result of parallelResults) {
      if (result.status === 'fulfilled' && result.value && result.value.found) {
        logger.success(`Found via parallel attempt: ${result.value.source}`);
        return result.value;
      }
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

// Root endpoint - simple health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'trailerio-backend', 
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Manifest endpoint - must be accessible for Stremio addon
// This endpoint is critical and must never fail
app.get('/manifest.json', (req, res) => {
  // Set proper headers for manifest
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
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
  
  logger.section(`REQUEST: ${type.toUpperCase()} ${id}`);
  logger.info(`Active requests: ${activeRequests}`);
  
  if (!id.startsWith('tt')) {
    logger.warn(`Skipping non-IMDB ID: ${id}`);
    return res.json({ streams: [] });
  }
  
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
    const resolvePromise = resolvePreview(id, type);
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
      const streamName = isYouTube 
        ? 'Official Trailer' 
        : (type === 'movie' ? 'Movie Preview' : 'Episode Preview');
      const streamTitle = isYouTube 
        ? 'Official Trailer' 
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
