/* ============================================================================
   roblox.js  -  live Roblox data layer
   - resolves place -> universe
   - batch-fetches game details (name / description / playing / visits / faves)
   - batch-fetches game thumbnails + icons
   - fetches user profiles + avatar headshots
   - layered cache (memory + localStorage TTL) so views paint instantly
   - multi-proxy fallback so a single rate-limited proxy never breaks the page
   ========================================================================== */

const RBX = (() => {
  'use strict';

  // Proxies that mirror the Roblox API *with* CORS headers. Tried in order.
  // {sub} is the api subdomain (games / users / thumbnails / apis).
  const PROXIES = [
    (sub, path) => `https://${sub}.roproxy.com${path}`,
    (sub, path) => `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://${sub}.roblox.com${path}`)}`,
  ];

  const mem = new Map();

  /* ---- localStorage TTL cache ------------------------------------------- */
  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem('ii:' + key);
        if (!raw) return null;
        const { v, exp } = JSON.parse(raw);
        if (exp && Date.now() > exp) { localStorage.removeItem('ii:' + key); return null; }
        return v;
      } catch { return null; }
    },
    set(key, v, ttlMs) {
      try {
        localStorage.setItem('ii:' + key, JSON.stringify({ v, exp: ttlMs ? Date.now() + ttlMs : 0 }));
      } catch { /* quota / private mode - ignore */ }
    },
  };

  /* ---- fetch with proxy fallback + small retry ------------------------- */
  async function apiGet(sub, path, { timeout = 9000 } = {}) {
    let lastErr;
    for (const build of PROXIES) {
      const url = build(sub, path);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        clearTimeout(t);
        if (!res.ok) { lastErr = new Error(`${res.status} ${url}`); continue; }
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all proxies failed');
  }

  async function apiPost(sub, path, body, { timeout = 9000 } = {}) {
    // allorigins can't POST; only the direct-CORS proxy is used here.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`https://${sub}.roproxy.com${path}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(res.status + '');
      return await res.json();
    } finally { clearTimeout(t); }
  }

  /* ---- place -> universe --------------------------------------------------- */
  async function universeIdFor(placeId) {
    const k = 'uni:' + placeId;
    const cached = store.get(k);
    if (cached) return cached;
    const data = await apiGet('apis', `/universes/v1/places/${placeId}/universe`);
    const id = data && data.universeId;
    if (id) store.set(k, id, 30 * 24 * 3600e3);
    return id;
  }

  /* ---- game details (batched) ------------------------------------------ */
  // returns Map<universeId, detail>
  async function gameDetails(universeIds, ttlMs) {
    const ids = [...new Set(universeIds.map(Number).filter(Boolean))];
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const c = store.get('game:' + id);
      if (c) out.set(id, c); else missing.push(id);
    }
    if (missing.length) {
      try {
        const data = await apiGet('games', `/v1/games?universeIds=${missing.join(',')}`);
        for (const g of (data.data || [])) {
          const detail = {
            universeId: g.id,
            rootPlaceId: g.rootPlaceId,
            name: (g.name || '').trim(),
            description: (g.description || '').trim(),
            playing: g.playing || 0,
            visits: g.visits || 0,
            maxPlayers: g.maxPlayers || 0,
            favorites: g.favoritedCount || 0,
            created: g.created,
            updated: g.updated,
            genre: g.genre_l1 || g.genre || '',
            creator: g.creator && g.creator.name,
          };
          out.set(g.id, detail);
          store.set('game:' + g.id, detail, ttlMs);
        }
      } catch (e) { console.warn('gameDetails', e); }
    }
    return out;
  }

  /* ---- just the live player counts (cheap, frequent) ------------------- */
  // returns Map<universeId, playing>
  async function livePlaying(universeIds) {
    const ids = [...new Set(universeIds.map(Number).filter(Boolean))];
    if (!ids.length) return new Map();
    const out = new Map();
    try {
      const data = await apiGet('games', `/v1/games?universeIds=${ids.join(',')}`, { timeout: 7000 });
      for (const g of (data.data || [])) {
        out.set(g.id, g.playing || 0);
        // refresh the stored detail's playing/visits too
        const c = store.get('game:' + g.id);
        if (c) { c.playing = g.playing || 0; c.visits = g.visits || c.visits; store.set('game:' + g.id, c, 60 * 60e3); }
      }
    } catch (e) { console.warn('livePlaying', e); }
    return out;
  }

  /* ---- thumbnails + icons (batched) ---------------------------------- */
  async function gameThumbs(universeIds, ttlMs) {
    const ids = [...new Set(universeIds.map(Number).filter(Boolean))];
    const out = new Map(); // universeId -> { icon, hero }
    const missing = [];
    for (const id of ids) {
      const c = store.get('thumb:' + id);
      if (c) out.set(id, c); else missing.push(id);
    }
    if (missing.length) {
      const list = missing.join(',');
      const [icons, heroes] = await Promise.allSettled([
        apiGet('thumbnails', `/v1/games/icons?universeIds=${list}&size=512x512&format=Png&returnPolicy=PlaceHolder`),
        apiGet('thumbnails', `/v1/games/multiget/thumbnails?universeIds=${list}&size=768x432&format=Png&countPerUniverse=1&defaults=true`),
      ]);
      const iconMap = new Map();
      if (icons.status === 'fulfilled') for (const i of (icons.value.data || [])) iconMap.set(i.targetId, i.imageUrl);
      const heroMap = new Map();
      if (heroes.status === 'fulfilled') for (const h of (heroes.value.data || [])) {
        const first = (h.thumbnails || [])[0];
        if (first) heroMap.set(h.universeId, first.imageUrl);
      }
      for (const id of missing) {
        const entry = { icon: iconMap.get(id) || '', hero: heroMap.get(id) || iconMap.get(id) || '' };
        out.set(id, entry);
        if (entry.icon || entry.hero) store.set('thumb:' + id, entry, ttlMs);
      }
    }
    return out;
  }

  /* ---- game vote / like ratio (best-effort) --------------------------- */
  async function gameVotes(universeIds, ttlMs) {
    const ids = [...new Set(universeIds.map(Number).filter(Boolean))];
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const c = store.get('votes:' + id);
      if (c) out.set(id, c); else missing.push(id);
    }
    if (missing.length) {
      try {
        const data = await apiGet('games', `/v1/games/votes?universeIds=${missing.join(',')}`);
        for (const v of (data.data || [])) {
          const total = (v.upVotes || 0) + (v.downVotes || 0);
          const entry = { up: v.upVotes || 0, down: v.downVotes || 0, ratio: total ? v.upVotes / total : null };
          out.set(v.id, entry);
          store.set('votes:' + v.id, entry, ttlMs);
        }
      } catch (e) { /* votes endpoint is flaky behind proxies - fine to skip */ }
    }
    return out;
  }

  /* ---- users -------------------------------------------------------------- */
  async function users(userIds, ttlMs) {
    const ids = [...new Set(userIds.map(Number).filter(Boolean))];
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const c = store.get('user:' + id);
      if (c) out.set(id, c); else missing.push(id);
    }
    if (missing.length) {
      let got = false;
      try {
        const data = await apiPost('users', '/v1/users', { userIds: missing, excludeBannedUsers: false });
        for (const u of (data.data || [])) {
          const entry = { userId: u.id, name: u.name, displayName: u.displayName || u.name };
          out.set(u.id, entry); store.set('user:' + u.id, entry, ttlMs); got = true;
        }
      } catch { /* fall through */ }
      if (!got) {
        // per-user GET fallback
        await Promise.allSettled(missing.map(async (id) => {
          try {
            const u = await apiGet('users', `/v1/users/${id}`);
            const entry = { userId: id, name: u.name, displayName: u.displayName || u.name };
            out.set(id, entry); store.set('user:' + id, entry, ttlMs);
          } catch {
            const entry = { userId: id, name: 'user' + id, displayName: 'User ' + id };
            out.set(id, entry);
          }
        }));
      }
    }
    return out;
  }

  async function userHeadshots(userIds, ttlMs) {
    const ids = [...new Set(userIds.map(Number).filter(Boolean))];
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const c = store.get('head:' + id);
      if (c) out.set(id, c); else missing.push(id);
    }
    if (missing.length) {
      try {
        const data = await apiGet('thumbnails',
          `/v1/users/avatar-headshot?userIds=${missing.join(',')}&size=420x420&format=Png&isCircular=false`);
        for (const h of (data.data || [])) {
          if (h.imageUrl) { out.set(h.targetId, h.imageUrl); store.set('head:' + h.targetId, h.imageUrl, ttlMs); }
        }
      } catch { /* handled by fallback below */ }
      for (const id of missing) {
        if (!out.has(id)) out.set(id, `https://www.roblox.com/headshot-thumbnail/image?userId=${id}&width=420&height=420&format=png`);
      }
    }
    return out;
  }

  return {
    universeIdFor, gameDetails, livePlaying, gameThumbs, gameVotes,
    users, userHeadshots, _store: store,
  };
})();
