import { useEffect, useState } from 'react';

export type Route = 'home' | 'watch' | 'guide' | 'sports' | 'fantasy' | 'picks' | 'multiview' | 'schedule' | 'settings';
export const ROUTES: Route[] = ['home', 'watch', 'guide', 'sports', 'fantasy', 'picks', 'multiview', 'schedule', 'settings'];

function parse(): { route: Route; param?: string } {
  const [r, param] = location.hash.replace(/^#\/?/, '').split('/');
  return { route: (ROUTES as string[]).includes(r) ? (r as Route) : 'home', param: param ? decodeURIComponent(param) : undefined };
}

export function navigate(route: Route, param?: string) {
  location.hash = `#/${route}${param ? '/' + encodeURIComponent(param) : ''}`;
}

/** Replace the current route without a history entry (e.g. to drop a one-shot param). */
export function replaceRoute(route: Route, param?: string) {
  history.replaceState(history.state, '', `#/${route}${param ? '/' + encodeURIComponent(param) : ''}`);
  window.dispatchEvent(new Event('dial:route'));
}

export function useRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR((prev) => {
      const next = parse();
      return next.route === prev.route && next.param === prev.param ? prev : next;
    });
    window.addEventListener('hashchange', on);
    window.addEventListener('dial:route', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('dial:route', on);
    };
  }, []);
  return r;
}
