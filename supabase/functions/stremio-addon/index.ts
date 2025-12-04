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
  
  // Step 1: Find by IMDB ID
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
  
  // Step 2: Get full details with videos (append_to_response)
  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=videos`;
  const detailResponse = await fetch(detailUrl);
  const detail = await detailResponse.json();
  
  // Step 3: Get alternative titles
  const altTitlesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
  const altTitlesResponse = await fetch(altTitlesUrl);
  const altTitlesData = await altTitlesResponse.json();
  
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
  
  console.log(`TMDB: "${mainTitle}" (${year}), YouTube trailer: ${youtubeTrailerKey || 'none'}`);
  
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
  
  console.log(`TMDB: "${mainTitle}" (${year}), original: "${originalTitle}", altTitles: ${altTitlesArray.length}`);
  
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
  
  // Strategy: Try specific params first, fall back to general search
  // Apple's entity=movie often returns 0 results, so we need fallbacks
  
  const trySearch = async (extraParams: Record<string, string>, filterKind: string | null): Promise<any[]> => {
    const queryParams = new URLSearchParams({
      term,
      country,
      limit: '50',
      ...extraParams
    });
    
    const url = `https://itunes.apple.com/search?${queryParams}`;
    console.log(`iTunes search: ${url}`);
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      let results = data.results || [];
      
      if (filterKind) {
        results = results.filter((r: any) => r.kind === filterKind);
      }
      
      return results;
    } catch (error) {
      console.error(`iTunes search error:`, error);
      return [];
    }
  };
  
  if (type === 'movie') {
    // Strategy 1: Specific movie search (per docs)
    let results = await trySearch({ media: 'movie', entity: 'movie', attribute: 'movieTerm' }, null);
    if (results.length > 0) {
      console.log(`Found ${results.length} movie results using specific search`);
      return results;
    }
    
    // Strategy 2: General search, filter by kind
    results = await trySearch({}, 'feature-movie');
    if (results.length > 0) {
      console.log(`Found ${results.length} movie results using general search`);
      return results;
    }
  } else {
    // Strategy 1: Search for TV episodes (they have previewUrls, seasons don't)
    let results = await trySearch({ media: 'tvShow', entity: 'tvEpisode', attribute: 'showTerm' }, null);
    if (results.length > 0) {
      console.log(`Found ${results.length} TV episode results using specific search`);
      return results;
    }
    
    // Strategy 2: General TV search filtered to episodes
    results = await trySearch({ media: 'tvShow' }, 'tv-episode');
    if (results.length > 0) {
      console.log(`Found ${results.length} TV results using general search`);
      return results;
    }
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

// ============ YOUTUBE EXTRACTORS (COBALT v10/v11 INSTANCES) ============

const COBALT_INSTANCES = [
  // Community instances without turnstile (from cobalt.directory)
  'https://cobalt-backend.canine.tools',    // 96%
  'https://nuko-c.meowing.de',              // 96%
  'https://cobalt-api.clxxped.lol',         // 92%
  'https://subito-c.meowing.de',            // 88%
  'https://cobalt-api.kwiatekmiki.com',     // 80%
];

async function extractYouTubeDirectUrl(youtubeKey: string): Promise<string | null> {
  console.log(`Extracting direct URL for YouTube key: ${youtubeKey}`);
  const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  
  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`Trying Cobalt instance: ${instance}`);
      
      const response = await fetch(instance, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: youtubeUrl,
          videoQuality: '720',
          youtubeVideoCodec: 'h264',
        })
      });
      
      console.log(`${instance} response status: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        console.log(`${instance} error: ${errorText.substring(0, 100)}`);
        continue;
      }
      
      const data = await response.json();
      console.log(`${instance} response status type: ${data.status}`);
      
      if (data.status === 'tunnel' || data.status === 'redirect') {
        if (data.url) {
          console.log(`✓ Got direct URL from ${instance}`);
          return data.url;
        }
      } else if (data.status === 'picker' && data.picker?.length > 0) {
        // Multiple options, pick first video
        const videoOption = data.picker.find((p: any) => p.type === 'video') || data.picker[0];
        if (videoOption?.url) {
          console.log(`✓ Got direct URL from ${instance} (picker)`);
          return videoOption.url;
        }
      } else if (data.status === 'error') {
        console.log(`${instance} error: ${data.error?.code || 'unknown'}`);
      }
    } catch (error) {
      console.error(`${instance} fetch error:`, error);
    }
  }
  
  console.log('All Cobalt instances failed');
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
  
  // Collect all titles to try
  const titlesToTry: string[] = [tmdbMeta.title];
  
  if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
    titlesToTry.push(tmdbMeta.originalTitle);
  }
  
  for (const altTitle of tmdbMeta.altTitles) {
    if (!titlesToTry.includes(altTitle)) {
      titlesToTry.push(altTitle);
    }
  }
  
  console.log(`Titles to try: ${titlesToTry.join(', ')}`);
  
  // Pass 1 & 2: Try all titles in US first
  for (const title of titlesToTry) {
    console.log(`\nPass 1/2: Searching US for "${title}"`);
    const results = await searchITunes({ term: title, country: 'us', type: searchType });
    
    if (results.length > 0) {
      console.log(`Found ${results.length} results in US`);
      const match = findBestMatch(results, tmdbMeta);
      if (match) {
        return {
          found: true,
          previewUrl: match.item.previewUrl,
          trackId: match.item.trackId || match.item.collectionId,
          country: 'us'
        };
      }
    }
  }
  
  // Pass 3: Try main title in other country variants
  for (const country of COUNTRY_VARIANTS) {
    if (country === 'us') continue; // Already tried
    
    for (const title of titlesToTry.slice(0, 2)) { // Only main + original title
      console.log(`\nPass 3: Searching ${country.toUpperCase()} for "${title}"`);
      const results = await searchITunes({ term: title, country, type: searchType });
      
      if (results.length > 0) {
        console.log(`Found ${results.length} results in ${country.toUpperCase()}`);
        const match = findBestMatch(results, tmdbMeta);
        if (match) {
          return {
            found: true,
            previewUrl: match.item.previewUrl,
            trackId: match.item.trackId || match.item.collectionId,
            country
          };
        }
      }
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
      // Check for YouTube cache first (youtube_key without preview_url)
      if (cached.youtube_key && !cached.preview_url) {
        console.log('Cache hit: returning cached YouTube trailer');
        return {
          found: true,
          source: 'youtube',
          youtubeKey: cached.youtube_key,
          country: 'yt'
        };
      }
      if (cached.preview_url) {
        console.log('Cache hit: returning cached preview');
        // Determine source from country
        const isYouTube = cached.country === 'yt' || cached.youtube_key;
        return {
          found: true,
          source: isYouTube ? 'youtube' : 'itunes',
          previewUrl: cached.preview_url,
          trackId: cached.track_id,
          country: cached.country,
          youtubeKey: cached.youtube_key
        };
      } else if (!cached.youtube_key) {
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
      // Cache YouTube result with direct URL
      await supabase
        .from('itunes_mappings')
        .upsert({
          imdb_id: imdbId,
          track_id: null,
          preview_url: youtubeDirectUrl,
          country: 'yt',
          youtube_key: tmdbMeta.youtubeTrailerKey,
          last_checked: new Date().toISOString()
        }, { onConflict: 'imdb_id' });
      
      console.log(`✓ Got YouTube direct URL`);
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
          ? 'YouTube Trailer' 
          : (type === 'movie' ? 'Movie Preview' : 'Episode Preview');
        const streamTitle = isYouTube 
          ? 'Official Trailer (YouTube)' 
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
