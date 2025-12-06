// Standalone Express server for Stremio addon (no Supabase dependency)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// In-memory cache (replace Supabase)
const cache = new Map();
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];

// CORS headers
app.use(cors());
app.use(express.json());

// ============ TITLE NORMALIZATION ============

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

// ============ TMDB METADATA ============

async function getTMDBMetadata(imdbId, type) {
  try {
    if (!TMDB_API_KEY) {
      console.error('TMDB_API_KEY is not set!');
      return null;
    }
    
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const findResponse = await fetch(findUrl);
    
    if (!findResponse.ok) {
      console.error(`TMDB find API error: ${findResponse.status} ${findResponse.statusText}`);
      return null;
    }
    
    const findData = await findResponse.json();
    
    const tmdbId = findData[type === 'movie' ? 'movie_results' : 'tv_results']?.[0]?.id;
    if (!tmdbId) {
      console.log(`No TMDB ID found for ${imdbId} (${type})`);
      return null;
    }
    
    const detailsUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=alternative_titles`;
    const detailsResponse = await fetch(detailsUrl);
    
    if (!detailsResponse.ok) {
      console.error(`TMDB details API error: ${detailsResponse.status} ${detailsResponse.statusText}`);
      return null;
    }
    
    const details = await detailsResponse.json();
    
    const videosUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}/videos?api_key=${TMDB_API_KEY}`;
    const videosResponse = await fetch(videosUrl);
    
    if (!videosResponse.ok) {
      console.error(`TMDB videos API error: ${videosResponse.status} ${videosResponse.statusText}`);
      return null;
    }
    
    const videos = await videosResponse.json();
    
    const trailer = videos.results?.find(v => v.type === 'Trailer' && v.site === 'YouTube');
    
    if (!trailer) {
      console.log(`No YouTube trailer found for ${imdbId} (${type})`);
    }
    
    return {
      tmdbId,
      mediaType: type,
      title: details.title || details.name,
      originalTitle: details.original_title || details.original_name,
      year: details.release_date ? new Date(details.release_date).getFullYear() : null,
      runtime: details.runtime || details.episode_run_time?.[0] || null,
      altTitles: details.alternative_titles?.titles?.map(t => t.title) || [],
      youtubeTrailerKey: trailer?.key || null
    };
  } catch (error) {
    console.error('TMDB error:', error.message || error);
    return null;
  }
}

// ============ YOUTUBE EXTRACTION ============

const PIPED_FALLBACK_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncpundit.io',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.movire.xyz',
];

let cachedPipedInstances = null;
let pipedCacheTime = 0;
const PIPED_CACHE_TTL = 3600000; // 1 hour

async function getWorkingPipedInstances() {
  if (cachedPipedInstances && Date.now() - pipedCacheTime < PIPED_CACHE_TTL) {
    return cachedPipedInstances;
  }
  
  const combined = [...PIPED_FALLBACK_INSTANCES];
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch('https://piped-instances.kavin.rocks/', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const instances = await response.json();
      const dynamicInstances = instances
        .filter(i => i.api_url)
        .sort((a, b) => (b.uptime_24h || 50) - (a.uptime_24h || 50))
        .map(i => i.api_url);
      
      for (const inst of dynamicInstances) {
        if (!combined.includes(inst)) {
          combined.push(inst);
        }
      }
    }
  } catch (e) {
    console.log('Dynamic Piped fetch failed, using fallback instances');
  }
  
  const result = combined.slice(0, 20);
  cachedPipedInstances = result;
  pipedCacheTime = Date.now();
  return result;
}

async function extractViaPiped(youtubeKey) {
  const instances = await getWorkingPipedInstances();
  console.log(`Trying ${instances.length} Piped instances for key: ${youtubeKey}`);
  
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    try {
      const url = `${instance}/streams/${youtubeKey}`;
      console.log(`Trying instance ${i + 1}/${instances.length}: ${instance}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`Instance ${instance} returned data, checking streams...`);
        
        // Try different possible response formats
        let videoStreams = data.videoStreams || data.videoStreams || [];
        
        // Some Piped instances use different formats
        if (!videoStreams.length && data.formats) {
          videoStreams = data.formats;
        }
        
        if (!videoStreams.length && data.streams) {
          videoStreams = data.streams;
        }
        
        if (videoStreams && videoStreams.length > 0) {
          const stream = videoStreams.find(s => s.quality === '720p' || s.quality === '1080p') || videoStreams[0];
          if (stream && stream.url) {
            console.log(`Successfully extracted URL from ${instance}`);
            return stream.url;
          }
        } else {
          console.log(`Instance ${instance} returned no video streams`);
        }
      } else {
        console.log(`Instance ${instance} returned status ${response.status}`);
      }
    } catch (e) {
      console.log(`Instance ${instance} failed: ${e.message || e}`);
      continue;
    }
  }
  
  console.log(`All Piped instances failed for key: ${youtubeKey}`);
  return null;
}

async function extractYouTubeDirectUrl(youtubeKey) {
  // Try Piped first
  const pipedUrl = await extractViaPiped(youtubeKey);
  if (pipedUrl) {
    return pipedUrl;
  }
  
  // Fallback: Try Invidious API
  console.log(`Trying Invidious as fallback for key: ${youtubeKey}`);
  const invidiousInstances = [
    'https://inv.riverside.rocks',
    'https://invidious.flokinet.to',
    'https://invidious.osi.kr',
    'https://invidious.io.lol'
  ];
  
  for (const instance of invidiousInstances) {
    try {
      const url = `${instance}/api/v1/videos/${youtubeKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        // Invidious format: data.formatStreams or data.adaptiveFormats
        const streams = data.formatStreams || data.adaptiveFormats || [];
        if (streams.length > 0) {
          const stream = streams.find(s => s.qualityLabel === '720p' || s.qualityLabel === '1080p') || streams[0];
          if (stream && stream.url) {
            console.log(`Successfully extracted URL from Invidious: ${instance}`);
            return stream.url;
          }
        }
      }
    } catch (e) {
      continue;
    }
  }
  
  console.log(`All extraction methods failed for key: ${youtubeKey}`);
  return null;
}

