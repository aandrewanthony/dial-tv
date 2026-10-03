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

export function useRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
