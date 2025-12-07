const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];
const YT_DLP_TIMEOUT = 4000;
const STREAM_TIMEOUT = 30000; // 30 seconds - increased for trying multiple Piped instances

// Proxy configuration for yt-dlp
// Manual proxies (comma-separated list for rotation)
const MANUAL_PROXIES = process.env.YT_DLP_PROXIES ? 
  process.env.YT_DLP_PROXIES.split(',').map(p => p.trim()).filter(p => p) : 
  [];

// Free proxy sources (public APIs that provide working proxies)
const FREE_PROXY_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
];

// Cache for free proxies (refreshed periodically)
let cachedFreeProxies = [];
let freeProxyCacheTime = 0;
const FREE_PROXY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_FREE_PROXIES = 20; // Limit to avoid too many

// Combined proxy list (manual + free)
let allProxies = [...MANUAL_PROXIES];
let proxyIndex = 0;

// Fetch and test free proxies (disabled by default - free proxies are unreliable)
async function fetchFreeProxies() {
  // Only use free proxies if explicitly enabled via environment variable
  // Free proxies are unreliable and cause timeouts
  if (process.env.ENABLE_FREE_PROXIES !== 'true') {
    console.log('Free proxies disabled (set ENABLE_FREE_PROXIES=true to enable)');
    return MANUAL_PROXIES;
  }

  // If we have manual proxies, use them only (user preference)
  if (MANUAL_PROXIES.length > 0) {
    return MANUAL_PROXIES;
  }

  // Check cache
  if (cachedFreeProxies.length > 0 && Date.now() - freeProxyCacheTime < FREE_PROXY_CACHE_TTL) {
    return cachedFreeProxies;
  }

  console.log('Fetching free proxies from public APIs...');
  const workingProxies = [];

  // Try each source
  for (const source of FREE_PROXY_SOURCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(source, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      clearTimeout(timeout);

      if (!response.ok) continue;

      const text = await response.text();
      const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

      // Parse proxies (format: ip:port or http://ip:port)
      for (const line of lines.slice(0, 50)) { // Test first 50
        let proxy = line.trim();
        
        // Add http:// if missing
        if (!proxy.startsWith('http://') && !proxy.startsWith('https://') && !proxy.startsWith('socks5://')) {
          proxy = `http://${proxy}`;
        }

        // Quick test (just check if format is valid, actual testing happens on use)
        if (proxy.match(/^https?:\/\/[\d\.]+:\d+$/)) {
          workingProxies.push(proxy);
          if (workingProxies.length >= MAX_FREE_PROXIES) break;
        }
      }

      if (workingProxies.length >= MAX_FREE_PROXIES) break;
    } catch (e) {
      console.log(`  Failed to fetch from ${source}: ${e.message}`);
      continue;
    }
  }

  if (workingProxies.length > 0) {
    console.log(`  ✓ Found ${workingProxies.length} free proxies`);
    cachedFreeProxies = workingProxies;
    freeProxyCacheTime = Date.now();
    allProxies = [...MANUAL_PROXIES, ...workingProxies];
    return workingProxies;
  }

  console.log('  ✗ No free proxies found, using manual proxies only');
  return MANUAL_PROXIES;
}

const cache = new Map();

