import { useState, useRef } from "react";
import { Play, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface VideoPlayerProps {
  url: string;
}

export function VideoPlayer({ url }: VideoPlayerProps) {
  const [videoError, setVideoError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleCanPlay = () => {
    setIsLoading(false);
  };

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    console.error('Video playback error:', e);
    setVideoError(true);
    setIsLoading(false);
    toast.error("Video cannot play inline - use the fallback button");
  };

  const handleLoadStart = () => {
    setIsLoading(true);
    setVideoError(false);
  };

  if (videoError) {
    return (
      <div className="rounded-lg overflow-hidden bg-muted/30 aspect-video flex items-center justify-center">
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
              Browser blocked inline playback (CORS)
            </p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden bg-black aspect-video relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Loading video...</p>
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        key={url}
        src={url}
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
