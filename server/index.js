const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];
const STREAM_TIMEOUT = 20000; // 20 seconds - reduced to fail faster

const cache = new Map();
let activeRequests = 0;
let totalRequests = 0;

app.use(cors());
app.use(express.json());

// Request tracking middleware
app.use((req, res, next) => {
  activeRequests++;
  totalRequests++;
  const requestId = totalRequests;
  console.log(`[REQ ${requestId}] ${req.method} ${req.path} - Active: ${activeRequests}`);
  
  res.on('finish', () => {
    activeRequests--;
    console.log(`[REQ ${requestId}] Finished - Active: ${activeRequests}`);
  });
  
  res.on('close', () => {
    activeRequests--;
    console.log(`[REQ ${requestId}] Closed - Active: ${activeRequests}`);
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
        console.log(`  [iTunes] Search failed: HTTP ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      let results = data.results || [];
      
      // Filter by kind if specified
      if (filterKind) {
        results = results.filter(r => r.kind === filterKind);
      }
      
      // CRITICAL: Only return results with previewUrl (trailers/previews)
      // This ensures we only get items that actually have video content
      results = results.filter(r => r.previewUrl && r.previewUrl.trim().length > 0);
      
      return results;
    } catch (e) {
      console.log(`  [iTunes] Search error: ${e.message || 'unknown'}`);
      return [];
    }
  };
  
  if (type === 'movie') {
    // Strategy 1: Regular movie search with movieTerm attribute
    let results = await trySearch({ media: 'movie', entity: 'movie', attribute: 'movieTerm' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} movie results with previews`);
      return results;
    }
    
    // Strategy 2: Movie search without attribute
    results = await trySearch({ media: 'movie', entity: 'movie' }, null);
    if (results.length > 0) {
      console.log(`  [iTunes] Found ${results.length} movie results (no attribute)`);
      return results;
    }
    
    // Strategy 3: Search all movies, filter by kind
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
  'https://pipedapi.kavin.rocks', // Most reliable
  'https://pipedapi.in.projectsegfau.lt',
  'https://api.piped.private.coffee',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.darkness.services',
  // Removed dead instances:
  // - piped-api.garudalinux.org (DNS)
  // - piped-api.lunar.icu (expired cert)
  // - watchapi.whatever.social (cert mismatch)
  // - pipedapi.mha.fi (DNS)
  // - pipedapi.adminforge.de (typo in URL)
];

async function extractViaPiped(youtubeKey) {
  console.log(`  [Piped] Trying ${PIPED_INSTANCES.length} instances for ${youtubeKey}...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout - enough time for Piped to respond
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
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.log(`  [Piped] ${instance}: non-JSON response (${contentType || 'no content-type'}): ${text.substring(0, 100)}`);
        return null;
      }
      
      const data = await response.json();
      console.log(`  [Piped] ${instance}: got response (${duration}ms), has dash: ${!!data.dash}, videoStreams: ${data.videoStreams?.length || 0}`);
      
      // PRIORITY 1: DASH manifest (best for AVPlayer - native support, adaptive streaming, highest quality)
      if (data.dash) {
        console.log(`  ✓ [Piped] ${instance}: got DASH manifest (adaptive quality up to highest available + audio)`);
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
            return { url: bestCombined.url, quality: bestCombined.quality, isDash: false };
          }
          // Fallback to video-only if no combined streams available
          const bestVideoOnly = sorted[0];
          console.log(`  ✓ [Piped] ${instance}: selected ${bestVideoOnly.quality || 'unknown'} (video-only, no combined available)`);
          return { url: bestVideoOnly.url, quality: bestVideoOnly.quality, isDash: false };
        }
      }
      
      return null;
    } catch (e) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const errorType = e.name === 'AbortError' ? 'TIMEOUT' : e.code || 'ERROR';
      console.log(`  [Piped] ${instance}: ${errorType} after ${duration}ms - ${e.message || 'unknown error'}`);
      return null;
    }
  };
  
  const results = await Promise.allSettled(PIPED_INSTANCES.map(tryInstance));
  const successfulResults = results
    .map((r) => r.status === 'fulfilled' && r.value ? r.value : null)
    .filter(r => r !== null);
  
  if (successfulResults.length === 0) {
    console.log(`  ✗ [Piped] All ${PIPED_INSTANCES.length} instances failed or timed out`);
    return null;
  }
  
  console.log(`  ✓ [Piped] ${successfulResults.length}/${PIPED_INSTANCES.length} instances succeeded`);
  
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
    console.log(`  ✓ [Piped] Got URL from Piped (quality: ${sortedResults[0].quality || 'unknown'}, from ${successfulResults.length}/${PIPED_INSTANCES.length} instances)`);
    return sortedResults[0];
  }
  
  return null;
}

// ============ INVIDIOUS EXTRACTOR ============

const INVIDIOUS_INSTANCES = [
  'https://yewtu.be', // Most reliable
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
  // Removed dead instances:
  // - invidious.baczek.me (shutdown message)
  // - invidious.einfachzocken.eu (HTML response)
  // - invidious.nerdvpn.de (timeout)
  // - invidious.jing.rocks (DNS)
  // - invidious.reallyaweso.me (expired cert)
  // - yt.drgnz.club (DNS)
  // - iv.ggtyler.dev (HTML response)
  // - invidious.fdn.fr (DNS)
];

async function extractViaInvidious(youtubeKey) {
  console.log(`  [Invidious] Trying ${INVIDIOUS_INSTANCES.length} instances for ${youtubeKey}...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout - enough time for Invidious to respond
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
        return null;
      }
      
      // Check if response is actually JSON before parsing
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.log(`  [Invidious] ${instance}: non-JSON response (${contentType || 'no content-type'}): ${text.substring(0, 100)}`);
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
          return best.url;
        }
      }
      
      return null;
    } catch (e) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const errorType = e.name === 'AbortError' ? 'TIMEOUT' : e.code || 'ERROR';
      console.log(`  [Invidious] ${instance}: ${errorType} after ${duration}ms - ${e.message || 'unknown error'}`);
      return null;
    }
  };
  
  const results = await Promise.allSettled(INVIDIOUS_INSTANCES.map(tryInstance));
  const validUrl = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)[0];
  
  if (validUrl) {
    console.log(`  ✓ [Invidious] Got URL from Invidious (${results.filter(r => r.status === 'fulfilled' && r.value !== null).length}/${INVIDIOUS_INSTANCES.length} instances succeeded)`);
    return validUrl;
  }
  
  console.log(`  ✗ [Invidious] All ${INVIDIOUS_INSTANCES.length} instances failed or timed out`);
  return null;
}