app.use(cors());
app.use(express.json());

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
  
  const trySearch = async (extraParams, filterKind) => {
    const queryParams = new URLSearchParams({
      term,
      country,
      limit: '25',
      ...extraParams
    });
    
    const url = `https://itunes.apple.com/search?${queryParams}`;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      const data = await response.json();
      let results = data.results || [];
      
      if (filterKind) {
        results = results.filter(r => r.kind === filterKind);
      }
      
      return results;
    } catch {
      return [];
    }
  };
  
  if (type === 'movie') {
    let results = await trySearch({ media: 'movie', entity: 'movie', attribute: 'movieTerm' }, null);
    if (results.length > 0) return results;
    
    results = await trySearch({}, 'feature-movie');
    if (results.length > 0) return results;
  } else {
    let results = await trySearch({ media: 'tvShow', entity: 'tvEpisode', attribute: 'showTerm' }, null);
    if (results.length > 0) return results;
    
    results = await trySearch({ media: 'tvShow' }, 'tv-episode');
    if (results.length > 0) return results;
  }
  
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
  
  if (!item.previewUrl) {
    score -= 1.0;
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

// Track last extraction time to add delays between requests (Piped/Cobalt approach)
let lastYtDlpExtraction = 0;
const MIN_EXTRACTION_INTERVAL = 1500; // 1.5 seconds minimum between extractions (Piped approach)

// Rotate user agents to mimic different browsers (Cobalt/Piped approach)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let userAgentIndex = 0;
function getNextUserAgent() {
  const ua = USER_AGENTS[userAgentIndex];
  userAgentIndex = (userAgentIndex + 1) % USER_AGENTS.length;
  return ua;
}

async function getNextProxy() {
  // Refresh free proxies if needed (async, but don't wait)
  if (MANUAL_PROXIES.length === 0) {
    fetchFreeProxies().catch(() => {}); // Don't block on errors
  }

  if (allProxies.length === 0) {
    // Try to get free proxies synchronously if we have none
    if (cachedFreeProxies.length > 0) {
      allProxies = [...MANUAL_PROXIES, ...cachedFreeProxies];
    }
  }

  if (allProxies.length === 0) return null;
  
  const proxy = allProxies[proxyIndex];
  proxyIndex = (proxyIndex + 1) % allProxies.length;
  return proxy;
}

async function extractViaYtDlp(youtubeKey, retryCount = 0, useProxy = true) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  const proxyStatus = useProxy ? 'with proxy' : 'without proxy';
  console.log(`  [yt-dlp] Extracting highest quality for ${youtubeKey}${retryCount > 0 ? ` (retry ${retryCount}, ${proxyStatus})` : ` (${proxyStatus})`}...`);
  const startTime = Date.now();
  
  // Add delay between requests to mimic human behavior (Piped/Cobalt approach)
  const timeSinceLastExtraction = Date.now() - lastYtDlpExtraction;
  if (timeSinceLastExtraction < MIN_EXTRACTION_INTERVAL) {
    const delay = MIN_EXTRACTION_INTERVAL - timeSinceLastExtraction;
    console.log(`  [yt-dlp] Adding ${delay}ms delay to avoid rate limiting...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  lastYtDlpExtraction = Date.now();
  
  try {
    // Format priority: 4K > 1440p > 1080p > 720p > best (MP4 preferred)
    const formatString = 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160][ext=mp4]+bestaudio/bestvideo[height<=2160]+bestaudio/bestvideo[height<=1440]+bestaudio/bestvideo[height<=1080]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=2160][ext=mp4]/best[height<=1080][ext=mp4]/best[ext=mp4]/best';
    
    // Cobalt/Piped approach: Complete browser headers to mimic real requests
    const userAgent = getNextUserAgent(); // Rotate user agents
    const referer = 'https://www.youtube.com/';
    
    // Complete header set like Piped/Cobalt use (mimics real browser)
    const headers = [
      `User-Agent:${userAgent}`,
      `Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8`,
      `Accept-Language:en-US,en;q=0.9`,
      `Accept-Encoding:gzip, deflate, br`,
      `Referer:${referer}`,
      `Origin:https://www.youtube.com`,
      `DNT:1`,
      `Connection:keep-alive`,
      `Upgrade-Insecure-Requests:1`,
      `Sec-Fetch-Dest:document`,
      `Sec-Fetch-Mode:navigate`,
      `Sec-Fetch-Site:same-origin`,
      `Sec-Fetch-User:?1`
    ];
    
    // Build yt-dlp command with all headers (Cobalt/Piped approach)
    const headerArgs = headers.map(h => `--add-header "${h}"`).join(' ');
    
    // Use mweb client first (most reliable, may not need PO tokens)
    // Fallback to other clients if mweb fails
    const clients = ['mweb', 'tv_embedded', 'web_embedded'];
    const client = clients[retryCount] || 'mweb';
    
    // Try with mweb client first (most compatible, less likely to need PO tokens)
    const extractorArgs = `youtube:player-client=${client}`;
    
    // Only use proxy if enabled and we have manual proxies (free proxies are unreliable)
    let proxy = null;
    let proxyArg = '';
    if (useProxy && MANUAL_PROXIES.length > 0) {
      proxy = await getNextProxy();
      proxyArg = proxy ? `--proxy "${proxy}"` : '';
      if (proxy) {
        console.log(`  [yt-dlp] Using manual proxy: ${proxy.substring(0, 50)}...`);
      }
    }
    
    const { stdout } = await Promise.race([
      execAsync(`yt-dlp -f "${formatString}" -g --no-warnings --no-playlist --no-check-certificate --user-agent "${userAgent}" --referer "${referer}" --extractor-args "${extractorArgs}" ${proxyArg} ${headerArgs} "${youtubeUrl}"`, {
        timeout: YT_DLP_TIMEOUT
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), YT_DLP_TIMEOUT))
    ]);
    
    const url = stdout.trim().split('\n')[0]; // Get first URL (best quality)
    if (url && url.startsWith('http')) {
      const elapsed = Date.now() - startTime;
      console.log(`  ✓ [yt-dlp] Got highest quality URL in ${elapsed}ms`);
      return url;
    }
    
    console.log(`  ✗ [yt-dlp] No valid URL extracted`);
    return null;
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const errorMsg = e.message || e.toString();
    console.log(`  ✗ [yt-dlp] Failed after ${elapsed}ms: ${errorMsg}`);
    
    // If proxy failed, retry without proxy (only if we were using proxy)
    if (useProxy && (errorMsg.includes('Proxy') || errorMsg.includes('Tunnel') || errorMsg.includes('proxy'))) {
      console.log(`  [yt-dlp] Proxy failed, retrying without proxy...`);
      return extractViaYtDlp(youtubeKey, retryCount, false);
    }
    
    // Cobalt/Piped approach: Retry with exponential backoff and different clients
    // Try different YouTube clients (mweb, tv_embedded, web_embedded) to avoid PO token requirements
    if (retryCount < 2 && (
      errorMsg.includes('bot') || 
      errorMsg.includes('Sign in') || 
      errorMsg.includes('Timeout') ||
      errorMsg.includes('Failed to extract') ||
      errorMsg.includes('player response')
    )) {
      const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 3000); // Max 3 seconds
      console.log(`  [yt-dlp] Retrying with different client after ${backoffDelay}ms backoff (attempt ${retryCount + 1}/2)...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      return extractViaYtDlp(youtubeKey, retryCount + 1, useProxy);
    }
    
    return null;
  }
}

// ============ PIPED EXTRACTOR ============

const PIPED_INSTANCES = [
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
  'https://watchapi.whatever.social',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.mha.fi',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
];

async function extractViaPiped(youtubeKey) {
  console.log(`  [Piped] Trying ${PIPED_INSTANCES.length} instances for ${youtubeKey}...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    
    try {
      const response = await fetch(`${instance}/streams/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) return null;
      const data = await response.json();
      
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
          // Check if quality string contains any of our priority resolutions
          const qLower = String(q).toLowerCase();
          const idx = qualityPriority.findIndex(p => qLower.includes(p));
          return idx === -1 ? 998 : idx;
        };
        
        // Log available qualities for debugging
        const availableQualities = data.videoStreams
          .filter(s => s.mimeType?.startsWith('video/') && s.url)
          .map(s => s.quality || 'unknown')
          .join(', ');
        console.log(`  [Piped] ${instance}: available qualities: ${availableQualities || 'none'}`);
        
        const sorted = [...data.videoStreams]
          .filter(s => s.mimeType?.startsWith('video/') && s.url)
          .sort((a, b) => {
            const rankA = getQualityRank(a.quality);
            const rankB = getQualityRank(b.quality);
            // Lower rank = higher quality, so sort ascending
            return rankA - rankB;
          });
        
        // PRIORITY 1: Highest quality (even if video-only + needs muxing)
        // Quality is more important than avoiding muxing
        if (sorted.length > 0) {
          const bestVideo = sorted[0]; // Highest quality video
          
          // Check if there's a matching audio stream for the highest quality video
          if (data.audioStreams?.length > 0) {
            // Find best quality audio stream
            const bestAudio = data.audioStreams
              .filter(s => s.mimeType?.startsWith('audio/') && s.url)
              .sort((a, b) => {
                // Prefer higher bitrate audio
                const bitrateA = a.bitrate || 0;
                const bitrateB = b.bitrate || 0;
                return bitrateB - bitrateA;
              })[0];
            
            if (bestAudio) {
              // Check if there's a combined stream of the same quality
              const combinedOfSameQuality = sorted.find(s => !s.videoOnly && s.quality === bestVideo.quality);
              if (combinedOfSameQuality) {
                // Prefer combined if same quality (no muxing needed)
                console.log(`  ✓ [Piped] ${instance}: selected ${combinedOfSameQuality.quality || 'unknown'} (combined, highest quality)`);
                return { url: combinedOfSameQuality.url, quality: combinedOfSameQuality.quality, isDash: false };
              } else {
                // Use highest quality video-only + audio (will mux)
                console.log(`  ✓ [Piped] ${instance}: selected ${bestVideo.quality || 'unknown'} (video-only) + audio (will mux, highest quality)`);
                return { 
                  url: bestVideo.url, 
                  audioUrl: bestAudio.url,
                  quality: bestVideo.quality, 
                  isDash: false,
                  needsMuxing: true
                };
              }
            }
          }
          
          // Check if highest quality has a combined stream
          const bestCombined = sorted.find(s => !s.videoOnly && s.quality === bestVideo.quality);
          if (bestCombined) {
            console.log(`  ✓ [Piped] ${instance}: selected ${bestCombined.quality || 'unknown'} (combined, highest quality)`);
            return { url: bestCombined.url, quality: bestCombined.quality, isDash: false };
          }
          
          // No audio available, return highest quality video-only as last resort
          console.log(`  ⚠️ [Piped] ${instance}: selected ${bestVideo.quality || 'unknown'} (video-only, no audio available)`);
          return { url: bestVideo.url, quality: bestVideo.quality, isDash: false };
        }
      }
      
      return null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  // Use Promise.allSettled to not fail if some instances timeout
  const results = await Promise.allSettled(PIPED_INSTANCES.map(tryInstance));
  
  // Extract successful results
  const successfulResults = results
    .map((r, idx) => r.status === 'fulfilled' && r.value ? r.value : null)
    .filter(r => r !== null);
  
  if (successfulResults.length === 0) {
    console.log(`  ✗ [Piped] All instances failed or timed out`);
    return null;
  }
  
  // Find best quality result (prefer DASH, then highest quality regardless of muxing)
  let bestResult = null;
  const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
  
  // Sort results: DASH first, then by quality (highest first)
  const sortedResults = successfulResults.sort((a, b) => {
    // DASH is always best
    if (a.isDash && !b.isDash) return -1;
    if (!a.isDash && b.isDash) return 1;
    // Then by quality (highest first) - quality matters more than muxing
    const rankA = qualityPriority.findIndex(p => (a.quality || '').toLowerCase().includes(p));
    const rankB = qualityPriority.findIndex(p => (b.quality || '').toLowerCase().includes(p));
    const qualityDiff = (rankA === -1 ? 999 : rankA) - (rankB === -1 ? 999 : rankB);
    if (qualityDiff !== 0) return qualityDiff;
    // If same quality, prefer combined over muxed (but quality is priority)
    if (!a.needsMuxing && b.needsMuxing) return -1;
    if (a.needsMuxing && !b.needsMuxing) return 1;
    return 0;
  });
  
  // DASH is always best - return immediately
  if (sortedResults.length > 0 && sortedResults[0].isDash) {
    console.log(`  ✓ [Piped] Selected DASH manifest (highest quality available)`);
    return { url: sortedResults[0].url, isDash: true, quality: 'DASH' };
  }
  
  // Return best result (highest quality, even if needs muxing)
  if (sortedResults.length > 0) {
    bestResult = sortedResults[0];
    const muxInfo = bestResult.needsMuxing ? ' (will mux video+audio)' : '';
    console.log(`  ✓ [Piped] Got URL from Piped (quality: ${bestResult.quality || 'unknown'}${muxInfo}, from ${successfulResults.length}/${PIPED_INSTANCES.length} instances)`);
    // Return the result object (not just URL) so we can check for muxing
    return bestResult;
  }
  
  return null;
}

// ============ INVIDIOUS EXTRACTOR ============

const INVIDIOUS_INSTANCES = [
  'https://invidious.fdn.fr',
  'https://iv.ggtyler.dev',
  'https://invidious.einfachzocken.eu',
  'https://invidious.slipfox.xyz',
  'https://inv.zzls.xyz',
  'https://invidious.private.coffee',
  'https://invidious.baczek.me',
  'https://inv.tux.pizza',
  'https://invidious.jing.rocks',
  'https://invidious.darkness.services',
  'https://yt.drgnz.club',
  'https://invidious.reallyaweso.me',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.f5.si',
  'https://inv.perditum.com',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://vid.puffyan.us',
  'https://invidious.kavin.rocks',
];

async function extractViaInvidious(youtubeKey) {
  console.log(`  [Invidious] Trying ${INVIDIOUS_INSTANCES.length} instances for ${youtubeKey}...`);
  
  const tryInstance = async (instance) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout per instance (same as Piped)
    
    try {
      const response = await fetch(`${instance}/api/v1/videos/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) {
        console.log(`  [Invidious] ${instance}: HTTP ${response.status}`);
        return null;
      }
      const data = await response.json();
      
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
      
      if (data.adaptiveFormats?.length > 0) {
        const videoFormats = data.adaptiveFormats.filter(s => 
          s.type?.includes('video') || s.mimeType?.startsWith('video/')
        );
        
        const sorted = videoFormats
          .filter(s => s.container === 'mp4' || s.mimeType?.includes('mp4'))
          .sort((a, b) => getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel));
        
        if (sorted.length > 0) {
          const best = sorted[0];
          console.log(`  ✓ [Invidious] ${instance}: got ${best.qualityLabel || 'unknown'}`);
          return best.url;
        }
      }
      
      console.log(`  [Invidious] ${instance}: no usable streams in response`);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  [Invidious] ${instance}: error - ${e.message || 'unknown'}`);
      return null;
    }
  };
  
  // Use Promise.allSettled to not block if some instances hang (same as Piped)
  const results = await Promise.allSettled(INVIDIOUS_INSTANCES.map(tryInstance));
  const validUrl = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)[0]; // Get first valid URL
  
  if (validUrl) {
    console.log(`  ✓ [Invidious] Got URL from Invidious`);
    return validUrl;
  }
  
  console.log(`  ✗ [Invidious] All instances failed or timed out`);
  return null;
}

async function extractYouTubeDirectUrl(youtubeKey) {
  console.log(`\n========== Extracting YouTube URL for key: ${youtubeKey} ==========`);
  const startTime = Date.now();
  
  // Priority 1: Try yt-dlp first (highest quality)
  const ytdlpUrl = await extractViaYtDlp(youtubeKey);
  if (ytdlpUrl) {
    const elapsed = Date.now() - startTime;
    console.log(`✓ Got YouTube URL from yt-dlp in ${elapsed}ms`);
    return ytdlpUrl;
  }
  
  // Priority 2: Try Piped (stable, good quality)
  console.log(`  yt-dlp failed, trying Piped...`);
  const pipedUrl = await extractViaPiped(youtubeKey);
  if (pipedUrl) {
    const elapsed = Date.now() - startTime;
    console.log(`✓ Got YouTube URL from Piped in ${elapsed}ms`);
    return pipedUrl;
  }
  
  // Priority 3: Try Invidious (fallback)
  console.log(`  Piped failed, trying Invidious...`);
  const invidiousUrl = await extractViaInvidious(youtubeKey);
  if (invidiousUrl) {
    const elapsed = Date.now() - startTime;
    console.log(`✓ Got YouTube URL from Invidious in ${elapsed}ms`);
    return invidiousUrl;
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`✗ Failed to extract YouTube URL from all extractors (took ${elapsed}ms)`);
  return null;
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
  
  for (const title of titlesToTry) {
    console.log(`\nSearching all countries in parallel for "${title}"`);
    
    const countrySearches = COUNTRY_VARIANTS.map(country => 
      searchWithCountry(title, country)
    );
    
    const allResults = await Promise.all(countrySearches);
    
    let bestOverall = null;
    
    for (const result of allResults) {
      if (!result) continue;
      
      const match = findBestMatch(result.results, tmdbMeta);
      if (match && (!bestOverall || match.score > bestOverall.score)) {
        bestOverall = { ...match, country: result.country };
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
    if (cached.youtube_key && !cached.preview_url) {
      console.log(`Cache hit: YouTube key ${cached.youtube_key}, resolving fresh URL...`);
      const freshUrl = await extractYouTubeDirectUrl(cached.youtube_key);
      if (freshUrl) {
        return {
          found: true,
          source: 'youtube',
          previewUrl: freshUrl,
          youtubeKey: cached.youtube_key,
          country: 'yt'
        };
      }
      console.log('Fresh YouTube extraction failed, continuing...');
    }
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
  
  // PRIORITY 2: Try public instances (Piped/Invidious) - more reliable than yt-dlp
  if (tmdbMeta.youtubeTrailerKey) {
    console.log('\n========== iTunes not found, trying public instances (Piped/Invidious) ==========');
    console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
    
    // Try Piped first, then Invidious
    const pipedResult = await extractViaPiped(tmdbMeta.youtubeTrailerKey);
    if (pipedResult) {
      setCache(imdbId, {
        track_id: null,
        preview_url: null,
        country: 'yt',
        youtube_key: tmdbMeta.youtubeTrailerKey
      });
      console.log(`✓ Got URL from Piped`);
      // Handle both string (URL) and object (with muxing info) formats
      const pipedUrl = typeof pipedResult === 'string' ? pipedResult : pipedResult.url;
      return {
        found: true,
        source: 'youtube',
        previewUrl: pipedUrl,
        audioUrl: pipedResult.audioUrl || null,
        needsMuxing: pipedResult.needsMuxing || false,
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
    
    // PRIORITY 3: Try yt-dlp as last resort (often blocked)
    console.log('\n========== Public instances failed, trying yt-dlp (last resort) ==========');
    const ytdlpUrl = await extractViaYtDlp(tmdbMeta.youtubeTrailerKey);
    if (ytdlpUrl) {
      setCache(imdbId, {
        track_id: null,
        preview_url: null,
        country: 'yt',
        youtube_key: tmdbMeta.youtubeTrailerKey
      });
      console.log(`✓ Got URL from yt-dlp`);
      return {
        found: true,
        source: 'youtube',
        previewUrl: ytdlpUrl,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt'
      };
    }
  }
  
  setCache(imdbId, {
    track_id: null,
    preview_url: null,
    country: 'us',
    youtube_key: null
  });
  
  console.log('No preview found from iTunes or YouTube');
  return { found: false };
}

// Initialize free proxies on startup (non-blocking)
fetchFreeProxies().catch(() => {
  console.log('Failed to fetch free proxies on startup, will retry on first use');
});

// Health check endpoint (must be early for load balancer checks)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// Root endpoint for basic connectivity check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'trailerio-backend', version: '2.0.0' });
});

// AVPlayer-compatible video proxy endpoint
app.get('/proxy-video', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  
  console.log(`Proxying video: ${videoUrl.substring(0, 100)}...`);
  
  try {
    // Build headers for upstream request, forwarding Range if present
    const rangeHeader = req.headers.range;
    
    // Detect if this is a Piped/Invidious proxy URL (they need different headers)
    const isPipedProxy = videoUrl.includes('pipedproxy') || videoUrl.includes('pipedapi');
    const isInvidious = videoUrl.includes('invidious') || videoUrl.includes('iv.') || videoUrl.includes('yewtu.be');
    
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    
    // Piped/Invidious proxy URLs don't need YouTube-specific headers
    if (!isPipedProxy && !isInvidious) {
      fetchHeaders['Referer'] = 'https://www.youtube.com/';
      fetchHeaders['Origin'] = 'https://www.youtube.com';
    }
    
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
      console.log(`  Range request: ${rangeHeader}`);
    }
    
    // Handle HEAD requests (AVPlayer often sends HEAD first to check availability)
    if (req.method === 'HEAD') {
      const headResponse = await fetch(videoUrl, { 
        method: 'HEAD',
        headers: fetchHeaders 
      });
      
      // For Piped/Invidious, ensure we get proper Content-Type
      let contentType = headResponse.headers.get('Content-Type') || '';
      if (!contentType.includes('video/')) {
        // If Content-Type is missing or wrong, default to mp4 (most common)
        contentType = 'video/mp4';
      }
      
      const contentLength = headResponse.headers.get('Content-Length');
      const acceptRanges = headResponse.headers.get('Accept-Ranges') || 'bytes';
      
      // Set headers BEFORE sending response (critical for AVPlayer)
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Content-Type': contentType,
        'Accept-Ranges': acceptRanges,
        'Cache-Control': 'public, max-age=3600',
      });
      
      if (contentLength) {
        res.set('Content-Length', contentLength);
      }
      
      return res.status(headResponse.ok ? 200 : headResponse.status).end();
    }
    
    const videoResponse = await fetch(videoUrl, { headers: fetchHeaders });
    
    // Handle both 200 (full content) and 206 (partial content) as success
    if (!videoResponse.ok && videoResponse.status !== 206) {
      console.log(`Proxy fetch failed: HTTP ${videoResponse.status}`);
      if (!res.headersSent) {
        return res.status(videoResponse.status).json({ error: `Upstream returned ${videoResponse.status}` });
      }
      return;
    }
    
    // AVPlayer requires explicit video/mp4 Content-Type
    // Piped/Invidious might return wrong or missing Content-Type
    let upstreamContentType = videoResponse.headers.get('Content-Type') || '';
    
    // If Content-Type is missing or not video, default to mp4 (AVPlayer requirement)
    if (!upstreamContentType.includes('video/')) {
      // Check URL extension as fallback
      if (videoUrl.includes('.m4v') || videoUrl.includes('.mp4')) {
        upstreamContentType = 'video/mp4';
      } else if (videoUrl.includes('.webm')) {
        upstreamContentType = 'video/webm';
      } else {
        upstreamContentType = 'video/mp4'; // Default to mp4 for AVPlayer
      }
      console.log(`  ⚠️ Content-Type missing/wrong, using: ${upstreamContentType}`);
    }
    
    const contentLength = videoResponse.headers.get('Content-Length');
    const contentRange = videoResponse.headers.get('Content-Range');
    const acceptRanges = videoResponse.headers.get('Accept-Ranges') || 'bytes';
    
    // Determine response status - AVPlayer requires 206 for Range requests
    const isRangeRequest = !!rangeHeader;
    const isPartialContent = videoResponse.status === 206;
    const responseStatus = (isRangeRequest || isPartialContent) ? 206 : 200;
    
    // Set headers BEFORE piping (critical for AVPlayer - headers must be set before body)
    // AVPlayer is very strict about header order and presence
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Content-Type': upstreamContentType,
      'Accept-Ranges': acceptRanges,
      'Cache-Control': 'public, max-age=3600',
    });
    
    // Content-Length is required for AVPlayer
    if (contentLength) {
      res.set('Content-Length', contentLength);
    } else if (isRangeRequest && contentRange) {
      // If we have Content-Range, extract length from it (format: "bytes 0-1023/2048")
      const rangeMatch = contentRange.match(/\/(\d+)/);
      if (rangeMatch) {
        res.set('Content-Length', rangeMatch[1]);
      }
    }
    
    // Forward Content-Range for partial content responses (required for AVPlayer seeking)
    if (contentRange) {
      res.set('Content-Range', contentRange);
    }
    
    // Set status BEFORE piping
    res.status(responseStatus);
    
    console.log(`✓ Proxying video, status: ${responseStatus}, type: ${upstreamContentType}, size: ${contentLength || 'chunked'}, range: ${contentRange || 'none'}`);
    
    // Stream the video - pipe directly without buffering (critical for AVPlayer)
    // Don't use res.pipe() - pipe the response body directly
    videoResponse.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy video' });
    }
  }
});

// Handle OPTIONS requests for CORS (AVPlayer may send these)
app.options('/proxy-video', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Max-Age': '86400',
  });
  res.status(204).end();
});

// Mux video + audio endpoint (creates proper MP4 file for AVPlayer compatibility)
// NOTE: This is a last resort - combined streams are preferred for AVPlayer compatibility
app.get('/mux-video', async (req, res) => {
  const videoUrl = req.query.video;
  const audioUrl = req.query.audio;
  
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing video or audio parameter' });
  }
  
  console.log(`Muxing video+audio: ${videoUrl.substring(0, 60)}... + ${audioUrl.substring(0, 60)}...`);
  
  // Set timeout to prevent blocking (60 seconds max for muxing)
  const MUX_TIMEOUT = 60000;
  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    console.log(`  ⚠️ [mux] Timeout after ${MUX_TIMEOUT / 1000}s`);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Muxing timeout' });
    }
  }, MUX_TIMEOUT);
  
  try {
    // Create temporary file for output (AVPlayer needs proper MP4 with moov atom at beginning)
    const tempFile = path.join(os.tmpdir(), `mux-${Date.now()}-${Math.random().toString(36).substring(7)}.mp4`);
    
    // Use ffmpeg to mux video and audio to temp file first, then apply faststart
    // This ensures moov atom is at beginning (required for AVPlayer)
    const ffmpegArgs = [
      '-i', videoUrl,           // Video input (can be URL)
      '-i', audioUrl,           // Audio input (can be URL)
      '-c:v', 'copy',           // Copy video codec (no re-encoding = fast)
      '-c:a', 'aac',            // Encode audio to AAC (AVPlayer compatible)
      '-b:a', '128k',           // Audio bitrate (AVPlayer compatible)
      '-f', 'mp4',              // Output format
      '-movflags', 'faststart', // Put moov atom at beginning (AVPlayer requirement - needs full file first)
      '-preset', 'ultrafast',   // Fast encoding
      '-y',                     // Overwrite output file
      tempFile,                 // Output to temp file
    ];
    
    console.log(`  [mux] Starting ffmpeg muxing to temp file...`);
    const startTime = Date.now();
    
    // Run ffmpeg to create the file
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderrOutput = '';
      
      // Log progress
      ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrOutput += msg;
        // Log progress indicators
        if (msg.includes('time=')) {
          const timeMatch = msg.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (timeMatch) {
            console.log(`  [mux] Progress: ${timeMatch[1]}`);
          }
        }
        // Log errors
        if (msg.includes('error') || msg.includes('Error') || msg.includes('failed')) {
          console.error(`  [ffmpeg] ${msg.substring(0, 200)}`);
        }
      });
      
      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput.substring(0, 500)}`));
        } else {
          resolve();
        }
      });
      
      ffmpeg.on('error', (err) => {
        reject(err);
      });
      
      // Handle timeout
      if (timeoutFired) {
        ffmpeg.kill('SIGTERM');
        reject(new Error('Muxing timeout'));
      }
    });
    
    clearTimeout(timeout);
    
    // Check if file was created
    if (!fs.existsSync(tempFile)) {
      throw new Error('Muxed file was not created');
    }
    
    const fileStats = fs.statSync(tempFile);
    const fileSize = fileStats.size;
    const elapsed = Date.now() - startTime;
    console.log(`  ✓ [mux] Muxing completed in ${elapsed}ms, file size: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
    
    // Handle Range requests (AVPlayer sends these for seeking)
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = fileSize - 1;
    
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      
      if (start >= fileSize || end >= fileSize) {
        res.status(416).set({ 'Content-Range': `bytes */${fileSize}` }).end();
        fs.unlinkSync(tempFile); // Clean up
        return;
      }
    }
    
    const chunkSize = (end - start) + 1;
    
    // Set headers for AVPlayer compatibility
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': chunkSize,
      'Accept-Ranges': 'bytes',
      'Content-Range': rangeHeader ? `bytes ${start}-${end}/${fileSize}` : undefined,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Cache-Control': 'no-cache',
    });
    
    // Set status code (206 for partial content, 200 for full)
    res.status(rangeHeader ? 206 : 200);
    
    // Create read stream and pipe to response
    const fileStream = fs.createReadStream(tempFile, { start, end });
    
    // Clean up temp file after streaming
    fileStream.on('end', () => {
      try {
        fs.unlinkSync(tempFile);
        console.log(`  ✓ [mux] Cleaned up temp file`);
      } catch (e) {
        console.warn(`  ⚠️ [mux] Failed to delete temp file: ${e.message}`);
      }
    });
    
    fileStream.on('error', (err) => {
      console.error(`  ✗ [mux] Stream error: ${err.message}`);
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      fileStream.destroy();
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
    });
    
    fileStream.pipe(res);
    
  } catch (error) {
    clearTimeout(timeout);
    console.error(`  ✗ [mux] Error: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Handle OPTIONS requests for CORS (AVPlayer may send these)
app.options('/mux-video', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.status(204).end();
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
  
  console.log(`\n========== Stream request: type=${type}, id=${id} ==========`);
  
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
    const result = await resolvePreview(id, type);
    clearTimeout(timeout);
    
    // If timeout already fired, don't send another response
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
      
      // Check if we need to mux video + audio
      if (result.needsMuxing && result.audioUrl) {
        const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
        const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
        finalUrl = `${protocol}://${host}/api/mux-video?video=${encodeURIComponent(result.previewUrl)}&audio=${encodeURIComponent(result.audioUrl)}`;
        console.log(`Using mux endpoint to combine video+audio: ${finalUrl.substring(0, 100)}...`);
      } else {
        // DASH manifests (.mpd) work directly in AVPlayer - don't proxy them
        const isDashManifest = result.previewUrl.includes('.mpd') || result.previewUrl.endsWith('/dash');
        
        // Piped/Invidious URLs are already proxied and work directly in AVPlayer - don't proxy them again
        const isPipedProxy = result.previewUrl.includes('pipedproxy') || result.previewUrl.includes('pipedapi');
        const isInvidiousProxy = result.previewUrl.includes('invidious') || result.previewUrl.includes('iv.') || result.previewUrl.includes('yewtu.be');
        
        // Only proxy direct googlevideo.com URLs (from yt-dlp)
        // Piped/Invidious URLs and DASH manifests work directly - don't proxy them
        const needsProxy = isYouTube && !isDashManifest && !isPipedProxy && !isInvidiousProxy &&
          result.previewUrl.includes('googlevideo.com') &&
          !result.previewUrl.includes('video-ssl.itunes.apple.com');
        
        if (needsProxy) {
          const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
          const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
          finalUrl = `${protocol}://${host}/api/proxy-video?url=${encodeURIComponent(result.previewUrl)}`;
          console.log(`Wrapping googlevideo.com URL in proxy: ${finalUrl.substring(0, 80)}...`);
        } else if (isDashManifest) {
          console.log(`Using DASH manifest directly (AVPlayer native support): ${finalUrl.substring(0, 80)}...`);
        } else if (isPipedProxy || isInvidiousProxy) {
          console.log(`Using Piped/Invidious URL directly (already proxied, AVPlayer compatible): ${finalUrl.substring(0, 80)}...`);
        }
      }
      
      console.log(`  ✓ Returning stream for ${id}: ${finalUrl.substring(0, 80)}...`);
      if (!res.headersSent) {
        return res.json({
          streams: [{
            name: streamName,
            title: streamTitle,
            url: finalUrl
          }]
        });
      }
    }
    
    console.log(`  ✗ No preview found for ${id}`);
    if (!res.headersSent) {
      return res.json({ streams: [] });
    }
  } catch (error) {
    clearTimeout(timeout);
    console.error(`  ✗ Error resolving ${id}:`, error.message || error);
    console.error('  Stack:', error.stack);
    if (!res.headersSent && !timeoutFired) {
      res.json({ streams: [] });
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
