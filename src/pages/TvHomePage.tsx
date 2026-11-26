import { useMemo } from 'react';
import { Heart, Play } from 'lucide-react';
import { useApp } from '../store/app';
import { setChannelPrefs } from '../store/channelPrefs';
import { useTv } from '../store/tv';
import { navigate } from '../app/router';
import { useOrganized, isFavorite, isOrg } from '../components/channels/useOrganized';
import { useProviderCategories } from '../components/channels/useCategories';
import { nowNext } from '../components/tv/personal';
import { ChannelMark, fmtTime, useNow } from '../components/ui';
import { AddPlaylist } from '../components/AddPlaylist';
import type { Channel } from '../types';

const nameOf = (c: Channel) => (isOrg(c) ? c.displayName : c.name);

/**
 * Dial TV home: regular TV. Continue watching, favorites, and the provider's own categories as
 * tiles (the same groups as the provider's panel: "US Sports", "USA Premium", "NFL"…).
 */
export default function TvHomePage() {
  const { live, org } = useOrganized();
  const categories = useProviderCategories(live, org);
  const favorites = useApp((s) => s.favorites);
  const lastId = useApp((s) => s.lastChannelId ?? s.currentId);
  const programs = useApp((s) => s.programs);
  const loading = useApp((s) => s.loadingSources);
  const playlistError = useApp((s) => s.playlists.find((p) => p.error)?.error);
  const personal = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const now = useNow(30_000);
  const ctx = useMemo(() => ({ programs, personal, durations }), [programs, personal, durations]);

  const last = useMemo(() => (lastId ? live.find((c) => c.id === lastId || c.memberIds.includes(lastId)) : undefined), [live, lastId]);
  const favs = useMemo(() => live.filter((c) => isFavorite(favorites, c)).slice(0, 12), [live, favorites]);

  const watch = (id: string) => { useApp.getState().tune(id); navigate('watch'); };
  const openCategory = (name: string) => { setChannelPrefs({ railGroup: `cat:${name}` }); navigate('watch'); };

  if (!live.length) {
    return (
      <div className="panel welcome">
        <h2>Welcome to Dial TV</h2>
        <p className="muted">Add your TV provider’s playlist link or Xtream login to see your channels, organized just like your provider’s categories.</p>
        {loading ? <p className="muted">Loading playlist…</p> : <AddPlaylist />}
        {playlistError && <p className="err">{playlistError}</p>}
      </div>
    );
  }

  const lastNow = last ? nowNext(last.id, now, ctx).now : undefined;
  return (
    <div className="tvHome">
      {last && (
        <button className="tvContinue" onClick={() => watch(last.id)}>
          <ChannelMark channel={last} size={56} />
          <span className="tvContinueText">
            <small>CONTINUE WATCHING</small>
            <b>{nameOf(last)}</b>
            {lastNow && <span>{lastNow.title} · until {fmtTime(lastNow.end)}</span>}
          </span>
          <span className="tvContinuePlay"><Play /></span>
        </button>
      )}

      {favs.length > 0 && (
        <section>
          <h3 className="tvHomeH"><Heart /> Favorites</h3>
          <div className="tvFavs">
            {favs.map((c) => {
              const np = nowNext(c.id, now, ctx).now;
              return (
                <button key={c.id} className="tvFav" onClick={() => watch(c.id)}>
                  <ChannelMark channel={c} size={40} />
                  <span><b>{nameOf(c)}</b>{np && <small>{np.title}</small>}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h3 className="tvHomeH">Categories</h3>
        <div className="tvCats">
          {categories.map((cat) => (
            <button key={cat.name} className="tvCat" onClick={() => openCategory(cat.name)}>
              <b>{cat.name}</b>
              <small>{cat.ids.length.toLocaleString()} Channel{cat.ids.length === 1 ? '' : 's'}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
