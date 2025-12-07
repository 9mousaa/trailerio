import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Copy, Check, Film, Tv } from "lucide-react";
import { VideoPlayer } from "@/components/VideoPlayer";
import { TITLE_MAP, TEST_TITLES } from "@/lib/constants";
import { getApiUrl, getBaseUrl } from "@/lib/utils";

const MANIFEST_URL = `${getApiUrl()}/manifest.json`;

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
      const apiUrl = getApiUrl();
      const response = await fetch(`${apiUrl}/stream/${testType}/${testImdbId}.json`, {
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Expected JSON but got: ${contentType}. Response: ${text.substring(0, 100)}`);
      }
      
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
    <div className="min-h-screen bg-black text-white">
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
                    
                    {/* Inline Video Player with fallback */}
                    <VideoPlayer url={testResult.streams[0].url} />
                    
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

      </div>
    </div>
  );
};

export default Index;
