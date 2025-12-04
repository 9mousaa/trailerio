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

// Country storefronts to try - comprehensive list for maximum coverage
const COUNTRY_VARIANTS = [
  'us', 'gb', 'ca', 'au',  // Primary English markets
  'de', 'fr', 'it', 'es',  // Major European markets
  'nl', 'jp', 'br', 'mx',  // Additional markets with good coverage
  'nz', 'ie', 'at', 'ch'   // Secondary English/European markets
];

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
      limit: '100', // Increased for better coverage
      ...extraParams
    });
    
    const url = `https://itunes.apple.com/search?${queryParams}`;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout for larger results
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      const data = await response.json();
      let results = data.results || [];
      
      if (filterKind) {
        results = results.filter((r: any) => r.kind === filterKind);
      }
      
      // Filter to only include results with previewUrl early
      results = results.filter((r: any) => r.previewUrl);
      
      return results;
    } catch {
      return [];
    }
  };
  
  const allResults: any[] = [];
  
  if (type === 'movie') {
    // Pass 1: Specific movie search with movieTerm attribute
    let results = await trySearch({ media: 'movie', entity: 'movie', attribute: 'movieTerm' }, null);
    if (results.length > 0) allResults.push(...results);
    
    // Pass 2: Movie search without attribute (broader)
    if (allResults.length < 10) {
      results = await trySearch({ media: 'movie', entity: 'movie' }, null);
      for (const r of results) {
        if (!allResults.find(a => a.trackId === r.trackId)) allResults.push(r);
      }
    }
    
    // Pass 3: General search filtered to feature-movie
    if (allResults.length < 10) {
      results = await trySearch({}, 'feature-movie');
      for (const r of results) {
        if (!allResults.find(a => a.trackId === r.trackId)) allResults.push(r);
      }
    }
  } else {
    // TV SHOWS - try multiple entity types for best coverage
    
    // Pass 1: tvSeason - this often has show previews/trailers
    let results = await trySearch({ media: 'tvShow', entity: 'tvSeason', attribute: 'showTerm' }, null);
    if (results.length > 0) allResults.push(...results);
    
    // Pass 2: tvSeason without attribute
    if (allResults.length < 10) {
      results = await trySearch({ media: 'tvShow', entity: 'tvSeason' }, null);
      for (const r of results) {
        const id = r.collectionId || r.trackId;
        if (!allResults.find(a => (a.collectionId || a.trackId) === id)) allResults.push(r);
      }
    }
    
    // Pass 3: tvEpisode - sometimes has episode previews
    if (allResults.length < 10) {
      results = await trySearch({ media: 'tvShow', entity: 'tvEpisode', attribute: 'showTerm' }, null);
      for (const r of results) {
        const id = r.collectionId || r.trackId;
        if (!allResults.find(a => (a.collectionId || a.trackId) === id)) allResults.push(r);
      }
    }
    
    // Pass 4: General tvShow search
    if (allResults.length < 10) {
      results = await trySearch({ media: 'tvShow' }, null);
      for (const r of results) {
        const id = r.collectionId || r.trackId;
        if (!allResults.find(a => (a.collectionId || a.trackId) === id)) allResults.push(r);
      }
    }
  }
  
  console.log(`  iTunes ${country.toUpperCase()}: ${allResults.length} results with previews`);
  return allResults;
}

// ============ SCORING LOGIC ============

interface ScoreResult {
  score: number;
  item: any;
}

