import { useState } from "react";
import { Play, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface VideoPlayerProps {
  url: string;
}

export function VideoPlayer({ url }: VideoPlayerProps) {
  const [videoError, setVideoError] = useState(false);

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
    <div className="rounded-lg overflow-hidden bg-black aspect-video">
      <video
        key={url}
        src={url}
        controls
        autoPlay
        playsInline
        crossOrigin="anonymous"
        className="w-full h-full"
        onError={(e) => {
          console.error('Video playback error:', e);
          setVideoError(true);
          toast.error("Video cannot play inline - use the fallback button");
        }}
      />
    </div>
  );
}
