import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const TMDB_API_KEY = Deno.env.get('TMDB_API_KEY');
const CACHE_DAYS = 30;
const MIN_SCORE_THRESHOLD = 0.6;

// Country storefronts to try (Pass 3)
const COUNTRY_VARIANTS = ['us', 'gb', 'ca', 'au'];

const MANIFEST = {
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
};

// ============ TITLE NORMALIZATION ============

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(str1: string, str2: string): number {
  const norm1 = normalizeTitle(str1);
  const norm2 = normalizeTitle(str2);
  
  if (norm1 === norm2) return 1.0;
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.85;
  
  // Levenshtein-based similarity
  const longer = norm1.length > norm2.length ? norm1 : norm2;
  const shorter = norm1.length > norm2.length ? norm2 : norm1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];
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

interface TMDBMetadata {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle: string;
  year: number | null;
  runtime: number | null; // in minutes
  altTitles: string[];
  youtubeTrailerKey: string | null;
}

async function getTMDBMetadata(imdbId: string, type: string): Promise<TMDBMetadata | null> {
  console.log(`Fetching TMDB metadata for ${imdbId}, type: ${type}`);
  
  // Step 1: Find by IMDB ID (must be first to get tmdbId)
  const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const findResponse = await fetch(findUrl);
  const findData = await findResponse.json();
  
  let result = null;
  let mediaType: 'movie' | 'tv' = type === 'movie' ? 'movie' : 'tv';
  
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
  
  // Step 2: PARALLEL fetch - detail (with videos) + alternative titles
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
  
  // Extract YouTube trailer key from videos
  let youtubeTrailerKey: string | null = null;
  const videos = detail.videos?.results || [];
  
  // Priority: Official Trailer > Trailer > Teaser
  const trailerPriority = ['Trailer', 'Teaser', 'Clip'];
  for (const priority of trailerPriority) {
    const trailer = videos.find((v: any) => 
      v.site === 'YouTube' && 
      v.type === priority && 
      v.official === true
    );
    if (trailer) {
      youtubeTrailerKey = trailer.key;
      break;
    }
  }
  
  // Fallback: any YouTube video
  if (!youtubeTrailerKey) {
    const anyYouTube = videos.find((v: any) => v.site === 'YouTube');
    if (anyYouTube) {
      youtubeTrailerKey = anyYouTube.key;
    }
  }
  
  // Extract English alt titles (US, GB, CA, AU)
  const altTitlesArray: string[] = [];
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

// ============ ITUNES SEARCH ============

interface ITunesSearchParams {
  term: string;
  country: string;
  type: 'movie' | 'tv';
}

async function searchITunes(params: ITunesSearchParams): Promise<any[]> {
  const { term, country, type } = params;
  
  const trySearch = async (extraParams: Record<string, string>, filterKind: string | null): Promise<any[]> => {
    const queryParams = new URLSearchParams({
      term,
      country,
      limit: '25', // Reduced from 50 for speed
      ...extraParams
    });
    
    const url = `https://itunes.apple.com/search?${queryParams}`;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      const data = await response.json();
      let results = data.results || [];
      
      if (filterKind) {
        results = results.filter((r: any) => r.kind === filterKind);
      }
      
      return results;
    } catch {
      return [];
    }
  };
  
  if (type === 'movie') {
    // Try specific search first, then general
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

// ============ SCORING LOGIC ============

interface ScoreResult {
  score: number;
  item: any;
}

function scoreItem(tmdbMeta: TMDBMetadata, item: any): number {
  let score = 0;
  
  // For TV episodes, match against artistName (show name), not trackName (episode name)
  // For movies, match against trackName
  const nameToMatch = tmdbMeta.mediaType === 'tv' 
    ? (item.artistName || item.collectionName || '') 
    : (item.trackName || item.collectionName || '');
  
  const normNameToMatch = normalizeTitle(nameToMatch);
  const normTitle = normalizeTitle(tmdbMeta.title);
  const normOriginal = normalizeTitle(tmdbMeta.originalTitle);
  const normAltTitles = tmdbMeta.altTitles.map(t => normalizeTitle(t));
  
  // Title match scoring
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
  
  // Year difference scoring
  const itunesYear = item.releaseDate ? parseInt(item.releaseDate.substring(0, 4)) : null;
  if (tmdbMeta.year && itunesYear) {
    const diff = Math.abs(itunesYear - tmdbMeta.year);
    if (tmdbMeta.mediaType === 'tv') {
      // TV shows are more lenient - they run for years
      if (diff === 0) {
        score += 0.35;
      } else if (diff <= 2) {
        score += 0.25;
      } else if (diff <= 5) {
        score += 0.15;
      } else if (diff <= 10) {
        score += 0.05;
      }
      // Don't penalize TV shows for year differences
    } else {
      // Movies: stricter year matching
      if (diff === 0) {
        score += 0.35;
      } else if (diff === 1) {
        score += 0.2;
      } else if (diff > 2) {
        score -= 0.5;
      }
    }
  }
  
  // Runtime check for movies only
  if (tmdbMeta.mediaType === 'movie' && tmdbMeta.runtime && item.trackTimeMillis) {
    const itunesMinutes = Math.round(item.trackTimeMillis / 60000);
    const runtimeDiff = Math.abs(itunesMinutes - tmdbMeta.runtime);
    if (runtimeDiff <= 5) {
      score += 0.15;
    } else if (runtimeDiff > 15) {
      score -= 0.2;
    }
  }
  
  // Must have previewUrl
  if (!item.previewUrl) {
    score -= 1.0;
  }
  
  return score;
}

function findBestMatch(results: any[], tmdbMeta: TMDBMetadata): ScoreResult | null {
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

// ============ YOUTUBE EXTRACTORS ============
// Priority: 1. Piped (proxied stable URLs), 2. Invidious (via our proxy), 3. Cobalt (redirect only, skip tunnel)

// Fallback Invidious instances (used if dynamic fetch fails)
const INVIDIOUS_FALLBACK_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.f5.si',
  'https://inv.perditum.com',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://iv.nboeck.de',
  'https://invidious.protokolla.fi',
  'https://invidious.lunar.icu',
  'https://invidious.perennialte.ch',
  'https://invidious.drgns.space',
  'https://invidious.io.lol',
  'https://vid.puffyan.us',
  'https://yt.artemislena.eu',
  'https://invidious.snopyta.org',
  'https://invidious.kavin.rocks',
];

// Piped fallback instances
const PIPED_FALLBACK_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
];

// Cache for dynamic instances
let cachedPipedInstances: string[] | null = null;
let pipedCacheTime = 0;
const PIPED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let cachedInvidiousInstances: string[] | null = null;
let invidiousCacheTime = 0;
const INVIDIOUS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch working Invidious instances dynamically
async function getWorkingInvidiousInstances(): Promise<string[]> {
  // Return cached if still valid
  if (cachedInvidiousInstances && Date.now() - invidiousCacheTime < INVIDIOUS_CACHE_TTL) {
    return cachedInvidiousInstances;
  }
  
  try {
    console.log('Fetching dynamic Invidious instances...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://api.invidious.io/instances.json', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`Invidious instances API returned ${response.status}, using fallback`);
      return INVIDIOUS_FALLBACK_INSTANCES;
    }
    
    const instances = await response.json();
    console.log(`  Invidious API returned ${instances.length} total instances`);
    
    // Filter: api enabled, https, and has a valid URI
    const working = instances
      .filter(([uri, data]: [string, any]) => 
        data.api === true && 
        data.type === 'https' &&
        uri && 
        !uri.includes('.onion') // Skip tor
      )
      .sort(([, a]: [string, any], [, b]: [string, any]) => 
        (b.users?.total || 0) - (a.users?.total || 0) // Sort by user count (popularity)
      )
      .map(([uri]: [string, any]) => `https://${uri}`)
      .slice(0, 20); // Top 20 instances
    
    if (working.length > 0) {
      console.log(`✓ Got ${working.length} dynamic Invidious instances`);
      cachedInvidiousInstances = working;
      invidiousCacheTime = Date.now();
      return working;
    }
    
    console.log('No suitable Invidious instances from API, using fallback');
    return INVIDIOUS_FALLBACK_INSTANCES;
  } catch (e) {
    console.log(`Failed to fetch Invidious instances: ${e instanceof Error ? e.message : 'unknown'}, using fallback`);
    return INVIDIOUS_FALLBACK_INSTANCES;
  }
}

