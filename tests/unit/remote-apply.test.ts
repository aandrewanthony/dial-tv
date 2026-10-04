import { describe, expect, it, vi } from 'vitest';
import { applyRemoteCommand, deliverRemote, setRemoteHandler, VOLUME_STEP, type RemoteCommand, type RemoteTarget } from '../../src/lib/remote';
import type { Channel } from '../../src/types';

const ch = (id: string, number: number) => ({ id, number, name: id.toUpperCase(), group: 'G', url: `http://h/${id}` }) as unknown as Channel;
const LIST = [ch('a', 2), ch('b', 4), ch('c', 7)];

function target(over: Partial<RemoteTarget> = {}) {
  const player = { togglePlay: vi.fn(), toggleMute: vi.fn(), volume: vi.fn() };
  const t: RemoteTarget = { list: LIST, currentId: 'b', prevId: 'c', tune: vi.fn(), player, toggleGuide: vi.fn(), notFound: vi.fn(), ...over };
  return { t, player };
}

describe('remote → Live TV actions', () => {
  it('channel up/down wrap like the arrow keys', () => {
    const { t } = target();
    applyRemoteCommand({ type: 'chup' }, t);
    applyRemoteCommand({ type: 'chdown' }, t);
    expect(t.tune).toHaveBeenNthCalledWith(1, 'a');
    expect(t.tune).toHaveBeenNthCalledWith(2, 'c');
    const top = target({ currentId: 'a' });
    applyRemoteCommand({ type: 'chup' }, top.t);
    expect(top.t.tune).toHaveBeenCalledWith('c');
    expect(applyRemoteCommand({ type: 'chup' }, target({ list: [] }).t)).toBe(false);
  });
  it('player controls go to the player handle', () => {
    const { t, player } = target();
    applyRemoteCommand({ type: 'play' }, t);
    applyRemoteCommand({ type: 'mute' }, t);
    applyRemoteCommand({ type: 'volup' }, t);
    applyRemoteCommand({ type: 'voldown' }, t);
    expect(player.togglePlay).toHaveBeenCalledOnce();
    expect(player.toggleMute).toHaveBeenCalledOnce();
    expect(player.volume.mock.calls).toEqual([[VOLUME_STEP], [-VOLUME_STEP]]);
    expect(applyRemoteCommand({ type: 'play' }, target({ player: null }).t)).toBe(false);
  });
  it('number, last channel, favorites tune and guide toggle', () => {
    const { t } = target();
    expect(applyRemoteCommand({ type: 'number', value: '7' }, t)).toBe(true);
    expect(t.tune).toHaveBeenLastCalledWith('c');
    expect(applyRemoteCommand({ type: 'number', value: '99' }, t)).toBe(false);
    expect(t.notFound).toHaveBeenCalledWith('99');
    applyRemoteCommand({ type: 'last' }, t);
    expect(t.tune).toHaveBeenLastCalledWith('c');
    expect(applyRemoteCommand({ type: 'last' }, target({ prevId: undefined }).t)).toBe(false);
    expect(applyRemoteCommand({ type: 'tune', id: 'a' }, t)).toBe(true);
    expect(t.tune).toHaveBeenLastCalledWith('a');
    expect(applyRemoteCommand({ type: 'tune', id: 'not-in-lineup' }, t)).toBe(false);
    applyRemoteCommand({ type: 'guide' }, t);
    expect(t.toggleGuide).toHaveBeenCalledOnce();
  });
  it('queues commands until Live TV is open, then runs them in order', () => {
    const open = vi.fn();
    deliverRemote({ type: 'chup' }, open);
    deliverRemote({ type: 'number', value: '4' }, open);
    expect(open).toHaveBeenCalledTimes(2);
    const seen: RemoteCommand[] = [];
    const off = setRemoteHandler((c) => seen.push(c));
    expect(seen).toEqual([{ type: 'chup' }, { type: 'number', value: '4' }]);
    deliverRemote({ type: 'mute' }, open);
    expect(seen).toHaveLength(3);
    expect(open).toHaveBeenCalledTimes(2);
    // A Live TV kept mounted while another page loads must not take commands.
    deliverRemote({ type: 'guide' }, open, false);
    expect(seen).toHaveLength(3);
    expect(open).toHaveBeenCalledTimes(3);
    off();
    deliverRemote({ type: 'play' }, open);
    expect(seen).toHaveLength(3);
    const late: RemoteCommand[] = [];
    setRemoteHandler((c) => late.push(c))();
    expect(late).toEqual([{ type: 'guide' }, { type: 'play' }]);
  });
});
