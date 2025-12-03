import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const TMDB_API_KEY = Deno.env.get('TMDB_API_KEY');
const ITUNES_COUNTRY = Deno.env.get('ITUNES_COUNTRY') || 'us';
const CACHE_DAYS = 30;

const MANIFEST = {
  id: "com.trailer.preview.itunes",
  name: "iTunes Trailer Preview",
  version: "1.0.0",
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
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.8;
  
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
  
  console.log('TMDB find response:', JSON.stringify(findData));
  
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
  
  console.log('TMDB detail response:', JSON.stringify(detail));
  
  const mainTitle = mediaType === 'movie' ? detail.title : detail.name;
  const originalTitle = mediaType === 'movie' ? detail.original_title : detail.original_name;
  const releaseDate = mediaType === 'movie' ? detail.release_date : detail.first_air_date;
  const year = releaseDate ? releaseDate.substring(0, 4) : null;
  
  return {
    tmdbId,
    mediaType,
    mainTitle,
    originalTitle,
    year,
    runtime: detail.runtime
  };
}

// Search iTunes - search without media filter, then filter by kind
async function searchITunes(title: string, type: string) {
  // Don't use media filter - it returns 0 results
  // Instead filter by 'kind' in results
  const params = new URLSearchParams({
    term: title,
    country: ITUNES_COUNTRY,
    limit: '50'
  });
  
  const url = `https://itunes.apple.com/search?${params}`;
  console.log(`iTunes search URL: ${url}`);
  
  const response = await fetch(url);
  const data = await response.json();
  
  console.log(`iTunes returned ${data.resultCount} raw results`);
  
  // Filter by kind based on type
  const results = data.results || [];
  const filtered = results.filter((r: any) => {
    if (type === 'movie') {
      return r.kind === 'feature-movie';
    } else if (type === 'series' || type === 'tv') {
      return r.kind === 'tv-episode' || r.wrapperType === 'collection';
    }
    return false;
  });
  
  console.log(`Filtered to ${filtered.length} ${type} results`);
  return filtered;
}

// Find best matching iTunes result
function findBestMatch(
  results: any[],
  mainTitle: string,
  originalTitle: string | null,
  year: string | null
) {
  if (!results || results.length === 0) return null;
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const result of results) {
    const itunesTitle = result.trackName || result.collectionName || '';
    const itunesYear = result.releaseDate ? result.releaseDate.substring(0, 4) : null;
    
    // Calculate title similarity
    const mainSim = calculateSimilarity(itunesTitle, mainTitle);
    const origSim = originalTitle ? calculateSimilarity(itunesTitle, originalTitle) : 0;
    const titleScore = Math.max(mainSim, origSim);
    
    // Year matching - stricter penalties
    let yearScore = 0.3; // default if no year available
    if (year && itunesYear) {
      const yearDiff = Math.abs(parseInt(year) - parseInt(itunesYear));
      if (yearDiff === 0) yearScore = 1;
      else if (yearDiff === 1) yearScore = 0.8;
      else if (yearDiff <= 3) yearScore = 0.4;
      else yearScore = 0; // Reject if >3 years difference
    }
    
    // Has preview bonus
    const hasPreview = result.previewUrl ? 1 : 0;
    
    // Combined score - year is more important
    const score = (titleScore * 0.4) + (yearScore * 0.4) + (hasPreview * 0.2);
    
    console.log(`iTunes candidate: "${itunesTitle}" (${itunesYear}) - titleScore: ${titleScore.toFixed(2)}, yearScore: ${yearScore.toFixed(2)}, total: ${score.toFixed(2)}, hasPreview: ${hasPreview}`);
    
    // Only consider if has preview and meets minimum score
    if (hasPreview && score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = result;
    }
  }
  
  if (!bestMatch) {
    console.log('No match met minimum score threshold (0.5)');
  }
  
  return bestMatch;
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
  
  // Step A: Get TMDB metadata
  const tmdbData = await getTMDBMetadata(imdbId, type);
  if (!tmdbData) {
    return { found: false };
  }
  
  // Step B: Search iTunes
  const itunesResults = await searchITunes(tmdbData.mainTitle, type);
  
  // Also try with original title if different
  let allResults = [...itunesResults];
  if (tmdbData.originalTitle && tmdbData.originalTitle !== tmdbData.mainTitle) {
    const origResults = await searchITunes(tmdbData.originalTitle, type);
    allResults = [...allResults, ...origResults];
  }
  
  // Find best match
  const bestMatch = findBestMatch(
    allResults,
    tmdbData.mainTitle,
    tmdbData.originalTitle,
    tmdbData.year
  );
  
  if (!bestMatch || !bestMatch.previewUrl) {
    console.log('No suitable iTunes match found');
    
    // Cache negative result to avoid repeated lookups
    await supabase
      .from('itunes_mappings')
      .upsert({
        imdb_id: imdbId,
        track_id: null,
        preview_url: null,
        country: ITUNES_COUNTRY,
        last_checked: new Date().toISOString()
      }, { onConflict: 'imdb_id' });
    
    return { found: false };
  }
  
  // Step C: Extract and cache preview
  const previewUrl = bestMatch.previewUrl;
  const trackId = bestMatch.trackId || bestMatch.collectionId;
  
  console.log(`Found preview: ${previewUrl}`);
  
  // Cache the result
  await supabase
    .from('itunes_mappings')
    .upsert({
      imdb_id: imdbId,
      track_id: trackId,
      preview_url: previewUrl,
      country: ITUNES_COUNTRY,
      last_checked: new Date().toISOString()
    }, { onConflict: 'imdb_id' });
  
  return {
    found: true,
    previewUrl,
    trackId,
    country: ITUNES_COUNTRY
  };
}

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace('/stremio-addon', '');
  
  console.log(`Request: ${req.method} ${path}`);
  
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  // Initialize Supabase client with service role
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  
  try {
    // Health check
    if (path === '/health' || path === '/health.json') {
      return new Response(
        JSON.stringify({ status: 'ok' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Manifest
    if (path === '/manifest.json' || path === '/' || path === '') {
      return new Response(
        JSON.stringify(MANIFEST),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Stream handler: /stream/:type/:id.json
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
        return new Response(
          JSON.stringify({
            streams: [{
              name: "iTunes Preview",
              title: "Trailer / Preview",
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
    
    // Internal resolve API
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
    
    // 404 for unknown routes
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
