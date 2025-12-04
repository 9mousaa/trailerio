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

// ALL country storefronts for maximum coverage - user doesn't mind the wait
const ALL_COUNTRIES = [
  // Tier 1: Primary markets (most content)
  'us', 'gb', 'de', 'au', 'ca', 'fr',
  // Tier 2: Major European markets
  'it', 'es', 'nl', 'be', 'at', 'ch', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'hu', 'ro', 'bg', 'gr', 'pt', 'ie',
  // Tier 3: Asia Pacific
  'jp', 'kr', 'cn', 'hk', 'tw', 'sg', 'my', 'th', 'ph', 'id', 'vn', 'in',
  // Tier 4: Latin America
  'mx', 'br', 'ar', 'cl', 'co', 'pe',
  // Tier 5: EMEA & Other
  'ru', 'tr', 'il', 'ae', 'sa', 'za', 'eg', 'ng', 'ke', 'nz'
];

const MANIFEST = {
  id: "com.trailer.preview",
  name: "Trailer Preview",
  version: "3.0.0",
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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(str1: string, str2: string): number {
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
  runtime: number | null;
  altTitles: string[];
}

async function getTMDBMetadata(imdbId: string, type: string): Promise<TMDBMetadata | null> {
  const mediaType = type === 'series' ? 'tv' : 'movie';
  console.log(`Fetching TMDB metadata for ${imdbId}, type: ${mediaType}`);
  
  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const findResponse = await fetch(findUrl);
    const findData = await findResponse.json();
    
    const results = mediaType === 'movie' ? findData.movie_results : findData.tv_results;
    if (!results || results.length === 0) {
      console.log('TMDB: No results found');
      return null;
    }
    
    const item = results[0];
    const tmdbId = item.id;
    
    // Get detailed info and alt titles in parallel
    const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const altTitlesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
    
    const [detailResponse, altTitlesResponse] = await Promise.all([
      fetch(detailUrl),
      fetch(altTitlesUrl)
    ]);
    
    const detailData = await detailResponse.json();
    const altTitlesData = await altTitlesResponse.json();
    
    const mainTitle = mediaType === 'movie' ? detailData.title : detailData.name;
    const originalTitle = mediaType === 'movie' ? detailData.original_title : detailData.original_name;
    const releaseDate = mediaType === 'movie' ? detailData.release_date : detailData.first_air_date;
    const runtime = mediaType === 'movie' ? detailData.runtime : null;
    
    const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : null;
    
    // Get alternative titles
    const altTitlesArray: string[] = [];
    const titles = mediaType === 'movie' ? altTitlesData.titles : altTitlesData.results;
    if (titles) {
      for (const t of titles) {
        const title = t.title || t.name;
        if (title && !altTitlesArray.includes(title)) {
          altTitlesArray.push(title);
        }
      }
    }
    
    console.log(`TMDB: "${mainTitle}" (${year}), altTitles: ${altTitlesArray.length}`);
    
    return {
      tmdbId,
      mediaType,
      title: mainTitle,
      originalTitle: originalTitle || mainTitle,
      year,
      runtime,
      altTitles: altTitlesArray
    };
  } catch (error) {
    console.error('TMDB error:', error);
    return null;
  }
}

// ============ ITUNES SEARCH ============

interface ITunesSearchParams {
  term: string;
  country: string;
  type: 'movie' | 'tv';
}

