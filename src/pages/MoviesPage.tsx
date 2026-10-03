import { useDeferredValue, useMemo, useState } from 'react';
import { Bookmark, Clapperboard, History, Search, Tv, X } from 'lucide-react';
import { useApp } from '../store/app';
import { useTv } from '../store/tv';
import { useRoute } from '../app/router';
import { buildLibrary, epLabel, titleOf, type Show } from '../components/tv/library';
import { Poster } from '../components/tv/Poster';
import { VirtualGrid } from '../components/tv/VirtualGrid';
import { MovieDetails, ShowDetails } from '../components/tv/Details';
import { VodPlayerView, playVod } from '../components/tv/VodPlayer';
import type { Channel } from '../types';

type Tab = 'movies' | 'series' | 'mylist';
type Sort = 'recent' | 'az' | 'year';
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Movies & Series: the playlist's VOD library (#/movies), and the player view (#/movies/<id>). */
export default function MoviesPage() {
  const { param } = useRoute();
  if (param) return <VodPlayerView id={param} />;
  return <Library />;
}

function Library() {
  const channels = useApp((s) => s.channels);
  const loading = useApp((s) => s.loadingSources);
  const progress = useTv((s) => s.progress);
  const favorites = useTv((s) => s.favorites);
  const watchlist = useTv((s) => s.watchlist);
  const lib = useMemo(() => buildLibrary(channels), [channels]);
  const [tab, setTab] = useState<Tab>(() => (lib.movies.length || !lib.shows.length ? 'movies' : 'series'));
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const [group, setGroup] = useState('');
  const [year, setYear] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [openMovie, setOpenMovie] = useState<Channel | null>(null);
  const [openShow, setOpenShow] = useState<Show | null>(null);

  const movies = useMemo(() => {
    let out = lib.movies;
    if (group) out = out.filter((m) => m.group === group);
    if (year) out = out.filter((m) => String(m.year ?? '') === year);
    if (query) out = out.filter((m) => lib.lower.get(m.id)!.includes(query));
    if (sort === 'az') out = [...out].sort((a, b) => collator.compare(titleOf(a), titleOf(b)));
    else if (sort === 'year') out = [...out].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || collator.compare(titleOf(a), titleOf(b)));
    return out;
  }, [lib, group, year, query, sort]);

  const shows = useMemo(() => {
    let out = lib.shows;
    if (group) out = out.filter((s) => s.group === group);
    if (year) out = out.filter((s) => s.episodes.some((e) => String(e.year ?? '') === year));
    if (query) out = out.filter((s) => s.lower.includes(query) || s.group.toLowerCase().includes(query));
    if (sort === 'az') out = [...out].sort((a, b) => collator.compare(a.name, b.name));
    else if (sort === 'year') out = [...out].sort((a, b) => (Math.max(0, ...b.episodes.map((e) => e.year ?? 0))) - Math.max(0, ...a.episodes.map((e) => e.year ?? 0)));
    else out = [...out].sort((a, b) => a.order - b.order);
    return out;
  }, [lib, group, year, query, sort]);

  const continueRow = useMemo(() => Object.entries(progress)
    .filter(([id, p]) => !p.watched && p.pos >= 30 && lib.byId.has(id))
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 24)
    .map(([id, p]) => ({ item: lib.byId.get(id)!, p })), [progress, lib]);

  const myList = useMemo(() => {
    const keys = [...new Set([...watchlist, ...favorites])];
    return keys.map((k) => (k.startsWith('show:') ? lib.showByKey.get(k) : lib.byId.get(k))).filter(Boolean) as (Channel | Show)[];
  }, [watchlist, favorites, lib]);

  const groups = tab === 'series' ? lib.seriesGroups : lib.movieGroups;
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  if (!lib.movies.length && !lib.shows.length) {
    return (
      <div className="empty">
        <Clapperboard />
        <b>{loading ? 'Loading your playlists…' : 'No movies or series yet'}</b>
        <p>Movies and series episodes from your playlists show up here (Xtream /movie/ and /series/ links, .mp4/.mkv files, tvg-type, or VOD groups). Live channels stay in Live TV.</p>
      </div>
    );
  }

  const movieCard = (m: Channel) => {
    const p = progress[m.id];
    return (
      <button className="tvCard" onClick={() => setOpenMovie(m)} title={titleOf(m)}>
        <Poster src={m.logo} title={titleOf(m)} sub={m.year ? String(m.year) : undefined} progress={p?.dur ? p.pos / p.dur : undefined} watched={p?.watched} fav={favSet.has(m.id)} />
        <b>{titleOf(m)}</b>
        <small>{[m.year, m.group].filter(Boolean).join(' · ')}</small>
      </button>
    );
  };
  const showCard = (s: Show) => (
    <button className="tvCard" onClick={() => setOpenShow(s)} title={s.name}>
      <Poster src={s.logo} title={s.name} kind="series" sub={`${s.seasons.length} season${s.seasons.length === 1 ? '' : 's'}`} fav={favSet.has(s.key)} />
      <b>{s.name}</b>
      <small>{s.seasons.length} season{s.seasons.length === 1 ? '' : 's'} · {s.episodes.length} ep</small>
    </button>
  );

  return (
    <div className="tvLibrary">
      <div className="guideBar">
        <div className="chips" role="tablist" aria-label="Library">
          <button role="tab" aria-selected={tab === 'movies'} className={tab === 'movies' ? 'on' : ''} onClick={() => { setTab('movies'); setGroup(''); }}><Clapperboard /> Movies · {lib.movies.length}</button>
          <button role="tab" aria-selected={tab === 'series'} className={tab === 'series' ? 'on' : ''} onClick={() => { setTab('series'); setGroup(''); }}><Tv /> Series · {lib.shows.length}</button>
          <button role="tab" aria-selected={tab === 'mylist'} className={tab === 'mylist' ? 'on' : ''} onClick={() => setTab('mylist')}><Bookmark /> My List · {myList.length}</button>
        </div>
        <div className="tvFilters">
          <label className="tvSearch"><Search /><input className="field small" placeholder={tab === 'series' ? 'Search shows' : 'Search movies'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search library" />
            {q && <button className="icon" onClick={() => setQ('')} aria-label="Clear search"><X /></button>}
          </label>
          {tab !== 'mylist' && (
            <>
              <select className="field small" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Genre / group">
                <option value="">All genres</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select className="field small" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
                <option value="">Any year</option>
                {lib.years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="field small" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
                <option value="recent">Recently added</option>
                <option value="az">A–Z</option>
                <option value="year">Year</option>
              </select>
            </>
          )}
        </div>
      </div>

      {!query && continueRow.length > 0 && tab !== 'mylist' && (
        <section className="tvRowSection" aria-label="Continue watching">
          <h3 className="tvRowTitle"><History /> Continue watching</h3>
          <div className="tvRow">
            {continueRow.map(({ item, p }) => (
              <button key={item.id} className="tvCard wide" onClick={() => playVod(item.id)} title={`Resume ${titleOf(item)}`}>
                <Poster src={item.logo} title={item.series?.show ?? titleOf(item)} kind={item.kind === 'series' ? 'series' : 'movie'} progress={p.dur ? p.pos / p.dur : 0.02} />
                <b>{item.series ? item.series.show : titleOf(item)}</b>
                <small>{item.series ? epLabel(item) : item.year ?? ''}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === 'movies' && (movies.length
        ? <VirtualGrid label="Movies" items={movies} getKey={(m) => m.id} render={movieCard} />
        : <p className="muted">No movies match.</p>)}
      {tab === 'series' && (shows.length
        ? <VirtualGrid label="Series" items={shows} getKey={(s) => s.key} render={showCard} />
        : <p className="muted">No shows match.</p>)}
      {tab === 'mylist' && (() => {
        const shown = myList.filter((x) => !query || ('key' in x ? x.lower : lib.lower.get(x.id) ?? '').includes(query));
        return shown.length
          ? <VirtualGrid label="My List" items={shown} getKey={(x) => ('key' in x ? x.key : x.id)} render={(x) => ('key' in x ? showCard(x) : movieCard(x))} />
          : <p className="muted">Add movies and shows with ♥ or Watchlist in their details.</p>;
      })()}

      {openMovie && <MovieDetails item={openMovie} onClose={() => setOpenMovie(null)} />}
      {openShow && <ShowDetails show={openShow} onClose={() => setOpenShow(null)} />}
    </div>
  );
}
