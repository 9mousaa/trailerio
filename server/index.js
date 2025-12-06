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
  'https://pipedapi.r4fo.com',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
  'https://piped-api.lunar.icu',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.mha.fi',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
];

let cachedPipedInstances = null;
let pipedCacheTime = 0;
const PIPED_CACHE_TTL = 3600000; // 1 hour

async function getWorkingPipedInstances() {
  if (cachedPipedInstances && Date.now() - pipedCacheTime < PIPED_CACHE_TTL) {
    console.log(`Using cached Piped instances (${cachedPipedInstances.length} instances)`);
    return cachedPipedInstances;
  }
  
  const combined = [...PIPED_FALLBACK_INSTANCES];
  console.log(`Starting with ${combined.length} fallback Piped instances`);
  
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
      
      console.log(`Fetched ${dynamicInstances.length} dynamic Piped instances`);
      
      for (const inst of dynamicInstances) {
        if (!combined.includes(inst)) {
          combined.push(inst);
        }
      }
    } else {
      console.log(`Dynamic Piped API returned ${response.status}, using fallback only`);
    }
  } catch (e) {
    console.log(`Dynamic Piped fetch failed: ${e.message || e}, using fallback instances`);
  }
  
  const result = combined.slice(0, 20);
  console.log(`Total Piped instances: ${result.length}`);
  cachedPipedInstances = result;
  pipedCacheTime = Date.now();
  return result;
}

async function extractViaPiped(youtubeKey) {
  try {
    const instances = await getWorkingPipedInstances();
    console.log(`Trying ${instances.length} Piped instances for ${youtubeKey}`);
    
    if (!instances || instances.length === 0) {
      console.log('No Piped instances available');
      return null;
    }
    
    const tryInstance = async (instance) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      
      try {
        const url = `${instance}/streams/${youtubeKey}`;
        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeout);
        
        if (!response.ok) {
          console.log(`  Piped ${instance}: HTTP ${response.status}`);
          return null;
        }
        const data = await response.json();
      
      // PRIORITY 1: Use DASH manifest if available (adaptive streaming with high quality + audio)
      if (data.dash) {
        console.log(`  ✓ Piped ${instance}: got DASH manifest (adaptive quality + audio)`);
        return data.dash;
      }
      
      // PRIORITY 2: Fall back to individual streams
      if (data.videoStreams?.length > 0) {
        // Quality priority: highest first
        const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
        const getQualityRank = (q) => {
          if (!q) return 999;
          const idx = qualityPriority.findIndex(p => q.includes(p));
          return idx === -1 ? 998 : idx;
        };
        
        // Sort streams by quality (highest first)
        const sorted = [...data.videoStreams]
          .filter(s => s.mimeType?.startsWith('video/') && s.url)
          .sort((a, b) => getQualityRank(a.quality) - getQualityRank(b.quality));
        
        // Prefer combined streams (have audio) for guaranteed playback
        const bestCombined = sorted.find(s => !s.videoOnly);
        if (bestCombined?.url) {
          console.log(`  ✓ Piped ${instance}: got ${bestCombined.quality || 'unknown'} (combined)`);
          return bestCombined.url;
        }
        
        // Last resort: video-only stream (may not have audio)
        const bestVideoOnly = sorted.find(s => s.videoOnly);
        if (bestVideoOnly?.url) {
          console.log(`  ✓ Piped ${instance}: got ${bestVideoOnly.quality || 'unknown'} (video-only)`);
          return bestVideoOnly.url;
        }
      }
      
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  Piped ${instance}: error - ${e.message || e}`);
      return null;
    }
  };
  
  // Try all instances in parallel, return first success
  const results = await Promise.all(instances.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`✓ Got URL from Piped (stable proxied URL)`);
    return validUrl;
  }
  
  console.log(`  No Piped instance returned a valid URL`);
  return null;
  } catch (e) {
    console.error(`Piped extraction error: ${e.message || e}`);
    return null;
  }
}

async function extractYouTubeDirectUrl(youtubeKey) {
  console.log(`\nExtracting YouTube URL for key: ${youtubeKey}`);
  
  // 1. Try Piped FIRST (most stable - returns proxied URLs that don't expire)
  const pipedUrl = await extractViaPiped(youtubeKey);
  if (pipedUrl) {
    console.log('✓ Got YouTube URL from Piped (stable proxied)');
    return pipedUrl;
  }
  
  // 2. Try Invidious (googlevideo URLs)
  console.log(`Trying ${invidiousInstances.length} Invidious instances as fallback for key: ${youtubeKey}`);
  const invidiousInstances = [
    'https://invidious.fdn.fr',
    'https://invidious.flokinet.to',
    'https://invidious.einfachzocken.eu',
    'https://invidious.slipfox.xyz',
    'https://invidious.private.coffee',
    'https://invidious.baczek.me',
    'https://invidious.jing.rocks',
    'https://invidious.darkness.services',
    'https://invidious.reallyaweso.me',
    'https://invidious.nerdvpn.de',
    'https://invidious.f5.si',
    'https://invidious.privacyredirect.com',
    'https://invidious.kavin.rocks',
  ];
  
  const tryInvidious = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    
    try {
      const response = await fetch(`${instance}/api/v1/videos/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) return null;
      const data = await response.json();
      
      // Quality priority: 4K/2160p > 1440p > 1080p > 720p
      const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
      const getQualityRank = (label) => {
        if (!label) return 999;
        const idx = qualityPriority.findIndex(q => label.includes(q));
        return idx === -1 ? 998 : idx;
      };
      
      // formatStreams has combined video+audio (preferred)
      if (data.formatStreams?.length > 0) {
        const sorted = [...data.formatStreams].sort((a, b) => 
          getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel)
        );
        const stream = sorted.find(s => s.container === 'mp4') || sorted[0];
        if (stream?.url) {
          console.log(`  ✓ Invidious ${instance}: got ${stream.qualityLabel || 'unknown'} ${stream.container || 'video'}`);
          return stream.url;
        }
      }
      
      // adaptiveFormats as fallback
      if (data.adaptiveFormats?.length > 0) {
        const videoFormats = data.adaptiveFormats.filter(s => 
          s.type?.includes('video') || s.mimeType?.startsWith('video/')
        );
        const sorted = videoFormats.sort((a, b) => 
          getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel)
        );
        const adaptive = sorted.find(s => s.container === 'mp4' || s.mimeType?.includes('mp4')) || sorted[0];
        if (adaptive?.url) {
          console.log(`  ✓ Invidious ${instance}: got adaptive ${adaptive.qualityLabel || 'unknown'}`);
          return adaptive.url;
        }
      }
      
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  Invidious ${instance}: error - ${e.message || e}`);
      return null;
    }
  };
  
  const invidiousResults = await Promise.all(invidiousInstances.map(tryInvidious));
  const invidiousUrl = invidiousResults.find(r => r !== null);
  
  if (invidiousUrl) {
    console.log('✓ Got YouTube URL from Invidious');
    return invidiousUrl;
  }
  
  console.log('No YouTube URL found from any extractor');
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

