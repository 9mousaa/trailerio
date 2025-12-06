const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];
const YT_DLP_TIMEOUT = 4000;
const STREAM_TIMEOUT = 15000;

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


async function extractViaYtDlp(youtubeKey) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  console.log(`Trying yt-dlp directly for ${youtubeKey}...`);
  
  try {
    // Try highest quality FIRST - single request for best available
    // This is fastest - one request instead of multiple
    try {
      // Get best quality (up to 4K) with combined video+audio, prefer MP4
      const { stdout } = await Promise.race([
        execAsync(`yt-dlp -f "bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160][ext=mp4]/best[height<=2160]/best" -g --no-warnings --no-playlist "${youtubeUrl}"`, {
          timeout: 5000 // Fast timeout - 5 seconds
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
      
      const url = stdout.trim();
      if (url && url.startsWith('http')) {
        console.log(`  ✓ yt-dlp: got highest quality URL`);
        return url;
      }
    } catch (e) {
      // Fallback to simpler format if first fails
      try {
        const { stdout } = await Promise.race([
          execAsync(`yt-dlp -f "best" -g --no-warnings --no-playlist "${youtubeUrl}"`, {
            timeout: 5000
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        
        const url = stdout.trim();
        if (url && url.startsWith('http')) {
          console.log(`  ✓ yt-dlp: got URL (fallback)`);
          return url;
        }
      } catch (e2) {
        // Ignore
      }
    }
    
    console.log(`  yt-dlp: failed to extract URL`);
    return null;
  } catch (e) {
    console.log(`  yt-dlp error: ${e.message || e}`);
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
      
      if (data.videoStreams?.length > 0) {
        const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
        const getQualityRank = (q) => {
          if (!q) return 999;
          const idx = qualityPriority.findIndex(p => q.includes(p));
          return idx === -1 ? 998 : idx;
        };
        
        const sorted = [...data.videoStreams]
          .filter(s => s.mimeType?.startsWith('video/') && s.url)
          .sort((a, b) => getQualityRank(a.quality) - getQualityRank(b.quality));
        
        const combinedStreams = sorted.filter(s => !s.videoOnly);
        if (combinedStreams.length > 0) {
          const best = combinedStreams[0];
          console.log(`  ✓ [Piped] ${instance}: got ${best.quality || 'unknown'}`);
          return best.url;
        }
        
        if (sorted.length > 0) {
          const best = sorted[0];
          console.log(`  ✓ [Piped] ${instance}: got ${best.quality || 'unknown'} (video-only)`);
          return best.url;
        }
      }
      
      return null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  const results = await Promise.all(PIPED_INSTANCES.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`  ✓ [Piped] Got URL from Piped`);
    return validUrl;
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
    const timeout = setTimeout(() => controller.abort(), 4000);
    
    try {
      const response = await fetch(`${instance}/api/v1/videos/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) return null;
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
      
      return null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  const results = await Promise.all(INVIDIOUS_INSTANCES.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`  ✓ [Invidious] Got URL from Invidious`);
    return validUrl;
  }
  
  return null;
}

async function extractYouTubeDirectUrl(youtubeKey) {
  console.log(`\n========== Extracting YouTube URL for key: ${youtubeKey} ==========`);
  
  // PRIORITY 1: yt-dlp directly (fastest, highest quality, no external dependencies)
  // Try with short timeout - if it fails quickly, try fallbacks in parallel
  const ytdlpPromise = extractViaYtDlp(youtubeKey);
  
  // Start fallbacks in parallel (but yt-dlp should succeed first)
  const fallbackPromises = Promise.all([
    extractViaPiped(youtubeKey),
    extractViaInvidious(youtubeKey)
  ]);
  
  // Wait for yt-dlp first (fastest)
  const ytdlpUrl = await ytdlpPromise;
  if (ytdlpUrl) {
    console.log('✓ Got YouTube URL from yt-dlp (direct, highest quality)');
    return ytdlpUrl;
  }
  
  // If yt-dlp failed, check fallbacks
  const [pipedUrl, invidiousUrl] = await fallbackPromises;
  if (pipedUrl) {
    console.log('✓ Got YouTube URL from Piped (stable proxied)');
    return pipedUrl;
  }
  if (invidiousUrl) {
    console.log('✓ Got YouTube URL from Invidious');
    return invidiousUrl;
  }
  
  console.log('No YouTube URL found from any extractor');
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
  
  if (tmdbMeta.youtubeTrailerKey) {
    console.log(`\n========== Extracting YouTube trailer (fastest, highest quality) ==========`);
    console.log(`YouTube key: ${tmdbMeta.youtubeTrailerKey}`);
    const youtubeDirectUrl = await extractYouTubeDirectUrl(tmdbMeta.youtubeTrailerKey);
    
    if (youtubeDirectUrl) {
      setCache(imdbId, {
        track_id: null,
        preview_url: null,
        country: 'yt',
        youtube_key: tmdbMeta.youtubeTrailerKey
      });
      
      console.log(`✓ Got YouTube direct URL (not caching URL, only key)`);
      return {
        found: true,
        source: 'youtube',
        previewUrl: youtubeDirectUrl,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt'
      };
    }
    
    // If YouTube extraction failed (bot detection), fallback to iTunes
    console.log('\n========== YouTube extraction failed, trying iTunes fallback ==========');
    const itunesResult = await multiPassSearch(tmdbMeta);
    console.log(`iTunes search result: ${itunesResult.found ? 'FOUND' : 'NOT FOUND'}`);
    
    if (itunesResult.found) {
      setCache(imdbId, {
        track_id: itunesResult.trackId,
        preview_url: itunesResult.previewUrl,
        country: itunesResult.country || 'us',
        youtube_key: tmdbMeta.youtubeTrailerKey // Keep the key for future retries
      });
      
      console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
      return { ...itunesResult, source: 'itunes' };
    }
  }
  
  if (!tmdbMeta.youtubeTrailerKey) {
    console.log('\n========== Trying iTunes (no YouTube trailer available) ==========');
    const itunesResult = await multiPassSearch(tmdbMeta);
    console.log(`iTunes search result: ${itunesResult.found ? 'FOUND' : 'NOT FOUND'}`);
    
    if (itunesResult.found) {
      setCache(imdbId, {
        track_id: itunesResult.trackId,
        preview_url: itunesResult.previewUrl,
        country: itunesResult.country || 'us',
        youtube_key: null
      });
      
      console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
      return { ...itunesResult, source: 'itunes' };
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
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
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
    };
    
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
      
      const contentType = headResponse.headers.get('Content-Type') || 'video/mp4';
      const contentLength = headResponse.headers.get('Content-Length');
      const acceptRanges = headResponse.headers.get('Accept-Ranges') || 'bytes';
      
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Content-Type': contentType,
        'Content-Length': contentLength || '0',
        'Accept-Ranges': acceptRanges,
        'Cache-Control': 'public, max-age=3600',
      });
      
      return res.status(headResponse.ok ? 200 : headResponse.status).end();
    }
    
    const videoResponse = await fetch(videoUrl, { headers: fetchHeaders });
    
    // Handle both 200 (full content) and 206 (partial content) as success
    if (!videoResponse.ok && videoResponse.status !== 206) {
      console.log(`Proxy fetch failed: HTTP ${videoResponse.status}`);
      return res.status(videoResponse.status).json({ error: `Upstream returned ${videoResponse.status}` });
    }
    
    // AVPlayer requires explicit video/mp4 Content-Type
    const upstreamContentType = videoResponse.headers.get('Content-Type') || '';
    const contentType = upstreamContentType.includes('video/') 
      ? upstreamContentType 
      : 'video/mp4'; // Default to mp4 for AVPlayer compatibility
    
    const contentLength = videoResponse.headers.get('Content-Length');
    const contentRange = videoResponse.headers.get('Content-Range');
    const acceptRanges = videoResponse.headers.get('Accept-Ranges') || 'bytes';
    
    // Set headers BEFORE piping (critical for AVPlayer)
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
    
    // Forward Content-Range for partial content responses (required for AVPlayer seeking)
    if (contentRange) {
      res.set('Content-Range', contentRange);
    }
    
    // Use 206 status if we got partial content, otherwise 200
    const responseStatus = videoResponse.status === 206 ? 206 : 200;
    res.status(responseStatus);
    
    console.log(`✓ Proxying video, status: ${responseStatus}, type: ${contentType}, size: ${contentLength || 'chunked'}, range: ${contentRange || 'none'}`);
    
    // Stream the video
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
    if (!res.headersSent) {
      timeoutFired = true;
      console.log(`  ⚠️ Request timeout for ${id} after ${STREAM_TIMEOUT / 1000}s`);
      res.json({ streams: [] });
    }
  }, STREAM_TIMEOUT);
  
  try {
    const result = await resolvePreview(id, type);
    clearTimeout(timeout);
    
    // If timeout already fired, don't send another response
    if (timeoutFired || res.headersSent) {
      console.log(`  Response already sent (timeout), skipping...`);
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
    if (isYouTube && result.previewUrl.includes('googlevideo.com') && !result.previewUrl.includes('video-ssl.itunes.apple.com')) {
      const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
      const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
      finalUrl = `${protocol}://${host}/api/proxy-video?url=${encodeURIComponent(result.previewUrl)}`;
      console.log(`Wrapping googlevideo.com URL in proxy: ${finalUrl.substring(0, 80)}...`);
    }
    
    console.log(`  ✓ Returning stream for ${id}: ${finalUrl.substring(0, 80)}...`);
    return res.json({
      streams: [{
        name: streamName,
        title: streamTitle,
        url: finalUrl
      }]
    });
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