async function searchITunes(params: ITunesSearchParams): Promise<any[]> {
  const { term, country, type } = params;
  
  const queryParams = new URLSearchParams({
    term,
    country,
    limit: '100',
    media: type === 'movie' ? 'movie' : 'tvShow',
    entity: type === 'movie' ? 'movie' : 'tvSeason',
  });
  
  const url = `https://itunes.apple.com/search?${queryParams}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout for thorough search
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    
    const data = await response.json();
    const results = (data.results || []).filter((r: any) => r.previewUrl);
    
    console.log(`  iTunes ${country.toUpperCase()}: ${results.length} results`);
    return results;
  } catch {
    return [];
  }
}

// ============ SCORING LOGIC ============

interface ScoreResult {
  score: number;
  item: any;
}

function scoreItem(tmdbMeta: TMDBMetadata, item: any): number {
  let score = 0;
  
  const namesToCheck: string[] = [];
  
  if (tmdbMeta.mediaType === 'tv') {
    if (item.collectionName) namesToCheck.push(item.collectionName);
    if (item.artistName) namesToCheck.push(item.artistName);
    if (item.trackName) namesToCheck.push(item.trackName);
  } else {
    if (item.trackName) namesToCheck.push(item.trackName);
    if (item.collectionName) namesToCheck.push(item.collectionName);
  }
  
  const normTitle = normalizeTitle(tmdbMeta.title);
  const normOriginal = normalizeTitle(tmdbMeta.originalTitle);
  const normAltTitles = tmdbMeta.altTitles.map(t => normalizeTitle(t));
  
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
  
  const itunesYear = item.releaseDate ? parseInt(item.releaseDate.substring(0, 4)) : null;
  if (tmdbMeta.year && itunesYear) {
    const diff = Math.abs(itunesYear - tmdbMeta.year);
    if (tmdbMeta.mediaType === 'tv') {
      if (diff === 0) score += 0.35;
      else if (diff <= 2) score += 0.25;
      else if (diff <= 5) score += 0.15;
      else if (diff <= 10) score += 0.05;
    } else {
      if (diff === 0) score += 0.35;
      else if (diff === 1) score += 0.2;
      else if (diff > 2) score -= 0.5;
    }
  }
  
  if (tmdbMeta.mediaType === 'movie' && tmdbMeta.runtime && item.trackTimeMillis) {
    const itunesMinutes = Math.round(item.trackTimeMillis / 60000);
    const runtimeDiff = Math.abs(itunesMinutes - tmdbMeta.runtime);
    if (runtimeDiff <= 5) score += 0.15;
    else if (runtimeDiff > 15) score -= 0.2;
  }
  
  if (!item.previewUrl) score -= 1.0;
  
  return score;
}

function findBestMatch(results: any[], tmdbMeta: TMDBMetadata): ScoreResult | null {
  let best: ScoreResult | null = null;
  
  for (const item of results) {
    const score = scoreItem(tmdbMeta, item);
    if (score >= MIN_SCORE_THRESHOLD && (!best || score > best.score)) {
      best = { score, item };
    }
  }
  
  return best;
}

// ============ SEARCH RESULT ============

interface SearchResult {
  found: boolean;
  previewUrl?: string;
  trackId?: number;
  country?: string;
}

// ============ MULTI-PASS SEARCH ============

async function multiPassSearch(tmdbMeta: TMDBMetadata): Promise<SearchResult> {
  const searchType = tmdbMeta.mediaType === 'movie' ? 'movie' : 'tv';
  
  // Collect titles to try
  const titlesToTry: string[] = [tmdbMeta.title];
  if (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title) {
    titlesToTry.push(tmdbMeta.originalTitle);
  }
  // Add first 2 unique alt titles
  for (const alt of tmdbMeta.altTitles.slice(0, 2)) {
    if (!titlesToTry.includes(alt)) {
      titlesToTry.push(alt);
    }
  }
  
  console.log(`Titles to try: ${titlesToTry.join(', ')}`);
  
  // Search helper
  const searchWithCountry = async (title: string, country: string): Promise<{ results: any[]; country: string } | null> => {
    try {
      const results = await searchITunes({ term: title, country, type: searchType });
      return results.length > 0 ? { results, country } : null;
    } catch {
      return null;
    }
  };
  
  // Helper to find best match from results
  const findBestFromResults = (allResults: Array<{ results: any[]; country: string } | null>): { score: number; item: any; country: string } | null => {
    let bestOverall: { score: number; item: any; country: string } | null = null;
    for (const result of allResults) {
      if (!result) continue;
      const match = findBestMatch(result.results, tmdbMeta);
      if (match && (!bestOverall || match.score > bestOverall.score)) {
        bestOverall = { ...match, country: result.country };
      }
    }
    return bestOverall;
  };
  
  // For each title, search ALL countries in parallel
  for (const title of titlesToTry) {
    console.log(`\nSearching all ${ALL_COUNTRIES.length} countries for "${title}"`);
    
    // Launch all country searches simultaneously
    const countrySearches = ALL_COUNTRIES.map(country => searchWithCountry(title, country));
    const allResults = await Promise.all(countrySearches);
    
    const bestOverall = findBestFromResults(allResults);
    
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
  
  console.log('No match found across all countries and titles');
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
      if (cached.preview_url) {
        console.log('Cache hit: returning cached iTunes preview');
        return {
          found: true,
          previewUrl: cached.preview_url,
          trackId: cached.track_id,
          country: cached.country
        };
      }
      // Negative cache
      console.log('Cache hit: negative cache (no preview found previously)');
      return { found: false };
    }
    console.log('Cache expired, refreshing...');
  }
  
  // Get TMDB metadata
  const tmdbMeta = await getTMDBMetadata(imdbId, type);
  if (!tmdbMeta) {
    return { found: false };
  }
  
  // Search iTunes across all countries
  const itunesResult = await multiPassSearch(tmdbMeta);
  
  if (itunesResult.found) {
    // Cache result
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
    return itunesResult;
  }
  
  // No result found - cache negative result
  await supabase
    .from('itunes_mappings')
    .upsert({
      imdb_id: imdbId,
      track_id: null,
      preview_url: null,
      country: null,
      youtube_key: null,
      last_checked: new Date().toISOString()
    }, { onConflict: 'imdb_id' });
  
  console.log('No preview found on iTunes');
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
        JSON.stringify({ status: 'ok', version: '3.0.0' }),
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
        const streamName = type === 'movie' ? 'Movie Preview' : 'Episode Preview';
        const streamTitle = `Trailer / Preview (${result.country?.toUpperCase() || 'US'})`;
        
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
      
      const countryStats: Record<string, number> = {};
      for (const hit of hits) {
        const country = hit.country || 'us';
        countryStats[country] = (countryStats[country] || 0) + 1;
      }
      
      const recentMisses = misses.slice(0, 20).map(m => ({
        imdbId: m.imdb_id,
        lastChecked: m.last_checked
      }));
      
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
