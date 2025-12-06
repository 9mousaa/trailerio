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
// Priority: 1. Cobalt (muxed audio+video, iOS compatible), 2. Invidious (direct URLs), 3. Piped (proxied URLs)

// Invidious instances - try even if api:false (may still work)
const INVIDIOUS_INSTANCES = [
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

// Piped instances - return proxied stream URLs via /streams/:videoId
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
];

// Cobalt instances (PRIMARY) - muxed audio+video with iOS-compatible codecs
const COBALT_INSTANCES = [
  'https://cobalt-backend.canine.tools',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt-api.meowing.de',
  'https://nuko-c.meowing.de',
];

// ============ INVIDIOUS EXTRACTOR ============
// Returns formatStreams with direct googlevideo.com URLs (if API enabled)

async function extractViaInvidious(youtubeKey: string): Promise<string | null> {
  console.log(`Trying Invidious instances for ${youtubeKey}`);
  
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
          return stream.url;
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
          return adaptive.url;
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
  const results = await Promise.all(INVIDIOUS_INSTANCES.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`✓ Got URL from Invidious`);
    return validUrl;
  }
  
  console.log(`  No Invidious instance returned a valid URL`);
  return null;
}

// ============ PIPED EXTRACTOR ============
// Returns proxied video URLs via Piped's proxy servers (most stable)

async function extractViaPiped(youtubeKey: string): Promise<string | null> {
  console.log(`Trying Piped instances for ${youtubeKey}`);
  
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
        
        // Find best combined video+audio stream
        const combined = sorted.find((s: any) => 
          !s.videoOnly && s.mimeType?.startsWith('video/')
        );
        
        if (combined?.url) {
          console.log(`  ✓ Piped ${instance}: got ${combined.quality || 'unknown'}`);
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
  const results = await Promise.all(PIPED_INSTANCES.map(tryInstance));
  const validUrl = results.find(r => r !== null);
  
  if (validUrl) {
    console.log(`✓ Got URL from Piped`);
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
  console.log(`Trying Cobalt instances (primary) for ${youtubeKey}`);
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  
  // Three muxing strategies for iOS compatibility
  // CRITICAL: downloadMode: 'auto' ensures video + audio are muxed together
  const requestConfigs = [
    // Strategy 1: H.264 for maximum iOS/Safari compatibility (muxed video+audio)
    { 
      url: youtubeUrl, 
      videoQuality: 'max',           // Request 4K if available
      youtubeVideoCodec: 'h264',     // H.264/MP4 for iOS compatibility
      downloadMode: 'auto',          // CRITICAL: mux video + audio together
      audioFormat: 'best',           // Keep best audio format
      codec: 'h264'                  // For logging
    },
    
    // Strategy 2: VP9 for higher quality + HDR support (muxed)
    { 
      url: youtubeUrl, 
      videoQuality: 'max',
      youtubeVideoCodec: 'vp9',      // VP9/WebM for 4K/HDR
      downloadMode: 'auto',
      audioFormat: 'best',
      codec: 'vp9'
    },
    
    // Strategy 3: AV1 for best efficiency (muxed)
    { 
      url: youtubeUrl, 
      videoQuality: 'max',
      youtubeVideoCodec: 'av1',      // AV1/WebM for best quality
      downloadMode: 'auto',
      audioFormat: 'best',
      codec: 'av1'
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
        console.log(`  Cobalt ${instance}: HTTP ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      
      if ((data.status === 'redirect' || data.status === 'tunnel') && data.url) {
        return { url: data.url, instance, status: data.status, codec: config.codec };
      }
      if (data.status === 'picker' && data.picker?.[0]?.url) {
        return { url: data.picker[0].url, instance, status: 'picker', codec: config.codec };
      }
      
      console.log(`  Cobalt ${instance}: status=${data.status}, no valid URL`);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  Cobalt ${instance}: error - ${e instanceof Error ? e.message : 'unknown'}`);
      return null;
    }
  };
  
  for (const config of requestConfigs) {
    console.log(`  Trying codec: ${config.codec}, quality: max, muxed: auto`);
    
    const results = await Promise.all(
      COBALT_INSTANCES.map(instance => tryInstance(instance, config))
    );
    const valid = results.find(r => r !== null);
    
    if (valid) {
      console.log(`  ✓ Cobalt ${valid.instance}: ${valid.status} URL, codec: ${valid.codec}, quality: max (muxed audio+video)`);
      return valid.url;
    }
  }
  
  console.log(`  No Cobalt instance returned a valid URL`);
  return null;
}

// ============ MAIN YOUTUBE EXTRACTOR ============
// Priority: 1. Cobalt (best for muxed streams + iOS), 2. Invidious (direct URLs), 3. Piped (proxied URLs)

async function extractYouTubeDirectUrl(youtubeKey: string): Promise<string | null> {
  console.log(`\nExtracting YouTube URL for key: ${youtubeKey}`);
  
  // 1. Try Cobalt FIRST (best for muxed audio+video, iOS compatible)
  const cobaltUrl = await extractViaCobalt(youtubeKey);
  if (cobaltUrl) {
    console.log('✓ Got YouTube direct URL from Cobalt (muxed audio+video)');
    return cobaltUrl;
  }
  
  // 2. Try Invidious (direct googlevideo URLs)
  const invidiousUrl = await extractViaInvidious(youtubeKey);
  if (invidiousUrl) {
    console.log('✓ Got YouTube direct URL from Invidious');
    return invidiousUrl;
  }
  
  // 3. Try Piped (proxied URLs)
  const pipedUrl = await extractViaPiped(youtubeKey);
  if (pipedUrl) {
    console.log('✓ Got YouTube direct URL from Piped');
    return pipedUrl;
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
        
        return new Response(
          JSON.stringify({
            streams: [{
              name: streamName,
              title: streamTitle,
              url: result.previewUrl
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
