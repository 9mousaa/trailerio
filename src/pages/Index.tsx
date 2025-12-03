import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Play, Copy, Check, Film, Tv, Zap, Database, Globe } from "lucide-react";

const ADDON_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stremio-addon`;
const MANIFEST_URL = `${ADDON_URL}/manifest.json`;

const Index = () => {
  const [testImdbId, setTestImdbId] = useState("tt9362722"); // Spider-Man: Across the Spider-Verse
  const [testType, setTestType] = useState<"movie" | "series">("movie");
  const [testResult, setTestResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyManifestUrl = async () => {
    await navigator.clipboard.writeText(MANIFEST_URL);
    setCopied(true);
    toast.success("Manifest URL copied to clipboard!");
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
        toast.success("Preview found!");
      } else {
        toast.info("No preview available for this title");
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
      setTestResult({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-dark opacity-95" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/20 via-transparent to-transparent" />
        
        <div className="relative container mx-auto px-4 py-20 md:py-32">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-6">
              <Zap className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">Stremio Add-on</span>
            </div>
            
            <h1 className="text-4xl md:text-6xl font-bold text-white mb-6 tracking-tight">
              iTunes Trailer
              <span className="text-gradient"> Preview</span>
            </h1>
            
            <p className="text-lg md:text-xl text-white/70 mb-8 max-w-2xl mx-auto">
              Watch trailers and previews from iTunes directly in Stremio. 
              Automatically finds matching trailers using TMDB metadata.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <div className="flex items-center gap-2 bg-card/10 backdrop-blur border border-white/10 rounded-lg px-4 py-3 w-full sm:w-auto">
                <code className="text-sm text-white/80 font-mono truncate max-w-[280px] md:max-w-none">
                  {MANIFEST_URL}
                </code>
              </div>
              <Button 
                onClick={copyManifestUrl}
                className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2 w-full sm:w-auto"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied!" : "Copy URL"}
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Features */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-6">
            <Card className="bg-card border-border/50 hover:border-primary/30 transition-colors">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <Film className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-foreground">Movies & TV Shows</CardTitle>
                <CardDescription>
                  Supports both movies and TV series with automatic content type detection
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="bg-card border-border/50 hover:border-primary/30 transition-colors">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4">
                  <Database className="w-6 h-6 text-accent" />
                </div>
                <CardTitle className="text-foreground">Smart Caching</CardTitle>
                <CardDescription>
                  Results are cached for 30 days to ensure fast responses and reduce API calls
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="bg-card border-border/50 hover:border-primary/30 transition-colors">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <Globe className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-foreground">TMDB Integration</CardTitle>
                <CardDescription>
                  Uses TMDB for accurate title matching and metadata resolution
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* Test Section */}
      <section className="py-16 md:py-24 bg-muted/30">
        <div className="container mx-auto px-4">
          <div className="max-w-2xl mx-auto">
            <Card className="bg-card border-border/50">
              <CardHeader className="text-center">
                <CardTitle className="text-2xl text-foreground">Test the Add-on</CardTitle>
                <CardDescription>
                  Enter an IMDB ID to test trailer resolution
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="flex-1">
                    <label className="text-sm font-medium text-muted-foreground mb-2 block">
                      IMDB ID
                    </label>
                    <Input
                      placeholder="tt9362722"
                      value={testImdbId}
                      onChange={(e) => setTestImdbId(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div className="sm:w-32">
                    <label className="text-sm font-medium text-muted-foreground mb-2 block">
                      Type
                    </label>
                    <div className="flex gap-2">
                      <Button
                        variant={testType === "movie" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setTestType("movie")}
                        className="flex-1"
                      >
                        <Film className="w-4 h-4" />
                      </Button>
                      <Button
                        variant={testType === "series" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setTestType("series")}
                        className="flex-1"
                      >
                        <Tv className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <Button 
                  onClick={testAddon} 
                  disabled={loading || !testImdbId}
                  className="w-full bg-gradient-primary hover:opacity-90 transition-opacity"
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Searching...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Play className="w-4 h-4" />
                      Find Preview
                    </span>
                  )}
                </Button>

                {testResult && (
                  <div className="mt-6 p-4 rounded-lg bg-muted/50 border border-border">
                    <h4 className="text-sm font-medium text-muted-foreground mb-2">Response:</h4>
                    <pre className="text-sm font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(testResult, null, 2)}
                    </pre>
                    
                    {testResult.streams?.[0]?.url && (
                      <div className="mt-4 pt-4 border-t border-border">
                        <a
                          href={testResult.streams[0].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-primary hover:underline"
                        >
                          <Play className="w-4 h-4" />
                          Play Preview
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Installation */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-3xl font-bold text-foreground mb-4">How to Install</h2>
            <p className="text-muted-foreground mb-8">
              Add this add-on to Stremio in just a few steps
            </p>
            
            <div className="space-y-4 text-left">
              <div className="flex gap-4 p-4 rounded-lg bg-card border border-border/50">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                  1
                </div>
                <div>
                  <h3 className="font-medium text-foreground">Copy the manifest URL</h3>
                  <p className="text-sm text-muted-foreground">
                    Click the "Copy URL" button above to copy the add-on manifest URL
                  </p>
                </div>
              </div>
              
              <div className="flex gap-4 p-4 rounded-lg bg-card border border-border/50">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                  2
                </div>
                <div>
                  <h3 className="font-medium text-foreground">Open Stremio</h3>
                  <p className="text-sm text-muted-foreground">
                    Go to the Add-ons section in your Stremio app
                  </p>
                </div>
              </div>
              
              <div className="flex gap-4 p-4 rounded-lg bg-card border border-border/50">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold">
                  3
                </div>
                <div>
                  <h3 className="font-medium text-foreground">Install from URL</h3>
                  <p className="text-sm text-muted-foreground">
                    Paste the manifest URL and click Install to add the add-on
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 border-t border-border">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm text-muted-foreground">
            iTunes Trailer Preview Add-on • Powered by TMDB and iTunes
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
