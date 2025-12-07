const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];
const STREAM_TIMEOUT = 20000; // 20 seconds - reduced to fail faster

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
console.log(`Loaded ${cache.size} cached items from database (limited to ${MAX_CACHE_SIZE} most recent)`);

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
  sources: new Map()
};

const trackerTypes = ['piped', 'invidious', 'itunes', 'archive', 'sources'];
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
  const trackerTypes = ['piped', 'invidious', 'itunes', 'archive', 'sources'];
  
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
      sources: successTracker.sources.size
    },
    requests: {
      active: activeRequests,
      total: totalRequests
    }
  });
});

// Success rate tracking for smart sorting
const successTracker = {
  // Source-level tracking (overall success rate for each source)
  sources: successTrackerData.sources || new Map(), // 'itunes' | 'piped' | 'invidious' | 'archive' -> { success: number, total: number }
  // Instance/strategy-level tracking (within each source)
  piped: successTrackerData.piped || new Map(), // instance URL -> { success: number, total: number }
  invidious: successTrackerData.invidious || new Map(), // instance URL -> { success: number, total: number }
  itunes: successTrackerData.itunes || new Map(), // country code -> { success: number, total: number }
  archive: successTrackerData.archive || new Map(), // strategy ID -> { success: number, total: number }
  
  // Database operations
  _saveToDB(type, identifier, success, total) {
    const stmt = db.prepare(`
      INSERT INTO success_tracker (type, identifier, success, total)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type, identifier) DO UPDATE SET success = ?, total = ?
    `);
    stmt.run(type, identifier, success, total, success, total);
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
  },
  
  getSuccessRate(type, identifier) {
    const map = this[type];
    const stats = map.get(identifier);
    if (!stats || stats.total === 0) return 0.5; // Default to 50% for untested
    return stats.success / stats.total;
  },
  
  sortBySuccessRate(type, list) {
    return [...list].sort((a, b) => {
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
  
  getSortedSources(availableSources) {
    return [...availableSources].sort((a, b) => {
      const rateA = this.getSourceSuccessRate(a);
      const rateB = this.getSourceSuccessRate(b);
      return rateB - rateA; // Sort descending (highest success rate first)
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

app.use(cors());
app.use(express.json());

// Request tracking middleware
app.use((req, res, next) => {
  activeRequests++;
  totalRequests++;
  const requestId = totalRequests;
  let finished = false;
  console.log(`[REQ ${requestId}] ${req.method} ${req.path} - Active: ${activeRequests}`);
  
  res.on('finish', () => {
    if (!finished) {
      finished = true;
      activeRequests--;
      console.log(`[REQ ${requestId}] Finished - Active: ${activeRequests}`);
    }
  });
  
  res.on('close', () => {
    if (!finished) {
      finished = true;
      activeRequests--;
      console.log(`[REQ ${requestId}] Closed - Active: ${activeRequests}`);
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
  if (trailer) {
    youtubeTrailerKey = trailer.key;
    console.log(`Found official trailer: ${trailer.name || 'Trailer'}`);
  } else {
    // Priority 2: Official Teaser
    trailer = filteredVideos.find(v => 
      v.type === 'Teaser' && 
      v.official === true
    );
    if (trailer) {
      youtubeTrailerKey = trailer.key;
      console.log(`Found official teaser: ${trailer.name || 'Teaser'}`);
    } else {
      // Priority 3: Any Trailer (not official)
      trailer = filteredVideos.find(v => v.type === 'Trailer');
      if (trailer) {
        youtubeTrailerKey = trailer.key;
        console.log(`Found trailer: ${trailer.name || 'Trailer'}`);
      } else {
        // Priority 4: Official Clip
        trailer = filteredVideos.find(v => 
          v.type === 'Clip' && 
          v.official === true
        );
        if (trailer) {
          youtubeTrailerKey = trailer.key;
          console.log(`Found official clip: ${trailer.name || 'Clip'}`);
        } else {
          // Last resort: Any YouTube video (but prefer official)
          trailer = filteredVideos.find(v => v.official === true) || filteredVideos[0];
          if (trailer) {
            youtubeTrailerKey = trailer.key;
            console.log(`Found YouTube video: ${trailer.name || 'Video'} (${trailer.type})`);
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
    youtubeTrailerKey
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
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout - fail faster
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${instance}/streams/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      
      if (!response.ok) {
        console.log(`  [Piped] ${instance}: HTTP ${response.status} (${duration}ms)`);
        successTracker.recordFailure('piped', instance);
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.log(`  [Piped] ${instance}: non-JSON response (${contentType || 'no content-type'}): ${text.substring(0, 100)}`);
        successTracker.recordFailure('piped', instance);
        return null;
      }
      
      const data = await response.json();
      console.log(`  [Piped] ${instance}: got response (${duration}ms), has dash: ${!!data.dash}, videoStreams: ${data.videoStreams?.length || 0}`);
      
      // PRIORITY 1: DASH manifest (best for AVPlayer - native support, adaptive streaming, highest quality)
      if (data.dash) {
        console.log(`  ✓ [Piped] ${instance}: got DASH manifest (adaptive quality up to highest available + audio)`);
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
      const errorType = e.name === 'AbortError' ? 'TIMEOUT' : e.code || 'ERROR';
      console.log(`  [Piped] ${instance}: ${errorType} after ${duration}ms - ${e.message || 'unknown error'}`);
      successTracker.recordFailure('piped', instance);
      return null;
    }
  };
  
  const results = await Promise.allSettled(sortedInstances.map(tryInstance));
  const successfulResults = results
    .map((r) => r.status === 'fulfilled' && r.value ? r.value : null)
    .filter(r => r !== null);
  
  if (successfulResults.length === 0) {
    console.log(`  ✗ [Piped] All ${sortedInstances.length} instances failed or timed out`);
    return null;
  }
  
  console.log(`  ✓ [Piped] ${successfulResults.length}/${sortedInstances.length} instances succeeded`);
  
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
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout - fail faster
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${instance}/api/v1/videos/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      
      if (!response.ok) {
        console.log(`  [Invidious] ${instance}: HTTP ${response.status} (${duration}ms)`);
        successTracker.recordFailure('invidious', instance);
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.log(`  [Invidious] ${instance}: non-JSON response (${contentType || 'no content-type'}): ${text.substring(0, 100)}`);
        successTracker.recordFailure('invidious', instance);
        return null;
      }
      
      const data = await response.json();
      console.log(`  [Invidious] ${instance}: got response (${duration}ms), formatStreams: ${data.formatStreams?.length || 0}`);
      
      const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
      const getQualityRank = (label) => {
        if (!label) return 999;
        const idx = qualityPriority.findIndex(q => label.includes(q));
        return idx === -1 ? 998 : idx;
      };
      
      if (data.formatStreams?.length > 0) {
        const sorted = [...data.formatStreams]
          .filter(s => s.container === 'mp4' || s.mimeType?.includes('mp4'))
          .sort((a, b) => getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel));
        
        if (sorted.length > 0) {
          const best = sorted[0];
          console.log(`  ✓ [Invidious] ${instance}: got ${best.qualityLabel || 'unknown'}`);
          successTracker.recordSuccess('invidious', instance);
          return best.url;
        }
      }
      
      successTracker.recordFailure('invidious', instance);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const errorType = e.name === 'AbortError' ? 'TIMEOUT' : e.code || 'ERROR';
      console.log(`  [Invidious] ${instance}: ${errorType} after ${duration}ms - ${e.message || 'unknown error'}`);
      successTracker.recordFailure('invidious', instance);
      return null;
    }
  };
  
  const results = await Promise.allSettled(sortedInstances.map(tryInstance));
  const validUrl = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)[0];
  
  if (validUrl) {
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    console.log(`  ✓ [Invidious] Got URL from Invidious (${successCount}/${sortedInstances.length} instances succeeded)`);
    return validUrl;
  }
  
  console.log(`  ✗ [Invidious] All ${sortedInstances.length} instances failed or timed out`);
  return null;
}

// ============ INTERNET ARCHIVE EXTRACTOR ============

async function extractViaInternetArchive(tmdbMeta) {
  console.log(`  [Internet Archive] Searching for "${tmdbMeta.title}" (${tmdbMeta.year || ''})...`);
  
  try {
    // Build search queries - use better Internet Archive query syntax
    const titleQuery = tmdbMeta.title.replace(/[^\w\s]/g, ' ').trim().replace(/\s+/g, ' ');
    const yearQuery = tmdbMeta.year ? ` AND year:${tmdbMeta.year}` : '';
    
    // Define search strategies with IDs for tracking
    const searchStrategies = [
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
    
    // Add original title strategy if different
    if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
      const originalTitleQuery = tmdbMeta.originalTitle.replace(/[^\w\s]/g, ' ').trim();
      searchStrategies.push({
        id: 'archive_collection_original_year',
        query: `collection:movie_trailers AND title:${encodeURIComponent(originalTitleQuery)}${yearQuery}`,
        description: 'Original title + year in movie_trailers'
      });
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
      // Use advancedsearch API with better field selection
      const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(strategy.query)}&fl=identifier,title,description,date,downloads,creator,subject&sort[]=downloads+desc&rows=20&output=json`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const startTime = Date.now();
      
      try {
        // Retry logic for 502 errors (temporary server issues)
        let response = null;
        let lastError = null;
        const maxRetries = 2;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), 8000);
            response = await fetch(searchUrl, { signal: retryController.signal });
            clearTimeout(retryTimeout);
            
            if (response.ok) {
              break; // Success, exit retry loop
            }
            
            // If 502 and we have retries left, wait and retry
            if (response.status === 502 && attempt < maxRetries) {
              console.log(`  [Internet Archive] HTTP 502 on attempt ${attempt + 1}, retrying...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
              continue;
            }
            
            // Not a retryable error or out of retries
            break;
          } catch (fetchError) {
            lastError = fetchError;
            if (attempt < maxRetries && fetchError.name !== 'AbortError') {
              console.log(`  [Internet Archive] Error on attempt ${attempt + 1}, retrying...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
              continue;
            }
            throw fetchError;
          }
        }
        
        clearTimeout(timeout);
        const duration = Date.now() - startTime;
        
        if (!response || !response.ok) {
          const status = response ? response.status : 'NO_RESPONSE';
          console.log(`  [Internet Archive] Search failed: HTTP ${status} (${duration}ms) for strategy "${strategy.description}" after ${maxRetries + 1} attempts`);
          successTracker.recordFailure('archive', strategy.id);
          continue;
        }
        
        const data = await response.json();
        const docs = data.response?.docs || [];
        
        console.log(`  [Internet Archive] Query returned ${docs.length} results (${duration}ms) for strategy "${strategy.description}"`);
        
        if (docs.length === 0) {
          successTracker.recordFailure('archive', strategy.id);
          continue;
        }
        
        // Find best match using fuzzy matching (like iTunes)
        let bestMatch = null;
        let bestScore = 0;
        
        for (const doc of docs) {
          const title = doc.title || '';
          const description = doc.description || '';
          const creator = doc.creator || '';
          const subject = Array.isArray(doc.subject) ? doc.subject.join(' ') : (doc.subject || '');
          
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
          
          // Title matching (most important) - be more strict
          if (normTitle === normSearchTitle) {
            score += 1.0; // Exact match
          } else if (normTitle === normOriginalTitle) {
            score += 0.9; // Exact match with original title
          } else {
            // Check if title contains the movie title as a complete word (more strict)
            const searchWords = normSearchTitle.split(' ').filter(w => w.length > 2); // Ignore short words
            const titleWords = normTitle.split(' ');
            const matchingWords = searchWords.filter(word => titleWords.includes(word));
            const wordMatchRatio = searchWords.length > 0 ? matchingWords.length / searchWords.length : 0;
            
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
          
          // Year matching
          if (tmdbMeta.year) {
            const yearStr = String(tmdbMeta.year);
            if (title.includes(yearStr) || description.includes(yearStr) || subject.includes(yearStr)) {
              score += 0.3;
            }
            // Check date field if available
            if (doc.date) {
              const docYear = parseInt(doc.date.substring(0, 4));
              if (docYear && Math.abs(docYear - tmdbMeta.year) <= 1) {
                score += 0.2;
              }
            }
          }
          
          // Downloads bonus (more popular = more likely to be correct)
          if (doc.downloads) {
            const downloads = parseInt(doc.downloads) || 0;
            if (downloads > 1000) score += 0.1;
            if (downloads > 10000) score += 0.1;
          }
          
          // Description/subject matching
          const allText = `${description} ${subject} ${creator}`.toLowerCase();
          if (allText.includes(normSearchTitle)) {
            score += 0.2;
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = doc;
          }
        }
        
        // Use higher threshold for matches (0.75 - prioritize accuracy over coverage to avoid false positives)
        // Require strong title matching to ensure relevance
        if (bestMatch) {
          console.log(`  [Internet Archive] Best candidate: "${bestMatch.title}" (score: ${bestScore.toFixed(2)}, threshold: 0.75)`);
        }
        
        if (bestMatch && bestScore >= 0.75) {
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
              
              console.log(`  ✓ [Internet Archive] Found: "${bestMatch.title}" (${bestFile.format || 'video'}, ${Math.round((bestFile.size || 0) / 1024 / 1024)}MB) via strategy "${strategy.description}"`);
              successTracker.recordSuccess('archive', strategy.id);
              return videoUrl;
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

async function getCachedWithValidation(imdbId) {
  const cached = getCached(imdbId);
  if (!cached || !cached.preview_url) {
    return cached;
  }
  
  // For YouTube URLs, always validate (they expire quickly)
  // For other sources, only validate if cache is getting old
  const hoursSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
  const sourceType = cached.source_type || 'youtube';
  const ttlHours = CACHE_TTL[sourceType] || CACHE_TTL.youtube;
  const shouldValidate = sourceType === 'youtube' || hoursSinceCheck > (ttlHours * 0.8); // Validate if 80% through TTL
  
  if (shouldValidate) {
    console.log(`  [Cache] Validating cached URL for ${imdbId} (${sourceType}, ${hoursSinceCheck.toFixed(1)}h old)...`);
    const isValid = await validateUrl(cached.preview_url);
    
    if (!isValid) {
      console.log(`  [Cache] ✗ Cached URL is no longer valid, invalidating cache for ${imdbId}`);
      cache.delete(imdbId);
      // Also delete from database
      const deleteStmt = db.prepare('DELETE FROM cache WHERE imdb_id = ?');
      deleteStmt.run(imdbId);
      return null;
    }
    
    console.log(`  [Cache] ✓ Cached URL is still valid`);
  }
  
  return cached;
}

function setCache(imdbId, data) {
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
  
  // Save to in-memory cache
  cache.set(imdbId, cacheData);
  
  // Save to database
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
}

async function resolvePreview(imdbId, type) {
  console.log(`\n========== Resolving ${imdbId} (${type}) ==========`);
  
  // Check cache with validation
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
    if (!cached.youtube_key) {
      console.log('Cache hit: negative cache (no preview found previously)');
      return { found: false };
    }
    console.log('Cache expired, refreshing...');
  }
  
  const tmdbMeta = await getTMDBMetadata(imdbId, type);
  if (!tmdbMeta) {
    setCache(imdbId, { preview_url: null, youtube_key: null, country: 'us' });
    return { found: false };
  }
  
  // Build list of available sources based on what we have
  // Skip iTunes for movies - iTunes doesn't have movie previews, only TV episode previews
  const availableSources = [];
  if (type === 'series') {
    availableSources.push('itunes'); // iTunes works for TV shows
  }
  if (tmdbMeta.youtubeTrailerKey) {
    availableSources.push('piped', 'invidious');
  }
  availableSources.push('archive');
  
  // Sort sources by success rate (highest first)
  const sortedSources = successTracker.getSortedSources(availableSources);
  const sourceRates = sortedSources.map(s => {
    const rate = successTracker.getSourceSuccessRate(s);
    return `${s.toUpperCase()} (${(rate * 100).toFixed(0)}%)`;
  }).join(', ');
  console.log(`\n========== Trying sources in order (sorted by success rate): ${sourceRates} ==========`);
  
  // Try each source in sorted order
  const SOURCE_TIMEOUT = 15000; // 15 seconds per source
  
  for (const source of sortedSources) {
    console.log(`\n========== Trying ${source.toUpperCase()} ==========`);
    
    try {
      // Wrap each source attempt in a timeout to prevent hanging
      const sourceAttempt = async () => {
        if (source === 'itunes') {
          const itunesResult = await multiPassSearch(tmdbMeta);
          console.log(`iTunes search result: ${itunesResult.found ? 'FOUND' : 'NOT FOUND'}`);
          
          if (itunesResult.found) {
            setCache(imdbId, {
              track_id: itunesResult.trackId,
              preview_url: itunesResult.previewUrl,
              country: itunesResult.country || 'us',
              youtube_key: tmdbMeta.youtubeTrailerKey || null,
              source: 'itunes'
            });
            console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
            successTracker.recordSourceSuccess('itunes');
            return { ...itunesResult, source: 'itunes' };
          } else {
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
            const pipedUrl = typeof pipedResult === 'string' ? pipedResult : pipedResult.url;
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
              country: 'yt'
            };
          } else {
            successTracker.recordSourceFailure('piped');
            return null;
          }
        } else if (source === 'invidious') {
          if (!tmdbMeta.youtubeTrailerKey) {
            console.log(`  Skipping Invidious: no YouTube key available`);
            successTracker.recordSourceFailure('invidious');
            return null;
          }
          console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
          const invidiousUrl = await extractViaInvidious(tmdbMeta.youtubeTrailerKey);
          if (invidiousUrl) {
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
              country: 'yt'
            };
          } else {
            successTracker.recordSourceFailure('invidious');
            return null;
          }
        } else if (source === 'archive') {
          const archiveUrl = await extractViaInternetArchive(tmdbMeta);
          if (archiveUrl) {
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
              country: 'archive'
            };
          } else {
            successTracker.recordSourceFailure('archive');
            return null;
          }
        }
        return null;
      };
      
      // Race the source attempt against a timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Source ${source} timeout after ${SOURCE_TIMEOUT}ms`)), SOURCE_TIMEOUT)
      );
      
      const result = await Promise.race([sourceAttempt(), timeoutPromise]);
      
      if (result && result.found) {
        return result;
      }
    } catch (error) {
      if (error.message && error.message.includes('timeout')) {
        console.log(`  ⚠️ ${source.toUpperCase()} timed out after ${SOURCE_TIMEOUT}ms`);
      } else {
        console.log(`  ✗ Error in ${source.toUpperCase()}: ${error.message || 'unknown error'}`);
      }
      successTracker.recordSourceFailure(source);
      // Continue to next source instead of crashing
      continue;
    }
  }
  
  setCache(imdbId, {
    track_id: null,
    preview_url: null,
    country: 'us',
    youtube_key: null
  });
  
  console.log('No preview found from iTunes, YouTube, or Internet Archive');
  return { found: false };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'trailerio-backend', version: '2.0.0' });
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
  
  console.log(`\n========== Stream request: type=${type}, id=${id} (Active requests: ${activeRequests}) ==========`);
  
  if (!id.startsWith('tt')) {
    console.log(`  Skipping non-IMDB ID: ${id}`);
    return res.json({ streams: [] });
  }
  
  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    console.log(`  ⚠️ Request timeout for ${id} after ${STREAM_TIMEOUT / 1000}s`);
    if (!res.headersSent) {
      res.json({ streams: [] });
    }
  }, STREAM_TIMEOUT);
  
  try {
    // Wrap resolvePreview in a promise race to ensure it doesn't exceed timeout
    const resolvePromise = resolvePreview(id, type);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), STREAM_TIMEOUT - 500)
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
      
      console.log(`  ✓ Returning stream for ${id}: ${finalUrl.substring(0, 80)}...`);
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
    
    console.log(`  ✗ No preview found for ${id}`);
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

app.listen(PORT, () => {
  console.log(`Stremio addon server running on port ${PORT}`);
  if (!TMDB_API_KEY) {
    console.warn('⚠️  TMDB_API_KEY not set. Please set it as an environment variable.');
  }
});
