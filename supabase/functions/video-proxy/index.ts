import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// iOS Safari Requirements for streaming:
// - Content-Type: video/mp4
// - Content-Disposition: inline (NOT attachment)
// - Accept-Ranges: bytes (for scrubbing/seeking)
// - Proper CORS headers

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace('/video-proxy', '');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  // Get the video URL from query param
  const videoUrl = url.searchParams.get('url');
  
  if (!videoUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing url parameter' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  
  console.log(`Proxying video: ${videoUrl.substring(0, 100)}...`);
  
  try {
    // Forward range header if present (for seeking/scrubbing)
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    };
    
    const rangeHeader = req.headers.get('range');
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
      console.log(`Range request: ${rangeHeader}`);
    }
    
    // Fetch the video from the source
    const response = await fetch(videoUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
    });
    
    if (!response.ok) {
      console.error(`Upstream error: ${response.status} ${response.statusText}`);
      return new Response(
        JSON.stringify({ error: `Upstream error: ${response.status}` }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Build iOS-compatible response headers
    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      // Force video/mp4 content type for iOS
      'Content-Type': 'video/mp4',
      // CRITICAL: inline, NOT attachment - prevents download prompt
      'Content-Disposition': 'inline',
      // CRITICAL: Enable byte-range requests for seeking
      'Accept-Ranges': 'bytes',
      // Cache for performance
      'Cache-Control': 'public, max-age=3600',
    };
    
    // Forward content length if available
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      responseHeaders['Content-Length'] = contentLength;
    }
    
    // Forward content range for partial content responses
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      responseHeaders['Content-Range'] = contentRange;
    }
    
    // Use 206 for partial content, 200 for full
    const status = response.status === 206 ? 206 : 200;
    
    console.log(`Proxying ${status} response, Content-Length: ${contentLength || 'unknown'}`);
    
    return new Response(response.body, {
      status,
      headers: responseHeaders,
    });
    
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Proxy error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