// Fetch working Piped instances dynamically
async function getWorkingPipedInstances(): Promise<string[]> {
  // Return cached if still valid
  if (cachedPipedInstances && Date.now() - pipedCacheTime < PIPED_CACHE_TTL) {
    return cachedPipedInstances;
  }
  
  try {
    console.log('Fetching dynamic Piped instances...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://piped-instances.kavin.rocks/', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`Piped instances API returned ${response.status}, using fallback`);
      return PIPED_FALLBACK_INSTANCES;
    }
    
    const instances = await response.json();
    console.log(`  Piped API returned ${instances.length} total instances`);
    
    // More lenient filtering - accept all with api_url, sort by uptime
    const working = instances
      .filter((i: any) => i.api_url) // Just needs an API URL
      .sort((a: any, b: any) => (b.uptime_24h || 50) - (a.uptime_24h || 50)) // Sort by uptime, default to 50
      .map((i: any) => i.api_url)
      .slice(0, 15); // Top 15 instances
    
    if (working.length > 0) {
      console.log(`✓ Got ${working.length} dynamic Piped instances`);
      cachedPipedInstances = working;
      pipedCacheTime = Date.now();
      return working;
    }
    
    console.log('No suitable Piped instances from API, using fallback');
    return PIPED_FALLBACK_INSTANCES;
  } catch (e) {
    console.log(`Failed to fetch Piped instances: ${e instanceof Error ? e.message : 'unknown'}, using fallback`);
    return PIPED_FALLBACK_INSTANCES;
  }
}