// ============ CACHE HELPERS ============

function getCacheKey(imdbId, type) {
  return `preview:${type}:${imdbId}`;
}

function getCached(imdbId, type) {
  const key = getCacheKey(imdbId, type);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DAYS * 24 * 60 * 60 * 1000) {
    return cached.data;
  }
  return null;
}

function setCache(imdbId, type, data) {
  const key = getCacheKey(imdbId, type);
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// ============ MAIN RESOLUTION ============

async function resolvePreview(imdbId, type) {
  console.log(`Resolving preview for ${imdbId} (${type})`);
  
  // Check cache first
  const cached = getCached(imdbId, type);
  if (cached) {
    console.log(`Cache hit for ${imdbId}`);
    return cached;
  }
  
  // Get TMDB metadata
  console.log(`Fetching TMDB metadata for ${imdbId}...`);
  const metadata = await getTMDBMetadata(imdbId, type);
  if (!metadata) {
    console.log(`No TMDB metadata found for ${imdbId}`);
    setCache(imdbId, type, { found: false });
    return { found: false };
  }
  
  if (!metadata.youtubeTrailerKey) {
    console.log(`No YouTube trailer key found for ${imdbId}`);
    setCache(imdbId, type, { found: false });
    return { found: false };
  }
  
  // Extract YouTube URL
  console.log(`Extracting YouTube URL for key: ${metadata.youtubeTrailerKey}`);
  const youtubeUrl = await extractYouTubeDirectUrl(metadata.youtubeTrailerKey);
  if (!youtubeUrl) {
    console.log(`Failed to extract YouTube URL for ${imdbId}`);
    setCache(imdbId, type, { found: false });
    return { found: false };
  }
  
  console.log(`Successfully resolved preview for ${imdbId}`);
  const result = {
    found: true,
    previewUrl: youtubeUrl,
    source: 'youtube',
    country: 'us'
  };
  
  setCache(imdbId, type, result);
  return result;
}

// ============ ROUTES ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

app.get('/manifest.json', (req, res) => {
  // Get the base URL from the request, handling proxy headers
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
  const baseUrl = `${protocol}://${host}`;
  
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
  
  console.log(`Stream request: ${type}/${id}`);
  
  if (!id.startsWith('tt')) {
    console.log(`Invalid ID format: ${id}`);
    return res.json({ streams: [] });
  }
  
  try {
    const result = await resolvePreview(id, type);
    
    if (result.found && result.previewUrl) {
      const streamName = 'Official Trailer';
      const streamTitle = 'Official Trailer';
      
      console.log(`Returning stream for ${id}: ${result.previewUrl.substring(0, 50)}...`);
      return res.json({
        streams: [{
          name: streamName,
          title: streamTitle,
          url: result.previewUrl
        }]
      });
    }
    
    console.log(`No preview found for ${id}`);
    res.json({ streams: [] });
  } catch (error) {
    console.error('Stream error:', error.message || error);
    console.error('Stack:', error.stack);
    res.json({ streams: [] });
  }
});

app.get('/stats', (req, res) => {
  // Simple stats from cache
  const totalEntries = cache.size;
  const hits = totalEntries; // All cached entries are hits
  const misses = 0; // We don't track misses in this simple version
  
  res.json({
    cache: {
      totalEntries,
      hits,
      misses,
      hitRate: totalEntries > 0 ? '100%' : '0%'
    },
    recentHits: [],
    recentMisses: []
  });
});

app.listen(PORT, () => {
  console.log(`Stremio addon server running on port ${PORT}`);
  if (!TMDB_API_KEY) {
    console.warn('⚠️  TMDB_API_KEY not set. Please set it as an environment variable.');
  }
});