function scoreItem(tmdbMeta: TMDBMetadata, item: any): number {
  let score = 0;
  
  // Get all possible names to match from iTunes result
  // For TV: collectionName (season/show name), artistName (network sometimes), trackName (episode)
  // For movies: trackName (movie title), collectionName (sometimes set)
  const namesToCheck: string[] = [];
  
  if (tmdbMeta.mediaType === 'tv') {
    // For TV, prioritize collectionName (show/season name), then artistName
    if (item.collectionName) namesToCheck.push(item.collectionName);
    if (item.artistName) namesToCheck.push(item.artistName);
    if (item.trackName) namesToCheck.push(item.trackName);
  } else {
    // For movies, prioritize trackName
    if (item.trackName) namesToCheck.push(item.trackName);
    if (item.collectionName) namesToCheck.push(item.collectionName);
  }
  
  const normTitle = normalizeTitle(tmdbMeta.title);
  const normOriginal = normalizeTitle(tmdbMeta.originalTitle);
  const normAltTitles = tmdbMeta.altTitles.map(t => normalizeTitle(t));
  
  // Find best title match across all iTunes name fields
  let bestTitleScore = 0;
  for (const name of namesToCheck) {
    const normName = normalizeTitle(name);
    
    if (normName === normTitle) {
      bestTitleScore = Math.max(bestTitleScore, 0.5);
    } else if (normName === normOriginal) {
      bestTitleScore = Math.max(bestTitleScore, 0.45);
    } else if (normAltTitles.includes(normName)) {
      bestTitleScore = Math.max(bestTitleScore, 0.4);
    } else {
      // Check if iTunes name contains the title or vice versa
      if (normName.includes(normTitle) || normTitle.includes(normName)) {
        bestTitleScore = Math.max(bestTitleScore, 0.35);
      } else {
        const fuzzyScore = Math.max(
          fuzzyMatch(name, tmdbMeta.title),
          fuzzyMatch(name, tmdbMeta.originalTitle)
        );
        if (fuzzyScore > 0.85) {
          bestTitleScore = Math.max(bestTitleScore, 0.35);
        } else if (fuzzyScore > 0.7) {
          bestTitleScore = Math.max(bestTitleScore, 0.25);
        } else if (fuzzyScore > 0.6) {
          bestTitleScore = Math.max(bestTitleScore, 0.15);
        }
      }
    }
  }
  score += bestTitleScore;
  
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
  
  // Must have previewUrl (we already filter for this, but safety check)
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
// Priority: 1. Invidious (direct URLs), 2. Piped (proxied URLs), 3. Cobalt (fallback)

// Invidious instances - official list from api.invidious.io + community instances
const INVIDIOUS_INSTANCES = [
  // Official instances with high uptime
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de', 
  'https://invidious.f5.si',
  'https://inv.perditum.com',
  'https://yewtu.be',
  // Community instances
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
  'https://inv.tux.pizza',
  'https://invidious.projectsegfau.lt',
  'https://invidious.privacydev.net',
  'https://invidious.slipfox.xyz',
  'https://iv.ggtyler.dev',
  'https://invidious.einfachzocken.eu',
  'https://invidious.jing.rocks',
  'https://inv.bp.projectsegfau.lt',
];

// Piped instances - comprehensive list from awsmfoss.com
const PIPED_INSTANCES = [
  // High priority - CDN enabled
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api-piped.mha.fi',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.rivo.lol',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.lunar.icu',
  'https://ytapi.dc09.ru',
  'https://pipedapi.colinslegacy.com',
  'https://yapi.vyper.me',
  'https://api.looleh.xyz',
  'https://piped-api.cfe.re',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.nosebs.ru',
  // Additional instances
  'https://pipedapi-libre.kavin.rocks',
  'https://pa.mint.lgbt',
  'https://pa.il.ax',
  'https://piped-api.privacy.com.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
  'https://pipedapi.us.projectsegfau.lt',
  'https://watchapi.whatever.social',
  'https://api.piped.privacydev.net',
  'https://pipedapi.palveluntarjoaja.eu',
  'https://pipedapi.smnz.de',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.qdi.fi',
  'https://piped-api.hostux.net',
  'https://pdapi.vern.cc',
  'https://pipedapi.pfcd.me',
  'https://pipedapi.frontendfriendly.xyz',
  'https://api.piped.yt',
  'https://pipedapi.astartes.nl',
  'https://pipedapi.osphost.fi',
  'https://pipedapi.simpleprivacy.fr',
  'https://pipedapi.drgns.space',
  'https://piapi.ggtyler.dev',
  'https://api.watch.pluto.lat',
];

// Cobalt instances - from instances.cobalt.best (high score instances)
const COBALT_INSTANCES = [
  'https://cobalt-api.meowing.de',      // 96% score
  'https://cobalt-backend.canine.tools', // 92% score
  'https://cobalt-api.kwiatekmiki.com', // 88% score
  'https://kityune.imput.net',          // 76% score (official)
  'https://capi.3kh0.net',              // 76% score
  'https://nachos.imput.net',           // 72% score (official)
  'https://sunny.imput.net',            // 72% score (official)
  'https://blossom.imput.net',          // 64% score (official)
];

// ============ EXTRACTION RESULT ============

interface ExtractionResult {
  url: string;
  quality: string;  // e.g., "1080p", "720p", "4K"
  source: 'inv' | 'pip' | 'cob';  // Shorthand: inv=Invidious, pip=Piped, cob=Cobalt
  hdr: boolean;
}

// ============ INVIDIOUS EXTRACTOR ============
// Returns formatStreams with direct googlevideo.com URLs (if API enabled)

async function extractViaInvidious(youtubeKey: string): Promise<ExtractionResult | null> {
  console.log(`Trying Invidious instances for ${youtubeKey}`);
  
  const tryInstance = async (instance: string): Promise<ExtractionResult | null> => {
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
      const qualityPriority = ['2160p', '4320p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];
      
      // Helper to normalize quality labels (handle 266p, 272p, etc)
      const normalizeQuality = (label: string | undefined): string => {
        if (!label) return '720p';
        // Extract the number part
        const match = label.match(/(\d+)p/);
        if (match) {
          const height = parseInt(match[1]);
          if (height >= 2160) return '2160p';
          if (height >= 1440) return '1440p';
          if (height >= 1080) return '1080p';
          if (height >= 720) return '720p';
          if (height >= 480) return '480p';
          if (height >= 360) return '360p';
          return label;
        }
        return label;
      };
      
      // Helper to get quality rank (lower is better)
      const getQualityRank = (label: string | undefined): number => {
        const normalized = normalizeQuality(label);
        const idx = qualityPriority.findIndex(q => normalized.includes(q));
        return idx === -1 ? 998 : idx;
      };
      
      // Helper to get actual height for sorting
      const getHeight = (label: string | undefined): number => {
        if (!label) return 720;
        const match = label.match(/(\d+)p/);
        return match ? parseInt(match[1]) : 720;
      };
      
      // Helper to check for HDR
      const isHDR = (s: any): boolean => {
        return s.qualityLabel?.toLowerCase().includes('hdr') || 
               s.type?.toLowerCase().includes('hdr') ||
               s.colorInfo?.primaries === 'bt2020';
      };
      
      // Collect ALL available streams from both sources
      const allStreams: Array<{url: string, quality: string, hdr: boolean, rank: number, height: number}> = [];
      
      // adaptiveFormats first - they often have higher quality (4K, HDR)
      if (data.adaptiveFormats?.length > 0) {
        const videoFormats = data.adaptiveFormats.filter((s: any) => 
          s.type?.includes('video') || s.mimeType?.startsWith('video/')
        );
        
        for (const stream of videoFormats) {
          // Accept mp4, webm, and any other video format
          if (stream.url && stream.qualityLabel) {
            allStreams.push({
              url: stream.url,
              quality: stream.qualityLabel,
              hdr: isHDR(stream),
              rank: getQualityRank(stream.qualityLabel),
              height: getHeight(stream.qualityLabel)
            });
          }
        }
      }
      
      // formatStreams has combined video+audio (usually lower quality but playable everywhere)
      if (data.formatStreams?.length > 0) {
        for (const stream of data.formatStreams) {
          if (stream.url) {
            allStreams.push({
              url: stream.url,
              quality: stream.qualityLabel || '720p',
              hdr: isHDR(stream),
              rank: getQualityRank(stream.qualityLabel),
              height: getHeight(stream.qualityLabel)
            });
          }
        }
      }
      
      if (allStreams.length > 0) {
        // Sort: HDR first, then by height (higher is better)
        allStreams.sort((a, b) => {
          // HDR always wins
          if (a.hdr && !b.hdr) return -1;
          if (!a.hdr && b.hdr) return 1;
          // Then highest resolution
          return b.height - a.height;
        });
        
        const best = allStreams[0];
        console.log(`  ✓ Inv ${instance.replace('https://', '').split('/')[0]}: ${best.quality}${best.hdr ? ' HDR' : ''} (${allStreams.length} streams, best height=${best.height})`);
        return { url: best.url, quality: normalizeQuality(best.quality), source: 'inv' as const, hdr: best.hdr };
      }
      
      console.log(`  ${instance.replace('https://', '').split('/')[0]}: no usable streams`);
      return null;
    } catch (e) {
      clearTimeout(timeout);
      console.log(`  ${instance}: error - ${e instanceof Error ? e.message : 'unknown'}`);
      return null;
    }
  };
  
  // Try all instances in parallel
  const results = await Promise.all(INVIDIOUS_INSTANCES.map(tryInstance));
  const validResults = results.filter((r): r is ExtractionResult => r !== null);
  
  if (validResults.length === 0) {
    console.log(`  No Invidious instance returned a valid URL`);
    return null;
  }
  
  // Helper to extract height from quality string
  const getHeight = (q: string): number => {
    const match = q.match(/(\d+)p/);
    return match ? parseInt(match[1]) : 720;
  };
  
  // Sort by quality (higher resolution first, HDR preferred)
  validResults.sort((a, b) => {
    // Prefer HDR
    if (a.hdr && !b.hdr) return -1;
    if (!a.hdr && b.hdr) return 1;
    // Then by height (higher is better)
    return getHeight(b.quality) - getHeight(a.quality);
  });
  
  const best = validResults[0];
  console.log(`✓ Best Invidious: ${best.quality}${best.hdr ? ' HDR' : ''} (from ${validResults.length} results)`);
  return best;
}

// ============ PIPED EXTRACTOR ============
// Returns proxied video URLs via Piped's proxy servers (most stable)

async function extractViaPiped(youtubeKey: string): Promise<ExtractionResult | null> {
  console.log(`Trying Piped instances for ${youtubeKey}`);
  
  // Helper to extract height from quality string
  const getHeight = (q: string | undefined): number => {
    if (!q) return 720;
    const match = q.match(/(\d+)p?/);
    return match ? parseInt(match[1]) : 720;
  };
  
  const tryInstance = async (instance: string): Promise<ExtractionResult | null> => {
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
      
      if (!data.videoStreams?.length) return null;
      
      // Collect ALL video streams
      const allStreams: Array<{url: string, quality: string, height: number}> = [];
      
      for (const stream of data.videoStreams) {
        if (stream.url && stream.mimeType?.startsWith('video/')) {
          const quality = stream.quality || '720p';
          allStreams.push({
            url: stream.url,
            quality,
            height: getHeight(quality)
          });
        }
      }
      
      if (allStreams.length === 0) return null;
      
      // Sort by height (higher is better)
      allStreams.sort((a, b) => b.height - a.height);
      
      const best = allStreams[0];
      const instName = instance.replace('https://', '').split('/')[0];
      console.log(`  ✓ Pip ${instName}: ${best.quality} (${allStreams.length} streams, best height=${best.height})`);
      return { url: best.url, quality: best.quality, source: 'pip', hdr: false };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  // Try all instances in parallel, pick best quality
  const results = await Promise.all(PIPED_INSTANCES.map(tryInstance));
  const validResults = results.filter((r): r is ExtractionResult => r !== null);
  
  if (validResults.length === 0) {
    console.log(`  No Piped instance returned a valid URL`);
    return null;
  }
  
  // Sort by height (higher is better)
  validResults.sort((a, b) => getHeight(b.quality) - getHeight(a.quality));
  
  const best = validResults[0];
  console.log(`✓ Best Piped: ${best.quality} (from ${validResults.length} results)`);
  return best;
}

// ============ COBALT EXTRACTOR (FALLBACK) ============

interface CobaltResult {
  url: string;
  instance: string;
  status: 'redirect' | 'tunnel' | 'picker';
}

async function extractViaCobalt(youtubeKey: string): Promise<ExtractionResult | null> {
  console.log(`Trying Cobalt instances (fallback) for ${youtubeKey}`);
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  
  // Request highest quality: max = 4K/2160p, prefer h264 for compatibility
  const requestConfigs = [
    { url: youtubeUrl, videoQuality: 'max', youtubeVideoCodec: 'h264', downloadMode: 'mute' },
    { url: youtubeUrl, videoQuality: 'max', youtubeVideoCodec: 'h264' },
    { url: youtubeUrl, videoQuality: 'max' }, // Allow VP9/AV1 as fallback for HDR
  ];
  
  const tryInstance = async (
    instance: string, 
    config: Record<string, any>
  ): Promise<CobaltResult | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    try {
      const response = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!response.ok) return null;
      const data = await response.json();
      
      if ((data.status === 'redirect' || data.status === 'tunnel') && data.url) {
        return { url: data.url, instance, status: data.status };
      }
      if (data.status === 'picker' && data.picker?.[0]?.url) {
        return { url: data.picker[0].url, instance, status: 'picker' };
      }
      return null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  };
  
  for (const config of requestConfigs) {
    const results = await Promise.all(
      COBALT_INSTANCES.map(instance => tryInstance(instance, config))
    );
    const valid = results.find(r => r !== null);
    if (valid) {
      console.log(`  ✓ Cobalt ${valid.instance}: got ${valid.status} URL`);
      return { url: valid.url, quality: 'HD', source: 'cob', hdr: false };
    }
  }
  
  console.log(`  No Cobalt instance returned a valid URL`);
  return null;
}

// ============ MAIN YOUTUBE EXTRACTOR ============
// Tries: 1. Invidious (direct URLs), 2. Piped (proxied URLs), 3. Cobalt (fallback)

async function extractYouTubeDirectUrl(youtubeKey: string): Promise<ExtractionResult | null> {
  console.log(`\nExtracting YouTube URL for key: ${youtubeKey}`);
  
  // 1. Try Invidious first (direct googlevideo URLs)
  const invidiousResult = await extractViaInvidious(youtubeKey);
  if (invidiousResult) return invidiousResult;
  
  // 2. Try Piped (proxied URLs)
  const pipedResult = await extractViaPiped(youtubeKey);
  if (pipedResult) return pipedResult;
  
  // 3. Fall back to Cobalt (may return tunnel URLs that expire)
  const cobaltResult = await extractViaCobalt(youtubeKey);
  if (cobaltResult) return cobaltResult;
  
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
  quality?: string;       // e.g., "1080p", "720p", "4K"
  extractorSource?: string; // e.g., "inv", "pip", "cob"
  hdr?: boolean;
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
        const freshResult = await extractYouTubeDirectUrl(cached.youtube_key);
        if (freshResult) {
          return {
            found: true,
            source: 'youtube',
            previewUrl: freshResult.url,
            youtubeKey: cached.youtube_key,
            country: 'yt',
            quality: freshResult.quality,
            extractorSource: freshResult.source,
            hdr: freshResult.hdr
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
    const youtubeResult = await extractYouTubeDirectUrl(tmdbMeta.youtubeTrailerKey);
    
    if (youtubeResult) {
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
        previewUrl: youtubeResult.url,
        youtubeKey: tmdbMeta.youtubeTrailerKey,
        country: 'yt',
        quality: youtubeResult.quality,
        extractorSource: youtubeResult.source,
        hdr: youtubeResult.hdr
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
        
        // Build quality string for YouTube sources
        let qualityStr = '';
        if (isYouTube && result.quality) {
          qualityStr = ` ${result.quality}`;
          if (result.hdr) qualityStr += ' HDR';
        }
        
        // Subtle source indicator for YouTube
        const srcTag = isYouTube && result.extractorSource ? ` ⋅${result.extractorSource}` : '';
        
        const streamName = isYouTube 
          ? `Trailer${qualityStr}` 
          : (type === 'movie' ? 'Movie Preview' : 'Episode Preview');
        const streamTitle = isYouTube 
          ? `Official Trailer${qualityStr}${srcTag}` 
          : `Trailer / Preview (${result.country?.toUpperCase() || 'US'})`;
        
        return new Response(
          JSON.stringify({
            streams: [{
              name: streamTitle,
              title: streamName,
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
