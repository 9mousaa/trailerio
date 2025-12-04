-- Add youtube_key column for YouTube fallback caching
ALTER TABLE public.itunes_mappings 
ADD COLUMN IF NOT EXISTS youtube_key TEXT;