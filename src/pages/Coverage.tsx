import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Database, Target, TrendingUp, XCircle, CheckCircle } from "lucide-react";

const ADDON_URL = import.meta.env.VITE_API_URL || '/api';

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
  "tt0167260": "LOTR: Return of the King",
  "tt0110912": "Pulp Fiction",
  "tt0060196": "The Good, the Bad and the Ugly",
  "tt0120737": "LOTR: Fellowship of the Ring",
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
        const response = await fetch(`${ADDON_URL}/stats`, {
          headers: {
            'Accept': 'application/json'
          }
        });
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

        {/* Footer */}
        <footer className="text-sm text-muted-foreground border-t border-border pt-8">
          Data refreshes on page load
        </footer>
      </div>
    </div>
  );
};

export default Coverage;
