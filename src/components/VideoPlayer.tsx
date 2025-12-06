import { useState, useRef, useEffect, useCallback } from "react";
import { Play, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface VideoPlayerProps {
  url: string;
  onRetry?: () => void;
}

const MAX_RETRIES = 2;

export function VideoPlayer({ url, onRetry }: VideoPlayerProps) {
  const [videoError, setVideoError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(url);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Reset state when url changes externally
  useEffect(() => {
    setCurrentUrl(url);
    setVideoError(false);
    setIsLoading(true);
    setRetryCount(0);
  }, [url]);

  const handleCanPlay = () => {
    setIsLoading(false);
  };

  const handleRetry = useCallback(() => {
    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying video load (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      setRetryCount(prev => prev + 1);
      setVideoError(false);
      setIsLoading(true);
      // Add cache-busting param to force fresh request
      const bustUrl = url.includes('?') 
        ? `${url}&_retry=${Date.now()}` 
        : `${url}?_retry=${Date.now()}`;
      setCurrentUrl(bustUrl);
    } else if (onRetry) {
      // If we've exhausted retries and there's an external retry handler, call it
      onRetry();
    } else {
      setVideoError(true);
      setIsLoading(false);
    }
  }, [retryCount, url, onRetry]);

  const handleError = useCallback((e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    console.error('Video playback error:', e);
    
    if (retryCount < MAX_RETRIES) {
      // Auto-retry on first failures
      handleRetry();
    } else {
      setVideoError(true);
      setIsLoading(false);
      toast.error("Video cannot play inline - use the fallback button");
    }
  }, [retryCount, handleRetry]);

  const handleLoadStart = () => {
    setIsLoading(true);
  };

  if (videoError) {
    return (
      <div className="rounded-lg overflow-hidden bg-muted/30 aspect-video flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col items-center gap-3 p-6 rounded-lg bg-background/50 hover:bg-background/80 transition-colors text-center"
          >
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Play className="w-8 h-8 text-primary" />
            </div>
            <div>
              <p className="font-medium text-foreground">Play in new tab</p>
              <p className="text-xs text-muted-foreground mt-1">
                Video couldn't load inline
              </p>
            </div>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </a>
          
          {onRetry && (
            <button
              onClick={() => {
                setRetryCount(0);
                setVideoError(false);
                setIsLoading(true);
                onRetry();
              }}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
            >
              <RefreshCw className="w-4 h-4" />
              Try different source
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden bg-black aspect-video relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">
              {retryCount > 0 ? `Retrying... (${retryCount}/${MAX_RETRIES})` : 'Loading video...'}
            </p>
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        key={currentUrl}
        src={currentUrl}
        controls
        autoPlay
        playsInline
        crossOrigin="anonymous"
        className="w-full h-full"
        onLoadStart={handleLoadStart}
        onCanPlay={handleCanPlay}
        onError={handleError}
      />
    </div>
  );
}