// Cobalt instances (PRIMARY) - muxed audio+video with iOS-compatible codecs
// Fallback list in case dynamic fetch fails
const COBALT_FALLBACK_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://capi.3kh0.net',
  'https://cobalt.api.timelessnesses.me',
  'https://cobalt-backend.canine.tools',
  'https://cobalt-api.meowing.de',
  'https://nuko-c.meowing.de',
  'https://dl.khyernet.xyz',
  'https://cobalt.lostdusty.dev',
];

// Cache for dynamic Cobalt instances
let cachedCobaltInstances: string[] | null = null;
let cobaltCacheTime = 0;
const COBALT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch working Cobalt instances dynamically
async function getWorkingCobaltInstances(): Promise<string[]> {
  // Return cached if still valid
  if (cachedCobaltInstances && Date.now() - cobaltCacheTime < COBALT_CACHE_TTL) {
    return cachedCobaltInstances;
  }
  
  try {
    console.log('Fetching dynamic Cobalt instances...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://instances.cobalt.best/api/instances.json', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`Cobalt instances API returned ${response.status}, using fallback`);
      return COBALT_FALLBACK_INSTANCES;
    }
    
    const instances = await response.json();
    
    // Filter: online, supports YouTube, no auth required, good score
    const working = instances
      .filter((i: any) => 
        i.online === true &&
        i.services?.youtube === true &&
        i.info?.auth !== true &&  // No JWT/auth required
        (i.score || 0) >= 40
      )
      .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
      .map((i: any) => `${i.protocol}://${i.api}`)
      .slice(0, 15); // Top 15 instances
    
    if (working.length > 0) {
      console.log(`✓ Got ${working.length} dynamic Cobalt instances`);
      cachedCobaltInstances = working;
      cobaltCacheTime = Date.now();
      return working;
    }
    
    console.log('No suitable instances from API, using fallback');
    return COBALT_FALLBACK_INSTANCES;
  } catch (e) {
    console.log(`Failed to fetch Cobalt instances: ${e instanceof Error ? e.message : 'unknown'}, using fallback`);
    return COBALT_FALLBACK_INSTANCES;
  }
}

// ============ INVIDIOUS EXTRACTOR ============
// Returns formatStreams with direct googlevideo.com URLs, wrapped in our proxy to bypass IP-binding

