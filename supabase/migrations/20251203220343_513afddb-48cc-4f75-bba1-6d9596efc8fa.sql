-- Create table for caching iTunes mappings
CREATE TABLE public.itunes_mappings (
  id SERIAL PRIMARY KEY,
  imdb_id TEXT NOT NULL UNIQUE,
  track_id BIGINT,
  preview_url TEXT,
  country TEXT DEFAULT 'us',
  last_checked TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX idx_itunes_mappings_imdb_id ON public.itunes_mappings(imdb_id);

-- Enable RLS but allow public access (this is a cache table for the add-on)
ALTER TABLE public.itunes_mappings ENABLE ROW LEVEL SECURITY;

-- Allow public read access (cached data is not sensitive)
CREATE POLICY "Public read access for itunes_mappings"
ON public.itunes_mappings
FOR SELECT
USING (true);

-- Allow insert/update from edge functions (service role)
CREATE POLICY "Service role insert for itunes_mappings"
ON public.itunes_mappings
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Service role update for itunes_mappings"
ON public.itunes_mappings
FOR UPDATE
USING (true);