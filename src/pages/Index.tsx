import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Play, Copy, Check, Film, Tv } from "lucide-react";

const ADDON_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stremio-addon`;
const MANIFEST_URL = `${ADDON_URL}/manifest.json`;

// Large list of popular movies and TV shows
const TEST_TITLES = [
  // Movies - Recent
  { id: "tt9362722", type: "movie" as const },
  { id: "tt15398776", type: "movie" as const },
  { id: "tt1517268", type: "movie" as const },
  { id: "tt6791350", type: "movie" as const },
  { id: "tt10366206", type: "movie" as const },
  { id: "tt14998742", type: "movie" as const },
  { id: "tt5537002", type: "movie" as const },
  { id: "tt6718170", type: "movie" as const },
  { id: "tt1630029", type: "movie" as const },
  { id: "tt4154796", type: "movie" as const },
  { id: "tt4154756", type: "movie" as const },
  { id: "tt6264654", type: "movie" as const },
  { id: "tt8041270", type: "movie" as const },
  { id: "tt1745960", type: "movie" as const },
  { id: "tt7286456", type: "movie" as const },
  { id: "tt2382320", type: "movie" as const },
  { id: "tt10872600", type: "movie" as const },
  { id: "tt9032400", type: "movie" as const },
  { id: "tt10648342", type: "movie" as const },
  { id: "tt14539740", type: "movie" as const },
  // Movies - Classics
  { id: "tt0111161", type: "movie" as const },
  { id: "tt0068646", type: "movie" as const },
  { id: "tt0468569", type: "movie" as const },
  { id: "tt0071562", type: "movie" as const },
  { id: "tt0050083", type: "movie" as const },
  { id: "tt0108052", type: "movie" as const },
  { id: "tt0167260", type: "movie" as const },
  { id: "tt0110912", type: "movie" as const },
  { id: "tt0060196", type: "movie" as const },
  { id: "tt0120737", type: "movie" as const },
  { id: "tt0109830", type: "movie" as const },
  { id: "tt0137523", type: "movie" as const },
  { id: "tt0133093", type: "movie" as const },
  { id: "tt0099685", type: "movie" as const },
  { id: "tt0073486", type: "movie" as const },
  { id: "tt0114369", type: "movie" as const },
  { id: "tt0038650", type: "movie" as const },
  { id: "tt0102926", type: "movie" as const },
  { id: "tt0120815", type: "movie" as const },
  { id: "tt0816692", type: "movie" as const },
  { id: "tt1375666", type: "movie" as const },
  { id: "tt0482571", type: "movie" as const },
  { id: "tt0407887", type: "movie" as const },
  { id: "tt0172495", type: "movie" as const },
  { id: "tt0120689", type: "movie" as const },
  { id: "tt0253474", type: "movie" as const },
  { id: "tt0047478", type: "movie" as const },
  { id: "tt0078788", type: "movie" as const },
  { id: "tt0078748", type: "movie" as const },
  { id: "tt0082971", type: "movie" as const },
  { id: "tt0209144", type: "movie" as const },
  { id: "tt0245429", type: "movie" as const },
  { id: "tt0317248", type: "movie" as const },
  { id: "tt0119698", type: "movie" as const },
  { id: "tt0180093", type: "movie" as const },
  { id: "tt0095327", type: "movie" as const },
  { id: "tt0118799", type: "movie" as const },
  { id: "tt0057012", type: "movie" as const },
  { id: "tt0361748", type: "movie" as const },
  { id: "tt0364569", type: "movie" as const },
  { id: "tt0986264", type: "movie" as const },
  { id: "tt1853728", type: "movie" as const },
  { id: "tt2380307", type: "movie" as const },
  { id: "tt7131622", type: "movie" as const },
  // TV Series
  { id: "tt0944947", type: "series" as const },
  { id: "tt0903747", type: "series" as const },
  { id: "tt0386676", type: "series" as const },
  { id: "tt4574334", type: "series" as const },
  { id: "tt0460649", type: "series" as const },
  { id: "tt0898266", type: "series" as const },
  { id: "tt2861424", type: "series" as const },
  { id: "tt5491994", type: "series" as const },
  { id: "tt0475784", type: "series" as const },
  { id: "tt1520211", type: "series" as const },
  { id: "tt0413573", type: "series" as const },
  { id: "tt2356777", type: "series" as const },
  { id: "tt0411008", type: "series" as const },
  { id: "tt0773262", type: "series" as const },
  { id: "tt1475582", type: "series" as const },
  { id: "tt0804503", type: "series" as const },
  { id: "tt1856010", type: "series" as const },
  { id: "tt3032476", type: "series" as const },
  { id: "tt0141842", type: "series" as const },
  { id: "tt0121955", type: "series" as const },
  { id: "tt0108778", type: "series" as const },
  { id: "tt0472954", type: "series" as const },
  { id: "tt1442437", type: "series" as const },
  { id: "tt1190634", type: "series" as const },
  { id: "tt0306414", type: "series" as const },
  { id: "tt0149460", type: "series" as const },
  { id: "tt0185906", type: "series" as const },
  { id: "tt8111088", type: "series" as const },
  { id: "tt7660850", type: "series" as const },
  { id: "tt9288030", type: "series" as const },
  { id: "tt13443470", type: "series" as const },
  { id: "tt11280740", type: "series" as const },
  { id: "tt11198330", type: "series" as const },
  { id: "tt9140554", type: "series" as const },
  { id: "tt10986410", type: "series" as const },
];

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
            iTunes Trailer Preview
          </h1>
          <p className="text-muted-foreground">
            Stremio add-on for watching iTunes trailers and previews.
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
              <div className="p-4 rounded-lg bg-muted font-mono text-sm">
                <pre className="overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(testResult, null, 2)}
                </pre>
                {testResult.streams?.[0]?.url && (
                  <a
                    href={testResult.streams[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mt-4 text-foreground hover:underline"
                  >
                    <Play className="w-4 h-4" />
                    Play Preview
                  </a>
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
          <span>Powered by TMDB and iTunes</span>
          <Link to="/coverage" className="hover:text-foreground transition-colors">
            Coverage Stats
          </Link>
        </footer>
      </div>
    </div>
  );
};

export default Index;
