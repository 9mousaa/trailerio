import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Database, Target, TrendingUp, XCircle, CheckCircle } from "lucide-react";
import { TITLE_MAP } from "@/lib/constants";

const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return '';
};

const ADDON_URL = import.meta.env.VITE_API_URL || `${getBaseUrl()}/api`;

interface Stats {
  cache: {
    totalEntries: number;
    hits: number;
    misses: number;
    hitRate: string;
  };
  recentMisses: Array<{
    imdbId: string;
    lastChecked: string;
  }>;
  recentHits: Array<{
    imdbId: string;
    lastChecked: string;
    country: string;
  }>;
}

const Coverage = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || `${window.location.origin}/api`;
        const response = await fetch(`${apiUrl}/stats`, {
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error(`Expected JSON but got: ${contentType}`);
        }
        
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
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-gray-400">Loading stats...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-red-500">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
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
            Cache performance and preview availability.
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
              <div className="text-4xl font-semibold">{stats?.cache?.totalEntries || 0}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <TrendingUp className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Hit Rate</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.cache?.hitRate || "0%"}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Target className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Hits</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.cache?.hits || 0}</div>
            </div>

            <div className="border border-border rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <XCircle className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground uppercase tracking-wide">Misses</span>
              </div>
              <div className="text-4xl font-semibold">{stats?.cache?.misses || 0}</div>
            </div>
          </div>
        </section>

        {/* Recent Hits */}
        {stats?.recentHits && stats.recentHits.length > 0 && (
          <section className="mb-12">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
              <CheckCircle className="w-4 h-4 inline mr-2" />
              Recent Hits
            </h2>
            <div className="border border-border rounded-lg divide-y divide-border">
              {stats.recentHits.slice(0, 6).map((hit, index) => (
                <div key={index} className="px-4 py-3 flex justify-between items-center">
                  <span className="text-sm">{TITLE_MAP[hit.imdbId] || hit.imdbId}</span>
                  <span className="text-sm text-muted-foreground">{hit.country.toUpperCase()}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Recent Misses */}
        {stats?.recentMisses && stats.recentMisses.length > 0 && (
          <section className="mb-16">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
              <XCircle className="w-4 h-4 inline mr-2" />
              Recent Misses
            </h2>
            <div className="border border-border rounded-lg divide-y divide-border">
              {stats.recentMisses.slice(0, 6).map((miss, index) => (
                <div key={index} className="px-4 py-3 flex justify-between items-center">
                  <span className="text-sm">{TITLE_MAP[miss.imdbId] || miss.imdbId}</span>
                  <span className="text-sm text-muted-foreground">
                    {new Date(miss.lastChecked).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  );
};

export default Coverage;