async function extractViaInvidious(youtubeKey: string): Promise<string | null> {
  // Fetch dynamic instances first
  const invidiousInstances = await getWorkingInvidiousInstances();
  console.log(`Trying ${invidiousInstances.length} Invidious instances for ${youtubeKey}`);
  
  const baseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  
  const tryInstance = async (instance: string): Promise<string | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    
    try {
      const response = await fetch(`${instance}/api/v1/videos/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) {
        console.log(`  ${instance}: HTTP ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      
      // Quality priority: 4K/2160p > 1440p > 1080p > 720p, HDR preferred
      const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
      
      // Helper to get quality rank (lower is better)
      const getQualityRank = (label: string | undefined): number => {
        if (!label) return 999;
        const idx = qualityPriority.findIndex(q => label.includes(q));
        return idx === -1 ? 998 : idx;
      };
      
      // Helper to check for HDR
      const isHDR = (s: any): boolean => {
        return s.qualityLabel?.toLowerCase().includes('hdr') || 
               s.type?.toLowerCase().includes('hdr') ||
               s.colorInfo?.primaries === 'bt2020';
      };
      
      // formatStreams has combined video+audio (preferred)
      if (data.formatStreams?.length > 0) {
        // Sort by quality (highest first), HDR preferred
        const sorted = [...data.formatStreams].sort((a, b) => {
          // Prefer HDR
          if (isHDR(a) && !isHDR(b)) return -1;
          if (!isHDR(a) && isHDR(b)) return 1;
          // Then by quality
          return getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel);
        });
        
        // Find best MP4 or any container
        const stream = sorted.find((s: any) => s.container === 'mp4') || sorted[0];
        
        if (stream?.url) {
          const hdrLabel = isHDR(stream) ? ' HDR' : '';
          console.log(`  ✓ Invidious ${instance}: got ${stream.qualityLabel || 'unknown'}${hdrLabel} ${stream.container || 'video'}`);
          // Wrap in our proxy to bypass IP-binding issues
          const proxyUrl = `${baseUrl}/functions/v1/stremio-addon/proxy-video?url=${encodeURIComponent(stream.url)}`;
          return proxyUrl;
        }
      }
      
      // adaptiveFormats as fallback (video-only streams, often higher quality)
      if (data.adaptiveFormats?.length > 0) {
        const videoFormats = data.adaptiveFormats.filter((s: any) => 
          s.type?.includes('video') || s.mimeType?.startsWith('video/')
        );
        
        // Sort by quality (highest first), HDR preferred
        const sorted = videoFormats.sort((a: any, b: any) => {
          if (isHDR(a) && !isHDR(b)) return -1;
          if (!isHDR(a) && isHDR(b)) return 1;
          return getQualityRank(a.qualityLabel) - getQualityRank(b.qualityLabel);
        });
        
        // Prefer MP4/H264 for compatibility, but accept highest quality available
        const adaptive = sorted.find((s: any) => s.container === 'mp4' || s.mimeType?.includes('mp4')) || sorted[0];
        
        if (adaptive?.url) {
          const hdrLabel = isHDR(adaptive) ? ' HDR' : '';
          console.log(`  ✓ Invidious ${instance}: got adaptive ${adaptive.qualityLabel || 'unknown'}${hdrLabel}`);
          // Wrap in our proxy to bypass IP-binding issues
          const proxyUrl = `${baseUrl}/functions/v1/stremio-addon/proxy-video?url=${encodeURIComponent(adaptive.url)}`;
          return proxyUrl;
        }
      }
      
      console.log(`  ${instance}: no usable streams in response`);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  ${instance}: error - ${e instanceof Error ? e.message : 'unknown'}`);
      return null;
    }
  };
  
  // Try all instances in parallel
  const results = await Promise.all(invidiousInstances.map(tryInstance));
  const validUrl = results.find((r: string | null) => r !== null);
  
  if (validUrl) {
    console.log(`✓ Got URL from Invidious (proxied)`);
    return validUrl;
  }
  
  console.log(`  No Invidious instance returned a valid URL`);
  return null;
}

// ============ PIPED EXTRACTOR ============
// Returns proxied video URLs via Piped's proxy servers (most stable for playback)

async function extractViaPiped(youtubeKey: string): Promise<string | null> {
  // Fetch dynamic instances first
  const pipedInstances = await getWorkingPipedInstances();
  console.log(`Trying ${pipedInstances.length} Piped instances for ${youtubeKey}`);
  
  const tryInstance = async (instance: string): Promise<string | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    
    try {
      const response = await fetch(`${instance}/streams/${youtubeKey}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) return null;
      const data = await response.json();
      
      // Quality priority: highest first
      const qualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];
      const getQualityRank = (q: string | undefined): number => {
        if (!q) return 999;
        const idx = qualityPriority.findIndex(p => q.includes(p));
        return idx === -1 ? 998 : idx;
      };
      
      if (data.videoStreams?.length > 0) {
        // Sort by quality (highest first)
        const sorted = [...data.videoStreams].sort((a: any, b: any) => 
          getQualityRank(a.quality) - getQualityRank(b.quality)
        );
        
        // Find best combined video+audio stream (preferred for playback)
        const combined = sorted.find((s: any) => 
          !s.videoOnly && s.mimeType?.startsWith('video/')
        );
        
        if (combined?.url) {
          console.log(`  ✓ Piped ${instance}: got ${combined.quality || 'unknown'} (combined)`);
          return combined.url;
        }
        
        // Fall back to video-only (highest quality available)
        const videoOnly = sorted.find((s: any) => s.mimeType?.startsWith('video/'));
        
        if (videoOnly?.url) {
          console.log(`  ✓ Piped ${instance}: got video-only ${videoOnly.quality || 'unknown'}`);
          return videoOnly.url;
        }
      }
      
      return null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  // Try all instances in parallel, return first success
  const results = await Promise.all(pipedInstances.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`✓ Got URL from Piped (stable proxied URL)`);
    return validUrl;
  }
  
  console.log(`  No Piped instance returned a valid URL`);
  return null;
}