// ============ INTERNET ARCHIVE EXTRACTOR ============

async function extractViaInternetArchive(tmdbMeta) {
  console.log(`  [Internet Archive] Searching for "${tmdbMeta.title}" (${tmdbMeta.year || ''})...`);
  
  try {
    // Build search queries - use better Internet Archive query syntax
    const titleQuery = tmdbMeta.title.replace(/[^\w\s]/g, ' ').trim().replace(/\s+/g, ' ');
    const yearQuery = tmdbMeta.year ? ` AND year:${tmdbMeta.year}` : '';
    
    // Try multiple search strategies
    const searchQueries = [
      // Strategy 1: Title + year in movie_trailers collection (most specific)
      `collection:movie_trailers AND title:${encodeURIComponent(titleQuery)}${yearQuery}`,
      // Strategy 2: Title in movie_trailers (no year)
      `collection:movie_trailers AND title:${encodeURIComponent(titleQuery)}`,
      // Strategy 3: Title + "trailer" in all collections
      `title:${encodeURIComponent(titleQuery + ' trailer')}${yearQuery}`,
      // Strategy 4: Title + "trailer" (no year)
      `title:${encodeURIComponent(titleQuery + ' trailer')}`,
      // Strategy 5: Original title if different
      tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title
        ? `collection:movie_trailers AND title:${encodeURIComponent(tmdbMeta.originalTitle.replace(/[^\w\s]/g, ' ').trim())}${yearQuery}`
        : null
    ].filter(q => q !== null);
    
    for (const query of searchQueries) {
      // Use advancedsearch API with better field selection
      const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl=identifier,title,description,date,downloads,creator,subject&sort[]=downloads+desc&rows=20&output=json`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const startTime = Date.now();
      
      try {
        const response = await fetch(searchUrl, { signal: controller.signal });
        clearTimeout(timeout);
        const duration = Date.now() - startTime;
        
        if (!response.ok) {
          console.log(`  [Internet Archive] Search failed: HTTP ${response.status} (${duration}ms)`);
          continue;
        }
        
        const data = await response.json();
        const docs = data.response?.docs || [];
        
        console.log(`  [Internet Archive] Query returned ${docs.length} results (${duration}ms)`);
        
        if (docs.length === 0) continue;
        
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
          
          let score = 0;
          
          // Title matching (most important)
          if (normTitle === normSearchTitle) {
            score += 1.0; // Exact match
          } else if (normTitle === normOriginalTitle) {
            score += 0.9; // Exact match with original title
          } else {
            // Fuzzy match
            const titleFuzzy = fuzzyMatch(normTitle, normSearchTitle);
            const originalFuzzy = fuzzyMatch(normTitle, normOriginalTitle);
            const bestFuzzy = Math.max(titleFuzzy, originalFuzzy);
            
            if (bestFuzzy > 0.9) {
              score += 0.8;
            } else if (bestFuzzy > 0.7) {
              score += 0.6;
            } else if (bestFuzzy > 0.5) {
              score += 0.4;
            }
          }
          
          // Check if title contains the movie title (partial match)
          if (normTitle.includes(normSearchTitle) || normSearchTitle.includes(normTitle.split(' trailer')[0])) {
            score += 0.3;
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
        
        // Use threshold for matches (0.6 - balanced between accuracy and coverage)
        if (bestMatch && bestScore >= 0.6) {
          console.log(`  [Internet Archive] Best match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
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
              if (searchTerms.indexOf(searchTerm) === 0) {
                console.log(`  [Internet Archive] Metadata fetch failed: HTTP ${metaResponse.status}`);
              }
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
              
              console.log(`  ✓ [Internet Archive] Found: "${bestMatch.title}" (${bestFile.format || 'video'}, ${Math.round((bestFile.size || 0) / 1024 / 1024)}MB)`);
              return videoUrl;
            } else {
              // Log first few file names for debugging
              const fileNames = files.slice(0, 5).map(f => f.name || 'unnamed').join(', ');
              console.log(`  [Internet Archive] No video files found. Sample files: ${fileNames}${files.length > 5 ? '...' : ''}`);
            }
          } catch (metaError) {
            clearTimeout(metaTimeout);
            console.log(`  [Internet Archive] Metadata fetch error for "${bestMatch.title}": ${metaError.message || 'timeout'}`);
            continue;
          }
        }
      } catch (e) {
        clearTimeout(timeout);
        console.log(`  [Internet Archive] Search error for query "${query.substring(0, 50)}...": ${e.message || 'timeout'}`);
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
      return results.length > 0 ? { results, country } : null;
    } catch {
      return null;
    }
  };
  
  // Search sequentially with delays to avoid rate limiting
  for (const title of titlesToTry) {
    console.log(`\nSearching countries sequentially for "${title}" (to avoid rate limiting)`);
    
    let bestOverall = null;
    
    // Search countries one at a time with delays to avoid rate limiting
    for (const country of COUNTRY_VARIANTS) {
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

function getCached(imdbId) {
  const cached = cache.get(imdbId);
  if (cached) {
    const daysSinceCheck = (Date.now() - cached.timestamp) / (1000 * 60 * 60 * 24);
    if (daysSinceCheck < CACHE_DAYS) {
      return cached;
    }
  }
  return null;
}

function setCache(imdbId, data) {
  cache.set(imdbId, {
    ...data,
    timestamp: Date.now()
  });
}

async function resolvePreview(imdbId, type) {
  console.log(`\n========== Resolving ${imdbId} (${type}) ==========`);
  
  const cached = getCached(imdbId);
  
  if (cached) {
    if (cached.preview_url) {
      console.log('Cache hit: returning cached iTunes preview');
      return {
        found: true,
        source: 'itunes',
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
  
  // PRIORITY 1: Try iTunes first (most reliable, works directly in AVPlayer)
  console.log('\n========== Trying iTunes first (most reliable) ==========');
  const itunesResult = await multiPassSearch(tmdbMeta);
  console.log(`iTunes search result: ${itunesResult.found ? 'FOUND' : 'NOT FOUND'}`);
  
  if (itunesResult.found) {
    setCache(imdbId, {
      track_id: itunesResult.trackId,
      preview_url: itunesResult.previewUrl,
      country: itunesResult.country || 'us',
      youtube_key: tmdbMeta.youtubeTrailerKey || null
    });
    console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
    return { ...itunesResult, source: 'itunes' };
  }
  
  // PRIORITY 2: Try public instances (Piped/Invidious)
  if (tmdbMeta.youtubeTrailerKey) {
    console.log('\n========== iTunes not found, trying public instances (Piped/Invidious) ==========');
    console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
    
    const pipedResult = await extractViaPiped(tmdbMeta.youtubeTrailerKey);
    if (pipedResult) {
      setCache(imdbId, {
        track_id: null,
        preview_url: null,
        country: 'yt',
        youtube_key: tmdbMeta.youtubeTrailerKey
      });
      console.log(`✓ Got URL from Piped`);
      const pipedUrl = typeof pipedResult === 'string' ? pipedResult : pipedResult.url;
      return {
        found: true,
        source: 'youtube',
        previewUrl: pipedUrl,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt'
      };
    }
    
    const invidiousUrl = await extractViaInvidious(tmdbMeta.youtubeTrailerKey);
    if (invidiousUrl) {
      setCache(imdbId, {
        track_id: null,
        preview_url: null,
        country: 'yt',
        youtube_key: tmdbMeta.youtubeTrailerKey
      });
      console.log(`✓ Got URL from Invidious`);
      return {
        found: true,
        source: 'youtube',
        previewUrl: invidiousUrl,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt'
      };
    }
  }
  
  // PRIORITY 3: Try Internet Archive as fallback
  console.log('\n========== YouTube not found, trying Internet Archive ==========');
  const archiveUrl = await extractViaInternetArchive(tmdbMeta);
  if (archiveUrl) {
    setCache(imdbId, {
      track_id: null,
      preview_url: archiveUrl,
      country: 'archive',
      youtube_key: tmdbMeta.youtubeTrailerKey || null
    });
    console.log(`✓ Got URL from Internet Archive`);
    return {
      found: true,
      source: 'archive',
      previewUrl: archiveUrl,
      country: 'archive'
    };
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
      setTimeout(() => reject(new Error('Request timeout')), STREAM_TIMEOUT - 1000)
    );
    
    const result = await Promise.race([resolvePromise, timeoutPromise]).catch(err => {
      if (err.message === 'Request timeout') {
        console.log(`  ⚠️ Request timeout for ${id} - aborting`);
        clearTimeout(timeout);
        if (!res.headersSent) {
          res.json({ streams: [] });
        }
        return;
      }
      throw err;
    });
    
    if (!result) return; // Timeout was handled
    
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
