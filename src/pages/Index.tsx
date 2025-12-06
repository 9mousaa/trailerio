import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Play, Copy, Check, Film, Tv } from "lucide-react";

const ADDON_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stremio-addon`;
const MANIFEST_URL = `${ADDON_URL}/manifest.json`;

// Title lookup map
const TITLE_MAP: Record<string, string> = {
  "tt9362722": "Spider-Man: Across the Spider-Verse",
  "tt15398776": "Oppenheimer",
  "tt1517268": "Barbie",
  "tt6791350": "Guardians of the Galaxy Vol. 3",
  "tt10366206": "John Wick: Chapter 4",
  "tt14998742": "Wonka",
  "tt5537002": "Killers of the Flower Moon",
  "tt6718170": "The Super Mario Bros. Movie",
  "tt1630029": "Avatar: The Way of Water",
  "tt4154796": "Avengers: Endgame",
  "tt4154756": "Avengers: Infinity War",
  "tt6264654": "Free Guy",
  "tt8041270": "Jurassic World Dominion",
  "tt1745960": "Top Gun: Maverick",
  "tt7286456": "Joker",
  "tt2382320": "No Time to Die",
  "tt10872600": "Spider-Man: No Way Home",
  "tt9032400": "Eternals",
  "tt10648342": "Thor: Love and Thunder",
  "tt14539740": "Smile",
  "tt0111161": "The Shawshank Redemption",
  "tt0068646": "The Godfather",
  "tt0468569": "The Dark Knight",
  "tt0071562": "The Godfather Part II",
  "tt0050083": "12 Angry Men",
  "tt0108052": "Schindler's List",
  "tt0167260": "The Lord of the Rings: The Return of the King",
  "tt0110912": "Pulp Fiction",
  "tt0060196": "The Good, the Bad and the Ugly",
  "tt0120737": "The Lord of the Rings: The Fellowship of the Ring",
  "tt0109830": "Forrest Gump",
  "tt0137523": "Fight Club",
  "tt0133093": "The Matrix",
  "tt0099685": "Goodfellas",
  "tt0073486": "One Flew Over the Cuckoo's Nest",
  "tt0114369": "Se7en",
  "tt0038650": "It's a Wonderful Life",
  "tt0102926": "The Silence of the Lambs",
  "tt0120815": "Saving Private Ryan",
  "tt0816692": "Interstellar",
  "tt1375666": "Inception",
  "tt0482571": "The Prestige",
  "tt0407887": "The Departed",
  "tt0172495": "Gladiator",
  "tt0120689": "The Green Mile",
  "tt0253474": "The Pianist",
  "tt0047478": "Seven Samurai",
  "tt0078788": "Apocalypse Now",
  "tt0078748": "Alien",
  "tt0082971": "Raiders of the Lost Ark",
  "tt0209144": "Memento",
  "tt0245429": "Spirited Away",
  "tt0317248": "City of God",
  "tt0119698": "Princess Mononoke",
  "tt0180093": "Requiem for a Dream",
  "tt0095327": "Grave of the Fireflies",
  "tt0118799": "Life Is Beautiful",
  "tt0057012": "Dr. Strangelove",
  "tt0361748": "Inglourious Basterds",
  "tt0364569": "Oldboy",
  "tt0986264": "Taare Zameen Par",
  "tt1853728": "Django Unchained",
  "tt2380307": "Coco",
  "tt7131622": "Once Upon a Time in Hollywood",
  "tt0944947": "Game of Thrones",
  "tt0903747": "Breaking Bad",
  "tt0386676": "The Office",
  "tt4574334": "Stranger Things",
  "tt0460649": "How I Met Your Mother",
  "tt0898266": "The Big Bang Theory",
  "tt2861424": "Rick and Morty",
  "tt5491994": "Planet Earth II",
  "tt0475784": "Westworld",
  "tt1520211": "The Walking Dead",
  "tt0413573": "Grey's Anatomy",
  "tt2356777": "True Detective",
  "tt0411008": "Lost",
  "tt0773262": "Dexter",
  "tt1475582": "Sherlock",
  "tt0804503": "Mad Men",
  "tt1856010": "House of Cards",
  "tt3032476": "Better Call Saul",
  "tt0141842": "The Sopranos",
  "tt0121955": "South Park",
  "tt0108778": "Friends",
  "tt0472954": "It's Always Sunny in Philadelphia",
  "tt1442437": "Modern Family",
  "tt1190634": "The Boys",
  "tt0306414": "The Wire",
  "tt0149460": "Futurama",
  "tt0185906": "Band of Brothers",
  "tt8111088": "The Mandalorian",
  "tt7660850": "Succession",
  "tt9288030": "Reacher",
  "tt13443470": "Wednesday",
  "tt11280740": "Severance",
  "tt11198330": "House of the Dragon",
  "tt9140554": "Loki",
  "tt10986410": "Ted Lasso",
};

// Large list of popular movies and TV shows
// TV series IDs
const TV_IDS = new Set([
  "tt0944947", "tt0903747", "tt0386676", "tt4574334", "tt0460649", "tt0898266",
  "tt2861424", "tt5491994", "tt0475784", "tt1520211", "tt0413573", "tt2356777",
  "tt0411008", "tt0773262", "tt1475582", "tt0804503", "tt1856010", "tt3032476",
  "tt0141842", "tt0121955", "tt0108778", "tt0472954", "tt1442437", "tt1190634",
  "tt0306414", "tt0149460", "tt0185906", "tt8111088", "tt7660850", "tt9288030",
  "tt13443470", "tt11280740", "tt11198330", "tt9140554", "tt10986410"
]);

const TEST_TITLES = Object.keys(TITLE_MAP).map(id => ({
  id,
  type: TV_IDS.has(id) ? "series" as const : "movie" as const
}));

const Index = () => {
  const [testImdbId, setTestImdbId] = useState("");
  const [testType, setTestType] = useState<"movie" | "series">("movie");
  const [testResult, setTestResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const random = TEST_TITLES[Math.floor(Math.random() * TEST_TITLES.length)];
    setTestImdbId(random.id);
    setTestType(random.type);
  }, []);

  const copyManifestUrl = async () => {
    await navigator.clipboard.writeText(MANIFEST_URL);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const testAddon = async () => {
    setLoading(true);
    setTestResult(null);
    
    try {
      const response = await fetch(`${ADDON_URL}/stream/${testType}/${testImdbId}.json`);
      const data = await response.json();
      setTestResult(data);
      
      if (data.streams && data.streams.length > 0) {
        toast.success("Preview found");
      } else {
        toast.info("No preview available");
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
      setTestResult({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-6 py-20">
        {/* Header */}
        <header className="mb-16">
          <h1 className="text-3xl font-semibold tracking-tight mb-3">
            Trailer Preview
          </h1>
          <p className="text-muted-foreground">
            Stremio add-on for watching trailers and previews.
          </p>
        </header>

        {/* Install */}
        <section className="mb-16">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
            Manifest URL
          </h2>
          <div className="flex gap-3">
            <div className="flex-1 bg-muted rounded-lg px-4 py-3 font-mono text-sm truncate">
              {MANIFEST_URL}
            </div>
            <Button onClick={copyManifestUrl} variant="outline" className="shrink-0">
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </section>

        {/* Test */}
        <section className="mb-16">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
            Test
          </h2>
          <div className="space-y-4">
            {/* Show current title */}
            {TITLE_MAP[testImdbId] && (
              <div className="text-lg font-medium">
                {TITLE_MAP[testImdbId]}
              </div>
            )}
            <div className="flex gap-3">
              <Input
                placeholder="tt0111161"
                value={testImdbId}
                onChange={(e) => setTestImdbId(e.target.value)}
                className="font-mono flex-1"
              />
              <div className="flex border border-input rounded-lg overflow-hidden">
                <button
                  onClick={() => setTestType("movie")}
                  className={`px-3 py-2 text-sm transition-colors ${
                    testType === "movie" 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  <Film className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setTestType("series")}
                  className={`px-3 py-2 text-sm transition-colors ${
                    testType === "series" 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  <Tv className="w-4 h-4" />
                </button>
              </div>
            </div>

            <Button 
              onClick={testAddon} 
              disabled={loading || !testImdbId}
              className="w-full"
            >
              {loading ? "Searching..." : "Find Preview"}
            </Button>

            {testResult && (
              <div className="p-4 rounded-lg bg-muted space-y-4">
                {testResult.streams?.[0]?.url ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-muted-foreground">Preview found</div>
                      <a
                        href={testResult.streams[0].url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        Open in new tab ↗
                      </a>
                    </div>
                    
                    {/* Inline Video Player - use src directly, let browser detect format */}
                    <div className="rounded-lg overflow-hidden bg-black aspect-video">
                      <video
                        key={testResult.streams[0].url}
                        src={testResult.streams[0].url}
                        controls
                        autoPlay
                        playsInline
                        crossOrigin="anonymous"
                        className="w-full h-full"
                        onError={(e) => {
                          console.error('Video playback error:', e);
                          toast.error("Video cannot play inline - try the 'Open in new tab' link above");
                        }}
                      />
                    </div>
                    
                    {/* Stream info */}
                    {(testResult.streams[0].name || testResult.streams[0].title) && (
                      <div className="text-xs text-muted-foreground">
                        {testResult.streams[0].name || testResult.streams[0].title}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No preview available</div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Info */}
        <section className="mb-16">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
            How it works
          </h2>
          <ol className="space-y-3 text-sm text-muted-foreground">
            <li>1. Copy the manifest URL above</li>
            <li>2. Open Stremio → Add-ons → Install from URL</li>
            <li>3. Paste the URL and install</li>
          </ol>
        </section>

        {/* Footer */}
        <footer className="text-sm text-muted-foreground border-t border-border pt-8 flex justify-between items-center">
          <span>Powered by TMDB</span>
          <Link to="/coverage" className="hover:text-foreground transition-colors">
            Coverage Stats
          </Link>
        </footer>
      </div>
    </div>
  );
};

export default Index;