// ============ COBALT EXTRACTOR (PRIMARY - iOS COMPATIBLE) ============

interface CobaltResult {
  url: string;
  instance: string;
  status: 'redirect' | 'tunnel' | 'picker';
  codec: string;
}

async function extractViaCobalt(youtubeKey: string): Promise<string | null> {
  // Fetch dynamic instances first
  const cobaltInstances = await getWorkingCobaltInstances();
  console.log(`Trying ${cobaltInstances.length} Cobalt instances for ${youtubeKey}`);
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  
  // Muxing strategies for iOS/browser compatibility
  // CRITICAL: downloadMode: 'auto' ensures video + audio are muxed together
  // youtubeVideoContainer: 'mp4' forces MP4 container for browser compatibility
  // alwaysProxy: false requests DIRECT URLs (redirect) instead of tunnel URLs
  const requestConfigs = [
    // Strategy 1: H.264 4K in MP4 container for maximum browser compatibility
    { 
      url: youtubeUrl, 
      videoQuality: '2160',
      youtubeVideoCodec: 'h264',
      youtubeVideoContainer: 'mp4',
      downloadMode: 'auto',
      audioFormat: 'best',
      alwaysProxy: false,               // CRITICAL: Request direct URLs, not tunnel
      codec: 'h264-4k-mp4'
    },
    
    // Strategy 2: H.264 1080p in MP4 container fallback
    { 
      url: youtubeUrl, 
      videoQuality: '1080',
      youtubeVideoCodec: 'h264',
      youtubeVideoContainer: 'mp4',
      downloadMode: 'auto',
      audioFormat: 'best',
      alwaysProxy: false,
      codec: 'h264-1080p-mp4'
    },
    
    // Strategy 3: H.264 720p in MP4 container (most compatible)
    { 
      url: youtubeUrl, 
      videoQuality: '720',
      youtubeVideoCodec: 'h264',
      youtubeVideoContainer: 'mp4',
      downloadMode: 'auto',
      audioFormat: 'best',
      alwaysProxy: false,
      codec: 'h264-720p-mp4'
    },
    
    // Strategy 4: VP9 4K for higher quality (WebM container)
    { 
      url: youtubeUrl, 
      videoQuality: '2160',
      youtubeVideoCodec: 'vp9',
      downloadMode: 'auto',
      audioFormat: 'best',
      alwaysProxy: false,
      codec: 'vp9-4k'
    },
  ];
  
  const tryInstance = async (
    instance: string, 
    config: Record<string, any>
  ): Promise<CobaltResult | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    try {
      // Remove codec from request body (it's just for logging)
      const { codec, ...requestBody } = config;
      
      const response = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'no body');
        // Skip auth-required instances silently (common error)
        if (errorBody.includes('auth.jwt.missing') || errorBody.includes('auth.jwt')) {
          return null;
        }
        console.log(`  Cobalt ${instance}: HTTP ${response.status} - ${errorBody.substring(0, 100)}`);
        return null;
      }
      
      const data = await response.json();
      
      if ((data.status === 'redirect' || data.status === 'tunnel') && data.url) {
        return { url: data.url, instance, status: data.status, codec: config.codec };
      }
      if (data.status === 'picker' && data.picker?.[0]?.url) {
        return { url: data.picker[0].url, instance, status: 'picker', codec: config.codec };
      }
      
      return null;
    } catch (e) {
      clearTimeout(timeout);
      return null;
    }
  };
  
  // Collect ALL results from all configs and instances, then prioritize redirect over tunnel
  const allResults: CobaltResult[] = [];
  
  for (const config of requestConfigs) {
    console.log(`  Trying codec: ${config.codec}, quality: ${config.videoQuality}`);
    
    const results = await Promise.all(
      cobaltInstances.map((instance: string) => tryInstance(instance, config))
    );
    
    // Add valid results to collection
    results.forEach((r: CobaltResult | null) => {
      if (r !== null) {
        allResults.push(r);
      }
    });
    
    // If we got a REDIRECT (direct URL), use it immediately - best for browser playback
    const redirectResult = results.find((r: CobaltResult | null) => r !== null && r.status === 'redirect');
    if (redirectResult) {
      console.log(`  ✓ Cobalt ${redirectResult.instance}: REDIRECT (direct URL), codec: ${redirectResult.codec}`);
      return redirectResult.url;
    }
  }
  
  // SKIP tunnel URLs entirely - they expire too quickly (~30 seconds) causing zero KB errors
  // Only accept redirect (direct) URLs from Cobalt
  const tunnelCount = allResults.filter(r => r.status === 'tunnel').length;
  const pickerCount = allResults.filter(r => r.status === 'picker').length;
  
  if (tunnelCount > 0 || pickerCount > 0) {
    console.log(`  ⚠ Skipping ${tunnelCount} tunnel + ${pickerCount} picker URLs (expire too quickly)`);
  }
  
  console.log(`  No Cobalt instance returned a direct URL`);
  return null;
}

