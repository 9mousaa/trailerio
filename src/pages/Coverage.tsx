import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Database, Target, TrendingUp, XCircle } from "lucide-react";

const ADDON_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stremio-addon`;

interface Stats {
  totalCached: number;
  hits: number;
  misses: number;
  hitRate: string;
  recentMisses: Array<{
    imdb_id: string;
    last_checked: string;
  }>;
}

const Coverage = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch(`${ADDON_URL}/stats`);
        const data = await response.json();
        setStats(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-muted-foreground">Loading stats...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-destructive">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-6 py-20">
        {/* Header */}
        <header className="mb-16">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-8"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mb-3">
            Coverage Stats
          </h1>
          <p className="text-muted-foreground">
            Cache performance and iTunes preview availability.
          </p>
        </header>

        {/* Stats Grid */}
        <section className="mb-16">
          <div className="grid grid-cols-2 gap-4">
            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Database className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Cached</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.totalCached || 0}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <TrendingUp className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Hit Rate</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.hitRate || "0%"}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Target className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Hits</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.hits || 0}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <XCircle className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Misses</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.misses || 0}</div>
            </div>
          </div>
        </section>

        {/* Recent Misses */}
        {stats?.recentMisses && stats.recentMisses.length > 0 && (
          <section className="mb-16">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
              Recent Misses
            </h2>
            <div className="border border-border rounded-lg divide-y divide-border">
              {stats.recentMisses.map((miss, index) => (
                <div key={index} className="px-4 py-3 flex justify-between items-center">
                  <code className="text-sm font-mono">{miss.imdb_id}</code>
                  <span className="text-sm text-muted-foreground">
                    {new Date(miss.last_checked).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="text-sm text-muted-foreground border-t border-border pt-8">
          Data refreshes on page load
        </footer>
      </div>
    </div>
  );
};

export default Coverage;
