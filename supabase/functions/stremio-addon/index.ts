import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const TMDB_API_KEY = Deno.env.get('TMDB_API_KEY');
const CACHE_DAYS = 30;

// Storefronts to try in order for maximum coverage
const STOREFRONTS = ['us', 'gb', 'ca', 'au', 'de', 'fr'];

const MANIFEST = {
  id: "com.trailer.preview.itunes",
  name: "iTunes Trailer Preview",
  version: "1.1.0",
  description: "Watch iTunes trailers and previews for movies and TV shows",
  logo: "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/08/53/db/0853db7e-52e6-7f3e-c41e-f62f6a1c8a04/AppIcon-0-0-1x_U007emarketing-0-7-0-85-220.png/200x200bb.png",
  resources: [
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }
  ],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

// Normalize string for comparison
function normalizeString(str: string): string {
  return str.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Calculate similarity between two strings
function calculateSimilarity(str1: string, str2: string): number {
  const norm1 = normalizeString(str1);
  const norm2 = normalizeString(str2);
  
  if (norm1 === norm2) return 1;
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.85;
  
  const words1 = norm1.split(' ');
  const words2 = norm2.split(' ');
  const matchingWords = words1.filter(w => words2.includes(w)).length;
  
  return matchingWords / Math.max(words1.length, words2.length);
}

// Get TMDB metadata
async function getTMDBMetadata(imdbId: string, type: string) {
  console.log(`Fetching TMDB metadata for ${imdbId}, type: ${type}`);
  
  const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const findResponse = await fetch(findUrl);
  const findData = await findResponse.json();
  
  let result = null;
  let mediaType = type;
  
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
  const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const detailResponse = await fetch(detailUrl);
  const detail = await detailResponse.json();
  
  const mainTitle = mediaType === 'movie' ? detail.title : detail.name;
  const originalTitle = mediaType === 'movie' ? detail.original_title : detail.original_name;
  const releaseDate = mediaType === 'movie' ? detail.release_date : detail.first_air_date;
  const year = releaseDate ? releaseDate.substring(0, 4) : null;
  
  console.log(`TMDB: "${mainTitle}" (${year}), type: ${mediaType}`);
  
  return {
    tmdbId,
    mediaType,
    mainTitle,
    originalTitle,
    year,
    runtime: detail.runtime
  };
}

// Search iTunes in a specific storefront
async function searchITunesStorefront(title: string, country: string): Promise<any[]> {
  const params = new URLSearchParams({
    term: title,
    country,
    limit: '100'
  });
  
  const url = `https://itunes.apple.com/search?${params}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error(`iTunes search error for ${country}:`, error);
    return [];
  }
}

// Filter results by type
function filterByType(results: any[], type: string): any[] {
  return results.filter((r: any) => {
    if (type === 'movie') {
      return r.kind === 'feature-movie';
    } else if (type === 'series' || type === 'tv') {
      return r.kind === 'tv-episode';
    }
    return false;
  });
}

// Find best matching iTunes result for movies
function findBestMovieMatch(
  results: any[],
  mainTitle: string,
  originalTitle: string | null,
  year: string | null
): any | null {
  if (!results || results.length === 0) return null;
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const result of results) {
    const itunesTitle = result.trackName || '';
    const itunesYear = result.releaseDate ? result.releaseDate.substring(0, 4) : null;
    
    // Calculate title similarity
    const mainSim = calculateSimilarity(itunesTitle, mainTitle);
    const origSim = originalTitle ? calculateSimilarity(itunesTitle, originalTitle) : 0;
    const titleScore = Math.max(mainSim, origSim);
    
    // Year matching
    let yearScore = 0.5;
    let rejectDueToYear = false;
    if (year && itunesYear) {
      const yearDiff = Math.abs(parseInt(year) - parseInt(itunesYear));
      if (yearDiff === 0) yearScore = 1;
      else if (yearDiff === 1) yearScore = 0.9;
      else if (yearDiff <= 2) yearScore = 0.7;
      else if (yearDiff <= 5) yearScore = 0.4;
      else {
        yearScore = 0;
        rejectDueToYear = true;
      }
    }
    
    const hasPreview = result.previewUrl ? 1 : 0;
    const score = (titleScore * 0.5) + (yearScore * 0.3) + (hasPreview * 0.2);
    
    if (hasPreview && !rejectDueToYear && score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = result;
      console.log(`Movie match: "${itunesTitle}" (${itunesYear}) score=${score.toFixed(2)}`);
    }
  }
  
  return bestMatch;
}

// Find best matching TV show episode
function findBestTVMatch(
  results: any[],
  mainTitle: string,
  originalTitle: string | null,
  year: string | null
): any | null {
  if (!results || results.length === 0) return null;
  
  // Group episodes by show (artistName)
  const showGroups: Map<string, any[]> = new Map();
  
  for (const result of results) {
    const showName = result.artistName || '';
    if (!showGroups.has(showName)) {
      showGroups.set(showName, []);
    }
    showGroups.get(showName)!.push(result);
  }
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const [showName, episodes] of showGroups) {
    // Match against show name (artistName), not episode title
    const mainSim = calculateSimilarity(showName, mainTitle);
    const origSim = originalTitle ? calculateSimilarity(showName, originalTitle) : 0;
    const titleScore = Math.max(mainSim, origSim);
    
    // For TV shows, year matching is more lenient (shows run for years)
    // Use the earliest episode's year for matching
    const earliestEpisode = episodes.reduce((earliest, ep) => {
      const epDate = ep.releaseDate ? new Date(ep.releaseDate) : new Date();
      const earliestDate = earliest.releaseDate ? new Date(earliest.releaseDate) : new Date();
      return epDate < earliestDate ? ep : earliest;
    }, episodes[0]);
    
    const showYear = earliestEpisode.releaseDate ? earliestEpisode.releaseDate.substring(0, 4) : null;
    
    let yearScore = 0.6;
    if (year && showYear) {
      const yearDiff = Math.abs(parseInt(year) - parseInt(showYear));
      if (yearDiff === 0) yearScore = 1;
      else if (yearDiff <= 2) yearScore = 0.9;
      else if (yearDiff <= 5) yearScore = 0.7;
      else if (yearDiff <= 10) yearScore = 0.5;
      else yearScore = 0.3; // Don't reject TV shows based on year - they can run long
    }
    
    // Find episode with preview
    const episodeWithPreview = episodes.find(ep => ep.previewUrl);
    const hasPreview = episodeWithPreview ? 1 : 0;
    
    const score = (titleScore * 0.5) + (yearScore * 0.3) + (hasPreview * 0.2);
    
    if (hasPreview && score > bestScore && titleScore >= 0.6) {
      bestScore = score;
      bestMatch = episodeWithPreview;
      console.log(`TV match: "${showName}" (${showYear}) score=${score.toFixed(2)}`);
    }
  }
  
  return bestMatch;
}

// Search across multiple storefronts
async function searchMultipleStorefronts(
  title: string,
  originalTitle: string | null,
  year: string | null,
  type: string
): Promise<{ result: any | null; country: string }> {
  
  for (const country of STOREFRONTS) {
    console.log(`Searching iTunes ${country.toUpperCase()} for "${title}"`);
    
    // Search with main title
    let rawResults = await searchITunesStorefront(title, country);
    let filtered = filterByType(rawResults, type);
    
    // If no results, try original title
    if (filtered.length === 0 && originalTitle && originalTitle !== title) {
      console.log(`Trying original title: "${originalTitle}"`);
      rawResults = await searchITunesStorefront(originalTitle, country);
      filtered = filterByType(rawResults, type);
    }
    
    // If still no results, try simplified title (first few words)
    if (filtered.length === 0) {
      const simplifiedTitle = title.split(/[:\-–]/)[0].trim();
      if (simplifiedTitle !== title && simplifiedTitle.length >= 3) {
        console.log(`Trying simplified title: "${simplifiedTitle}"`);
        rawResults = await searchITunesStorefront(simplifiedTitle, country);
        filtered = filterByType(rawResults, type);
      }
    }
    
    console.log(`${country.toUpperCase()}: ${filtered.length} ${type} results`);
    
    if (filtered.length > 0) {
      const match = type === 'movie' 
        ? findBestMovieMatch(filtered, title, originalTitle, year)
        : findBestTVMatch(filtered, title, originalTitle, year);
      
      if (match) {
        return { result: match, country };
      }
    }
  }
  
  return { result: null, country: 'us' };
}

// Main resolver function
async function resolvePreview(imdbId: string, type: string, supabase: any) {
  console.log(`Resolving preview for ${imdbId}, type: ${type}`);
  
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
    
    if (daysSinceCheck < CACHE_DAYS && cached.preview_url) {
      console.log('Using cached result');
      return {
        found: true,
        previewUrl: cached.preview_url,
        trackId: cached.track_id,
        country: cached.country
      };
    }
    console.log('Cache expired, refreshing...');
  }
  
  // Get TMDB metadata
  const tmdbData = await getTMDBMetadata(imdbId, type);
  if (!tmdbData) {
    return { found: false };
  }
  
  // Search across storefronts
  const { result: bestMatch, country } = await searchMultipleStorefronts(
    tmdbData.mainTitle,
    tmdbData.originalTitle,
    tmdbData.year,
    type
  );
  
  if (!bestMatch || !bestMatch.previewUrl) {
    console.log('No suitable iTunes match found across all storefronts');
    
    // Cache negative result
    await supabase
      .from('itunes_mappings')
      .upsert({
        imdb_id: imdbId,
        track_id: null,
        preview_url: null,
        country: 'us',
        last_checked: new Date().toISOString()
      }, { onConflict: 'imdb_id' });
    
    return { found: false };
  }
  
  const previewUrl = bestMatch.previewUrl;
  const trackId = bestMatch.trackId || bestMatch.collectionId;
  
  console.log(`Found preview in ${country.toUpperCase()}: ${previewUrl}`);
  
  // Cache the result
  await supabase
    .from('itunes_mappings')
    .upsert({
      imdb_id: imdbId,
      track_id: trackId,
      preview_url: previewUrl,
      country: country,
      last_checked: new Date().toISOString()
    }, { onConflict: 'imdb_id' });
  
  return {
    found: true,
    previewUrl,
    trackId,
    country
  };
}

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
        JSON.stringify({ status: 'ok', storefronts: STOREFRONTS }),
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
        const streamName = type === 'movie' ? 'iTunes Movie Preview' : 'iTunes Episode Preview';
        return new Response(
          JSON.stringify({
            streams: [{
              name: streamName,
              title: `Trailer / Preview (${result.country?.toUpperCase() || 'US'})`,
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