// ============ MAIN YOUTUBE EXTRACTOR ============
// Priority: 1. Piped (stable proxied URLs), 2. Invidious (via our proxy), 3. Cobalt (redirect only)

async function extractYouTubeDirectUrl(youtubeKey: string): Promise<string | null> {
  console.log(`\nExtracting YouTube URL for key: ${youtubeKey}`);
  
  // 1. Try Piped FIRST (most stable - returns proxied URLs that don't expire)
  const pipedUrl = await extractViaPiped(youtubeKey);
  if (pipedUrl) {
    console.log('✓ Got YouTube URL from Piped (stable proxied)');
    return pipedUrl;
  }
  
  // 2. Try Invidious (googlevideo URLs wrapped in our proxy to bypass IP-binding)
  const invidiousUrl = await extractViaInvidious(youtubeKey);
  if (invidiousUrl) {
    console.log('✓ Got YouTube URL from Invidious (proxied)');
    return invidiousUrl;
  }
  
  // 3. Try Cobalt as last resort (only accept redirect/direct URLs, skip tunnel)
  const cobaltUrl = await extractViaCobalt(youtubeKey);
  if (cobaltUrl) {
    console.log('✓ Got YouTube direct URL from Cobalt');
    return cobaltUrl;
  }
  
  console.log('No YouTube URL found from any extractor');
  return null;
}

// ============ MULTI-PASS SEARCH ============

interface SearchResult {
  found: boolean;
  source?: 'itunes' | 'youtube';
  previewUrl?: string;
  trackId?: number;
  country?: string;
  youtubeKey?: string;
}

async function multiPassSearch(tmdbMeta: TMDBMetadata): Promise<SearchResult> {
  const searchType = tmdbMeta.mediaType === 'movie' ? 'movie' : 'tv';
  
  // Collect all titles to try (limit to 3 for speed)
  const titlesToTry: string[] = [tmdbMeta.title];
  
  if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
    titlesToTry.push(tmdbMeta.originalTitle);
  }
  
  // Add only first alt title if different
  const firstAlt = tmdbMeta.altTitles.find(t => !titlesToTry.includes(t));
  if (firstAlt) titlesToTry.push(firstAlt);
  
  console.log(`Titles to try: ${titlesToTry.join(', ')}`);
  
  // Search helper with timeout
  const searchWithCountry = async (title: string, country: string): Promise<{ results: any[]; country: string } | null> => {
    try {
      const results = await searchITunes({ term: title, country, type: searchType });
      return results.length > 0 ? { results, country } : null;
    } catch {
      return null;
    }
  };
  
  // For each title, search ALL countries in parallel
  for (const title of titlesToTry) {
    console.log(`\nSearching all countries in parallel for "${title}"`);
    
    // Launch all country searches simultaneously
    const countrySearches = COUNTRY_VARIANTS.map(country => 
      searchWithCountry(title, country)
    );
    
    const allResults = await Promise.all(countrySearches);
    
    // Find best match across all countries
    let bestOverall: { score: number; item: any; country: string } | null = null;
    
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

// ============ MAIN RESOLVER ============

async function resolvePreview(imdbId: string, type: string, supabase: any): Promise<SearchResult> {
  console.log(`\n========== Resolving ${imdbId} (${type}) ==========`);
  
  // Check cache first
  const { data: cached, error: cacheError } = await supabase
    .from('itunes_mappings')
    .select('*')
    .eq('imdb_id', imdbId)
    .maybeSingle();
  
  if (cacheError) {
    console.error('Cache lookup error:', cacheError);
  }
  
  if (cached) {
    const lastChecked = new Date(cached.last_checked);
    const daysSinceCheck = (Date.now() - lastChecked.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceCheck < CACHE_DAYS) {
      // YouTube cache: has youtube_key but no preview_url (we don't cache URLs, they expire)
      // Resolve fresh each time using the cached key
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
        // If extraction failed, continue to try full resolution
        console.log('Fresh YouTube extraction failed, continuing...');
      }
      // iTunes cache: has preview_url (these don't expire)
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
      // Negative cache: no youtube_key and no preview_url
      if (!cached.youtube_key) {
        console.log('Cache hit: negative cache (no preview found previously)');
        return { found: false };
      }
    }
    console.log('Cache expired, refreshing...');
  }
  
  // Get TMDB metadata
  const tmdbMeta = await getTMDBMetadata(imdbId, type);
  if (!tmdbMeta) {
    return { found: false };
  }
  
  // Try 1: iTunes multi-pass search
  const itunesResult = await multiPassSearch(tmdbMeta);
  
  if (itunesResult.found) {
    // Cache iTunes result
    await supabase
      .from('itunes_mappings')
      .upsert({
        imdb_id: imdbId,
        track_id: itunesResult.trackId,
        preview_url: itunesResult.previewUrl,
        country: itunesResult.country || 'us',
        youtube_key: null,
        last_checked: new Date().toISOString()
      }, { onConflict: 'imdb_id' });
    
    console.log(`✓ Found iTunes preview: ${itunesResult.previewUrl}`);
    return { ...itunesResult, source: 'itunes' };
  }
  
  // Try 2: YouTube fallback via extractors (direct URLs)
  if (tmdbMeta.youtubeTrailerKey) {
    console.log(`\nTrying YouTube extractors for key: ${tmdbMeta.youtubeTrailerKey}`);
    const youtubeDirectUrl = await extractYouTubeDirectUrl(tmdbMeta.youtubeTrailerKey);
    
    if (youtubeDirectUrl) {
      // Cache only the youtube_key, NOT the URL (tunnel URLs expire quickly)
      // Next time we'll resolve fresh using the cached key
      await supabase
        .from('itunes_mappings')
        .upsert({
          imdb_id: imdbId,
          track_id: null,
          preview_url: null, // Don't cache the URL - it expires
          country: 'yt',
          youtube_key: tmdbMeta.youtubeTrailerKey,
          last_checked: new Date().toISOString()
        }, { onConflict: 'imdb_id' });
      
      console.log(`✓ Got YouTube direct URL (not caching URL, only key)`);
      return {
        found: true,
        source: 'youtube',
        previewUrl: youtubeDirectUrl,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt'
      };
    }
  }
  
  // No result found - cache negative result
  await supabase
    .from('itunes_mappings')
    .upsert({
      imdb_id: imdbId,
      track_id: null,
      preview_url: null,
      country: 'us',
      youtube_key: null,
      last_checked: new Date().toISOString()
    }, { onConflict: 'imdb_id' });
  
  console.log('No preview found from iTunes or YouTube');
  return { found: false };
}

// ============ HTTP SERVER ============

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace('/stremio-addon', '');
  
  console.log(`Request: ${req.method} ${path}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  
  try {
    if (path === '/health' || path === '/health.json') {
      return new Response(
        JSON.stringify({ status: 'ok', version: '2.0.0' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Video proxy endpoint to bypass CORS for tunnel URLs with Range request support
    if (path.startsWith('/proxy-video')) {
      const videoUrl = url.searchParams.get('url');
      if (!videoUrl) {
        return new Response(
          JSON.stringify({ error: 'Missing url parameter' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.log(`Proxying video: ${videoUrl.substring(0, 100)}...`);
      
      try {
        // Build headers for upstream request, forwarding Range if present
        const rangeHeader = req.headers.get('Range');
        const fetchHeaders: Record<string, string> = {
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
        
        const videoResponse = await fetch(videoUrl, { headers: fetchHeaders });
        
        // Handle both 200 (full content) and 206 (partial content) as success
        if (!videoResponse.ok && videoResponse.status !== 206) {
          console.log(`Proxy fetch failed: HTTP ${videoResponse.status}`);
          return new Response(
            JSON.stringify({ error: `Upstream returned ${videoResponse.status}` }),
            { status: videoResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        const contentType = videoResponse.headers.get('Content-Type') || 'video/mp4';
        const contentLength = videoResponse.headers.get('Content-Length');
        const contentRange = videoResponse.headers.get('Content-Range');
        
        const responseHeaders: Record<string, string> = {
          ...corsHeaders,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
        };
        
        if (contentLength) {
          responseHeaders['Content-Length'] = contentLength;
        }
        
        // Forward Content-Range for partial content responses
        if (contentRange) {
          responseHeaders['Content-Range'] = contentRange;
        }
        
        // Use 206 status if we got partial content, otherwise 200
        const responseStatus = videoResponse.status === 206 ? 206 : 200;
        
        console.log(`✓ Proxying video, status: ${responseStatus}, type: ${contentType}, size: ${contentLength || 'chunked'}, range: ${contentRange || 'none'}`);
        
        return new Response(videoResponse.body, {
          status: responseStatus,
          headers: responseHeaders
        });
      } catch (e) {
        console.error('Proxy error:', e);
        return new Response(
          JSON.stringify({ error: 'Failed to proxy video' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }
    
    if (path === '/manifest.json' || path === '/' || path === '') {
      return new Response(
        JSON.stringify(MANIFEST),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const streamMatch = path.match(/^\/stream\/(movie|series)\/([^\/]+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = streamMatch[2];
      
      console.log(`Stream request: type=${type}, id=${id}`);
      
      if (!id.startsWith('tt')) {
        return new Response(
          JSON.stringify({ streams: [] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const result = await resolvePreview(id, type, supabase);
      
      if (result.found && result.previewUrl) {
        const isYouTube = result.source === 'youtube';
        const streamName = isYouTube 
          ? 'Official Trailer' 
          : (type === 'movie' ? 'Movie Preview' : 'Episode Preview');
        const streamTitle = isYouTube 
          ? 'Official Trailer' 
          : `Trailer / Preview (${result.country?.toUpperCase() || 'US'})`;
        
        // For YouTube URLs that might be tunnel URLs (not direct googlevideo.com),
        // wrap them in our proxy to bypass CORS issues
        let finalUrl = result.previewUrl;
        if (isYouTube && !result.previewUrl.includes('googlevideo.com') && !result.previewUrl.includes('video-ssl.itunes.apple.com')) {
          // This is likely a tunnel URL - wrap it in our proxy
          const baseUrl = Deno.env.get('SUPABASE_URL') ?? '';
          const proxyPath = `/functions/v1/stremio-addon/proxy-video?url=${encodeURIComponent(result.previewUrl)}`;
          finalUrl = `${baseUrl}${proxyPath}`;
          console.log(`Wrapping tunnel URL in proxy: ${finalUrl.substring(0, 80)}...`);
        }
        
        return new Response(
          JSON.stringify({
            streams: [{
              name: streamName,
              title: streamTitle,
              url: finalUrl
            }]
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      return new Response(
        JSON.stringify({ streams: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (path === '/resolve' && req.method === 'POST') {
      const body = await req.json();
      const { imdbId, type } = body;
      
      if (!imdbId) {
        return new Response(
          JSON.stringify({ error: 'imdbId is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const result = await resolvePreview(imdbId, type || 'movie', supabase);
      
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (path === '/stats' || path === '/stats.json') {
      // Get all cache entries
      const { data: allEntries, error: allError } = await supabase
        .from('itunes_mappings')
        .select('imdb_id, preview_url, country, last_checked')
        .order('last_checked', { ascending: false });
      
      if (allError) {
        return new Response(
          JSON.stringify({ error: 'Failed to fetch stats' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const entries = allEntries || [];
      const totalEntries = entries.length;
      const hits = entries.filter(e => e.preview_url !== null);
      const misses = entries.filter(e => e.preview_url === null);
      const hitRate = totalEntries > 0 ? ((hits.length / totalEntries) * 100).toFixed(1) : '0.0';
      
      // Count by country
      const countryStats: Record<string, number> = {};
      for (const hit of hits) {
        const country = hit.country || 'us';
        countryStats[country] = (countryStats[country] || 0) + 1;
      }
      
      // Recent misses (titles not found)
      const recentMisses = misses.slice(0, 20).map(m => ({
        imdbId: m.imdb_id,
        lastChecked: m.last_checked
      }));
      
      // Recent hits
      const recentHits = hits.slice(0, 10).map(h => ({
        imdbId: h.imdb_id,
        country: h.country,
        lastChecked: h.last_checked
      }));
      
      const stats = {
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
      };
      
      return new Response(
        JSON.stringify(stats, null, 2),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    return new Response(
      JSON.stringify({ error: 'Not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error: unknown) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
