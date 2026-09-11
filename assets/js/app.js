/* ============================================================================
   app.js  -  router + views + live updater for Interactive Innovations
   ========================================================================== */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    config: null,
    games: [],          // from games.json, enriched with live { detail, thumb, votes }
    team: [],
    careers: [],
    gamesById: new Map(),
    ccuTimer: null,
    lastCcuUpdate: 0,
  };

  /* ---------- helpers --------------------------------------------------- */
  const compact = (n) => {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, '') + 'M';
    return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeAgo = (iso) => {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(d)) return '';
    const u = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
    for (const [label, s] of u) if (d >= s) return Math.floor(d / s) + label + ' ago';
    return 'just now';
  };

  /* ---------- animated number count-up -------------------------------- */
  const anim = new WeakMap();
  function setNum(el, value, { compact: doCompact = true } = {}) {
    if (!el) return;
    const target = Number(value) || 0;
    const from = anim.get(el) ?? target;
    if (REDUCED || from === target) {
      anim.set(el, target);
      el.textContent = doCompact ? compact(target) : target.toLocaleString();
      return;
    }
    const start = performance.now();
    const dur = 700;
    anim.set(el, target);
    function tick(now) {
      const p = Math.min(1, Math.max(0, (now - start) / dur));
      const e = 1 - Math.pow(1 - p, 3);
      const cur = Math.max(0, Math.round(from + (target - from) * e));
      el.textContent = doCompact ? compact(cur) : cur.toLocaleString();
      if (p < 1 && anim.get(el) === target) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------- reveal-on-scroll --------------------------------------- */
  const io = REDUCED ? null : new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  function reveal(root) {
    const els = $$('.reveal', root);
    if (!io) { els.forEach((el) => el.classList.add('in')); return; }
    const vh = window.innerHeight || 800;
    els.forEach((el) => {
      // anything already on/above the fold shows immediately - no wait for a scroll event
      if (el.getBoundingClientRect().top < vh * 0.95) el.classList.add('in');
      else io.observe(el);
    });
    // failsafe: never leave content invisible if the observer misbehaves
    setTimeout(() => els.forEach((el) => el.classList.add('in')), 1400);
  }

  /* ---------- data load --------------------------------------------- */
  async function loadJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  async function bootstrapData() {
    const [config, gamesFile, teamFile, careersFile] = await Promise.all([
      loadJSON('data/config.json'),
      loadJSON('data/games.json'),
      loadJSON('data/team.json'),
      loadJSON('data/careers.json'),
    ]);
    state.config = config;
    state.games = (gamesFile.games || []).map((g) => ({ ...g, detail: null, thumb: null, votes: null }));
    state.team = teamFile.team || [];
    state.careers = careersFile.roles || [];
    state.gamesById = new Map(state.games.map((g) => [g.slug, g]));
    applyConfig();
  }

  function applyConfig() {
    const c = state.config;
    document.title = `${c.studio.name} | ${c.studio.tagline}`;
    $$('[data-studio-name]').forEach((el) => (el.textContent = c.studio.name));
    $$('[data-tagline]').forEach((el) => (el.textContent = c.studio.tagline));
    $$('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
    $$('[data-est]').forEach((el) => (el.textContent = c.studio.established));
    $$('[data-logo]').forEach((el) => (el.src = c.studio.logo));
    $$('[data-tiktok]').forEach((el) => (el.href = c.socials.tiktok));
    $$('[data-discord]').forEach((el) => (el.href = c.contact.discordInvite));
  }

  /* ---------- enrich games with Roblox meta ------------------------- */
  async function ensureUniverseIds() {
    await Promise.all(state.games.map(async (g) => {
      if (g.universeId) return;
      try { g.universeId = await RBX.universeIdFor(g.placeId); } catch { /* ignore */ }
    }));
  }

  async function enrichGames() {
    await ensureUniverseIds();
    const ids = state.games.map((g) => g.universeId).filter(Boolean);
    const ttlMeta = (state.config.live.metaCacheMinutes || 60) * 60e3;
    const [details, thumbs, votes] = await Promise.all([
      RBX.gameDetails(ids, ttlMeta),
      RBX.gameThumbs(ids, ttlMeta),
      RBX.gameVotes(ids, ttlMeta),
    ]);
    for (const g of state.games) {
      g.detail = details.get(Number(g.universeId)) || g.detail;
      g.thumb = thumbs.get(Number(g.universeId)) || g.thumb;
      g.votes = votes.get(Number(g.universeId)) || g.votes;
    }
  }

  /* ---------- LIVE CCU updater -------------------------------------- */
  function studioTotals() {
    let playing = 0, visits = 0, shipped = 0;
    for (const g of state.games) {
      if (!g.detail) continue;
      shipped++;
      playing += g.detail.playing || 0;
      visits += g.detail.visits || 0;
    }
    const years = Math.max(1, new Date().getFullYear() - state.config.studio.established + 1);
    return { playing, visits, shipped, years };
  }

  function paintLiveNumbers() {
    const t = studioTotals();
    $$('[data-live="playing"]').forEach((el) => setNum(el, t.playing));
    $$('[data-live="visits"]').forEach((el) => setNum(el, t.visits));
    $$('[data-live="shipped"]').forEach((el) => setNum(el, t.shipped));
    $$('[data-live="years"]').forEach((el) => setNum(el, t.years));
    // per-game playing counts anywhere on the page
    for (const g of state.games) {
      const val = g.detail ? g.detail.playing : 0;
      $$(`[data-game-playing="${g.slug}"]`).forEach((el) => setNum(el, val));
      $$(`[data-game-visits="${g.slug}"]`).forEach((el) => setNum(el, g.detail ? g.detail.visits : 0));
    }
    const stamp = $('#ccu-stamp');
    if (stamp) stamp.textContent = 'updated just now';
    state.lastCcuUpdate = Date.now();
  }

  async function refreshCCU() {
    const ids = state.games.map((g) => g.universeId).filter(Boolean);
    if (!ids.length) return;
    const map = await RBX.livePlaying(ids);
    if (map.size) {
      for (const g of state.games) {
        const p = map.get(Number(g.universeId));
        if (typeof p === 'number' && g.detail) g.detail.playing = p;
      }
    }
    paintLiveNumbers();
  }

  function startCCU() {
    stopCCU();
    const every = (state.config.live.ccuRefreshSeconds || 45) * 1000;
    const loop = () => {
      state.ccuTimer = setTimeout(async () => {
        if (document.visibilityState === 'visible') await refreshCCU();
        loop();
      }, every);
    };
    loop();
  }
  function stopCCU() { if (state.ccuTimer) clearTimeout(state.ccuTimer); state.ccuTimer = null; }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastCcuUpdate > 15000) refreshCCU();
  });

  // relative "updated Xs ago" ticker
  setInterval(() => {
    const stamp = $('#ccu-stamp');
    if (!stamp || !state.lastCcuUpdate) return;
    const s = Math.round((Date.now() - state.lastCcuUpdate) / 1000);
    stamp.textContent = s < 5 ? 'updated just now' : `updated ${s}s ago`;
  }, 1000);

  /* ---------- shared partials ------------------------------------- */
  const liveDot = () => `<span class="dot" aria-hidden="true"></span>`;

  function playingChip(g) {
    const p = (g.detail && g.detail.playing) || 0;
    return `<span class="chip chip--live${p ? '' : ' is-idle'}">${liveDot()}<b data-game-playing="${g.slug}">${compact(p)}</b><span class="chip__unit">playing</span></span>`;
  }

  function thumbFor(g, prefer) {
    const t = g.thumb || {};
    if (prefer === 'icon') return t.icon || t.hero || '';
    return t.hero || t.icon || '';
  }

  function gameCard(g) {
    const d = g.detail || {};
    const name = d.name || titleFromSlug(g.slug);
    const img = thumbFor(g);
    const accent = g.accent || '#5B86FF';
    return `
      <a class="game-card reveal" href="#/games/${g.slug}" style="--accent:${accent}">
        <div class="game-card__media">
          ${img
            ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
            : `<div class="game-card__media-fallback"></div>`}
          <div class="game-card__media-shade"></div>
          <span class="chip chip--cat">${esc(g.category || d.genre || 'Experience')}</span>
          ${playingChip(g)}
        </div>
        <div class="game-card__body">
          <h3>${esc(name)}</h3>
          <p>${esc(shortDesc(d.description) || 'Live on Roblox.')}</p>
          <div class="game-card__meta">
            <span><b data-game-visits="${g.slug}">${compact(d.visits || 0)}</b> visits</span>
            <span class="game-card__play">Play<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          </div>
        </div>
      </a>`;
  }

  function heroGame(g) {
    const d = g.detail || {};
    const name = d.name || titleFromSlug(g.slug);
    const img = thumbFor(g);
    const accent = g.accent || '#8A5BFF';
    const ratio = g.votes && g.votes.ratio != null ? Math.round(g.votes.ratio * 100) + '%' : null;
    return `
      <a class="hero-game reveal" href="#/games/${g.slug}" style="--accent:${accent}">
        <div class="hero-game__media">
          ${img ? `<img src="${esc(img)}" alt="" decoding="async" referrerpolicy="no-referrer">` : `<div class="game-card__media-fallback"></div>`}
          <div class="hero-game__media-shade"></div>
          <span class="ribbon"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="m12 2 2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.9 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8L12 2Z"/></svg> Pinned</span>
        </div>
        <div class="hero-game__panel">
          <div class="hero-game__tags">
            <span class="chip chip--cat">${esc(g.category || d.genre || 'Experience')}</span>
            ${playingChip(g)}
          </div>
          <h3>${esc(name)}</h3>
          <p>${esc(shortDesc(d.description, 190) || 'Live on Roblox right now.')}</p>
          <div class="hero-game__stats">
            <div><b data-game-playing="${g.slug}">${compact(d.playing || 0)}</b><span>CCU</span></div>
            <div><b data-game-visits="${g.slug}">${compact(d.visits || 0)}</b><span>visits</span></div>
            <div><b>${compact(d.favorites || 0)}</b><span>faves</span></div>
            ${ratio ? `<div><b>${ratio}</b><span>rating</span></div>` : ''}
          </div>
          <span class="btn btn--primary hero-game__cta">Play now
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
      </a>`;
  }

  const titleFromSlug = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const shortDesc = (txt, max = 150) => {
    if (!txt) return '';
    const line = txt.split('\n').map((l) => l.trim()).find((l) => l.length > 12) || txt.trim();
    return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
  };

  function socialLinks(socials = {}) {
    const items = [
      ['roblox', socials.roblox, 'Roblox'],
      ['discord', socials.discord && (socials.discord.startsWith('http') ? socials.discord : null), 'Discord'],
      ['tiktok', socials.tiktok, 'TikTok'],
      ['twitter', socials.twitter, 'X'],
      ['youtube', socials.youtube, 'YouTube'],
      ['github', socials.github, 'GitHub'],
      ['website', socials.website, 'Website'],
    ].filter(([, href]) => href);
    return items.map(([key, href, label]) =>
      `<a class="soc soc--${key}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${label}" aria-label="${label}">${ICONS[key] || ICONS.website}</a>`
    ).join('');
  }

  const ICONS = {
    roblox: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.4 2 2 15.4 18.6 22 22 8.6 5.4 2Zm4.9 8.1 3.6 1-1 3.6-3.6-1 1-3.6Z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.3 5.3A17 17 0 0 0 15 4l-.3.5a13 13 0 0 1 3.8 1.9 12.7 12.7 0 0 0-11 0A13 13 0 0 1 11.3 4.5L11 4a17 17 0 0 0-4.3 1.3C3.9 9.4 3.1 13.4 3.5 17.4A17 17 0 0 0 8.7 20l.9-1.5c-.8-.3-1.6-.7-2.3-1.2l.6-.4a9 9 0 0 0 8.2 0l.6.4c-.7.5-1.5.9-2.3 1.2L15.3 20a17 17 0 0 0 5.2-2.6c.5-4.6-.7-8.6-1.2-12.1ZM9.5 15c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Zm5 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 3c.3 2.3 1.6 3.7 3.9 3.9v2.7c-1.4.1-2.6-.3-3.9-1v6.8c0 4.4-3.4 6.9-7.1 5.9-3.3-.9-4.6-4.7-2.7-7.5 1.1-1.6 3.1-2.4 5.4-2v3c-.5-.1-1-.2-1.5-.1-1.3.2-2.1 1.2-1.9 2.5.2 1.3 1.4 2 2.7 1.7 1-.3 1.6-1.1 1.6-2.3V3H16Z"/></svg>',
    twitter: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.5 3h3l-6.6 7.6L21.7 21h-6l-4.7-6.2L5.6 21H2.5l7-8L2.3 3h6.1l4.2 5.6L17.5 3Zm-1 16h1.7L7.6 4.8H5.8L16.5 19Z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M23 12s0-3.2-.4-4.7a3 3 0 0 0-2.1-2.1C18.8 4.8 12 4.8 12 4.8s-6.8 0-8.5.4a3 3 0 0 0-2.1 2.1C1 8.8 1 12 1 12s0 3.2.4 4.7a3 3 0 0 0 2.1 2.1c1.7.4 8.5.4 8.5.4s6.8 0 8.5-.4a3 3 0 0 0 2.1-2.1C23 15.2 23 12 23 12ZM9.8 15.3V8.7l5.7 3.3-5.7 3.3Z"/></svg>',
    github: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .8 0-.6.3-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7 0-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .3.3.7 1 .7 2v3c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>',
    website: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9m0-18C9.5 5.5 8.5 9 8.5 12s1 6.5 3.5 9M3.5 9h17M3.5 15h17"/></svg>',
  };

  /* ---------- views ------------------------------------------------ */
  const views = {
    home() {
      const pinned = state.games.find((g) => g.pinned)
        || state.games.find((g) => g.featured) || state.games[0];
      const rest = state.games.filter((g) => g !== pinned);
      const featRest = [...rest]
        .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
        .slice(0, 3);
      return `
      <section class="hero">
        <span class="pill reveal">${liveDot()} A Roblox studio · Est. <span data-est></span></span>
        <h1 class="reveal">Where interactive<br><span class="grad">ideas innovate.</span></h1>
        <p class="reveal lead">An investment-driven Roblox studio. We back, build, and operate immersive experiences end to end &mdash; capital paired with production so the games we touch don't just launch, they grow.</p>
        <div class="reveal cta-row">
          <a class="btn btn--primary" href="#/games">Explore our games <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
          <a class="btn btn--ghost" href="#/about">About the studio</a>
        </div>
      </section>

      <section class="reveal statbar-wrap" aria-label="Studio numbers">
        <div class="statbar">
          ${statCell('Total visits', 'visits')}
          ${statCell('Live CCU', 'playing', true)}
          ${statCell('Total games', 'shipped')}
          ${statCell('Years operating', 'years')}
        </div>
        <p class="statbar__stamp"><span class="dot" aria-hidden="true"></span> <span id="ccu-stamp">connecting…</span></p>
      </section>

      <section class="section section--tight">
        <header class="section__head reveal">
          <div><span class="eyebrow">Featured games</span><h2>Experiences we're <span class="grad">proud of.</span></h2></div>
          <a class="link-arrow" href="#/games">See all games <span aria-hidden="true">&rarr;</span></a>
        </header>
        ${pinned ? heroGame(pinned) : ''}
        <div class="game-grid game-grid--3">
          ${featRest.map((g) => gameCard(g)).join('')}
        </div>
      </section>

      <section class="section">
        <div class="cta-band reveal">
          <span class="eyebrow eyebrow--on-dark">Let's build</span>
          <h2>Have an idea? Let's build it.</h2>
          <p>Pitches, partnerships, and publishing opportunities are open. We respond personally to every serious inquiry.</p>
          <a class="btn btn--light" href="#/contact">Get in touch <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 7h10v10M7 17 17 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        </div>
      </section>`;
    },

    games() {
      const cats = ['All', ...new Set(state.games.map((g) => g.category).filter(Boolean))];
      return `
      <section class="page-head reveal">
        <span class="eyebrow">Our games</span>
        <h1>Every title we've shipped, in one place.</h1>
        <p class="lead">Live concurrent counts update in real time. Tap any title for the full briefing.</p>
        <div class="filters" role="tablist">
          ${cats.map((c, i) => `<button class="filter${i === 0 ? ' is-active' : ''}" data-filter="${esc(c)}" role="tab" aria-selected="${i === 0}">${esc(c)}</button>`).join('')}
        </div>
      </section>
      <div class="game-grid" id="games-grid">
        ${state.games.map((g) => gameCard(g)).join('')}
      </div>`;
    },

    game(slug) {
      const g = state.gamesById.get(slug);
      if (!g) return views.notFound();
      const d = g.detail || {};
      const hero = thumbFor(g);
      const placeUrl = `https://www.roblox.com/games/${g.placeId}`;
      const ratio = g.votes && g.votes.ratio != null ? Math.round(g.votes.ratio * 100) + '%' : '—';
      const descHtml = esc(d.description || 'Live on Roblox.').replace(/\n/g, '<br>');
      return `
      <a class="back-link" href="#/games"><span aria-hidden="true">&larr;</span> All games</a>
      <article class="game-detail reveal" style="--accent:${g.accent || '#5B86FF'}">
        <div class="game-detail__media">
          ${hero ? `<img src="${esc(hero)}" alt="${esc(d.name || slug)}" decoding="async" referrerpolicy="no-referrer">` : '<div class="game-card__media-fallback"></div>'}
          ${playingChip(g)}
        </div>
        <div class="game-detail__info">
          <span class="chip chip--cat">${esc(g.category || d.genre || 'Experience')}</span>
          <h1>${esc(d.name || titleFromSlug(slug))}</h1>
          <div class="stat-row">
            <div><span>Playing now</span><b data-game-playing="${g.slug}">${compact(d.playing || 0)}</b></div>
            <div><span>Total visits</span><b data-game-visits="${g.slug}">${compact(d.visits || 0)}</b></div>
            <div><span>Favorites</span><b>${compact(d.favorites || 0)}</b></div>
            <div><span>Rating</span><b>${ratio}</b></div>
          </div>
          <a class="btn btn--primary" href="${placeUrl}" target="_blank" rel="noopener noreferrer">
            Play on Roblox <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 7h10v10M7 17 17 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
        </div>
      </article>
      <section class="section grid-2">
        <div class="reveal">
          <span class="eyebrow">About the game</span>
          <p class="prose">${descHtml}</p>
        </div>
        <aside class="detail-facts reveal">
          <h3>Details</h3>
          <dl>
            <div><dt>Universe ID</dt><dd>${g.universeId || '—'}</dd></div>
            <div><dt>Place ID</dt><dd>${g.placeId}</dd></div>
            <div><dt>Genre</dt><dd>${esc(d.genre || g.category || '—')}</dd></div>
            <div><dt>Max players</dt><dd>${d.maxPlayers || '—'}</dd></div>
            <div><dt>Created</dt><dd>${d.created ? new Date(d.created).toLocaleDateString() : '—'}</dd></div>
            <div><dt>Last updated</dt><dd>${d.updated ? timeAgo(d.updated) : '—'}</dd></div>
          </dl>
        </aside>
      </section>`;
    },

    about() {
      const pillars = [
        ['Invest', 'We invest where we believe.', 'Capital paired with hands-on partnership. We back the right ideas at the right stage &mdash; a solo developer with a strong concept, or an existing experience ready to scale.'],
        ['Produce', 'We produce what we publish.', 'Engineering, design, live ops, analytics, and community. Our internal production org is the operating system underneath every title we touch.'],
        ['Compound', 'We compound what works.', 'Every win gets codified and re-applied across the portfolio. The studio gets sharper with every release.'],
      ];
      return `
      <section class="page-head reveal">
        <span class="eyebrow">About <span data-studio-name></span></span>
        <h1>An investment-driven Roblox studio.</h1>
        <p class="lead">We back, build, and operate Roblox experiences end to end. Capital from us is paired with production so the games we touch do not just launch, they grow.</p>
      </section>
      <section class="pillars">
        ${pillars.map(([tag, title, body], i) => `
          <div class="pillar reveal">
            <span class="pillar__n">0${i + 1}</span>
            <span class="chip chip--cat">${tag}</span>
            <h3>${title}</h3>
            <p>${body}</p>
          </div>`).join('')}
      </section>
      <section class="section">
        <div class="cta-band reveal">
          <span class="eyebrow eyebrow--on-dark">Let's build</span>
          <h2>Have an idea? Let's build it.</h2>
          <p>Pitches, partnerships, and publishing opportunities are open.</p>
          <a class="btn btn--light" href="#/contact">Get in touch</a>
        </div>
      </section>`;
    },

    team() {
      return `
      <section class="page-head reveal">
        <span class="eyebrow">The team</span>
        <h1>The people behind every shipped pixel.</h1>
        <p class="lead">Our leadership team. Reach out to any of us with our attached social links.</p>
      </section>
      <div class="team-grid" id="team-grid">
        ${state.team.map(teamCardSkeleton).join('')}
      </div>`;
    },

    careers() {
      const departments = ['Development Team', 'Marketing'];
      return `
      <section class="career-hero reveal">
        <span class="eyebrow">Careers at <span data-studio-name></span></span>
        <h1>Build experiences players come back to.</h1>
        <p class="lead">Join a focused, remote Roblox team building, growing, and operating games with lasting communities.</p>
        <a class="btn btn--primary" href="#/careers" data-career-scroll="open-roles">View ${state.careers.length} open roles <span aria-hidden="true">&darr;</span></a>
      </section>
      <section class="section careers-section" id="open-roles">
        <header class="section__head reveal">
          <div><span class="eyebrow">Open roles</span><h2>Find your place here.</h2></div>
          <span class="pill"><span class="dot" aria-hidden="true"></span>${state.careers.length} roles &middot; Remote</span>
        </header>
        ${departments.map((department) => `
          <div class="role-group reveal">
            <div class="role-group__head"><h3>${esc(department)}</h3><span>${state.careers.filter((role) => role.department === department).length} openings</span></div>
            <div class="role-list">
              ${state.careers.filter((role) => role.department === department).map((role, index) => roleCard(role, index)).join('')}
            </div>
          </div>`).join('')}
      </section>
      <section class="section application-wrap" id="apply">
        <div class="application-copy reveal">
          <span class="eyebrow">Apply</span>
          <h2>Let's make something great.</h2>
          <p class="lead">Tell us about yourself and the work you want to do. We review every application.</p>
        </div>
        <form class="contact-form application-form reveal" id="career-form" action="${esc(state.config.contact.formspreeEndpoint)}" method="POST">
          <input type="hidden" id="career-subject" name="_subject" value="New careers application">
          <input type="hidden" name="application_type" value="Careers application">
          <div class="field"><label for="career-role">Applying for</label><select id="career-role" name="role" required><option value="">Select a role</option>${state.careers.map((role) => `<option value="${esc(role.title)}">${esc(role.title)}</option>`).join('')}</select></div>
          <div class="form-row"><div class="field"><label for="career-name">Name</label><input id="career-name" name="name" required autocomplete="name"></div><div class="field"><label for="career-email">Email</label><input id="career-email" type="email" name="email" required autocomplete="email"></div></div>
          <div class="field"><label for="career-discord">Discord username</label><input id="career-discord" name="discord" required placeholder="username"></div>
          <div class="field"><label for="career-portfolio">Portfolio or work samples</label><input id="career-portfolio" type="url" name="portfolio" required placeholder="https://"></div>
          <div class="field"><label for="career-message">Why are you a great fit?</label><textarea id="career-message" name="message" rows="5" required></textarea></div>
          <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp">
          <button class="btn btn--primary" type="submit" id="career-submit">Submit application</button>
          <p class="form-status" id="career-status" role="status" aria-live="polite"></p>
        </form>
      </section>`;
    },

    contact() {
      const tag = state.config.contact.discordTag;
      return `
      <section class="page-head reveal">
        <span class="eyebrow">Contact</span>
        <h1>Let's talk.</h1>
        <p class="lead">Pitches, partnerships, publishing. If it's a serious Roblox idea, we want to hear it.</p>
        <p class="contact-alt">Prefer Discord? <a href="${esc(state.config.contact.discordInvite)}" target="_blank" rel="noopener noreferrer">${esc(tag)}</a></p>
      </section>
      <form class="contact-form reveal" id="contact-form" action="${esc(state.config.contact.formspreeEndpoint)}" method="POST">
        <div class="field"><label for="cf-name">Name</label><input id="cf-name" name="name" required autocomplete="name"></div>
        <div class="field"><label for="cf-email">Email</label><input id="cf-email" type="email" name="email" required autocomplete="email"></div>
        <div class="field"><label for="cf-org">Organization <span>(optional)</span></label><input id="cf-org" name="organization" autocomplete="organization"></div>
        <div class="field"><label for="cf-msg">What are you building?</label><textarea id="cf-msg" name="message" rows="5" required></textarea></div>
        <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp">
        <button class="btn btn--primary" type="submit" id="cf-submit">Send message</button>
        <p class="form-status" id="cf-status" role="status" aria-live="polite"></p>
      </form>`;
    },

    notFound() {
      return `<section class="page-head reveal"><span class="eyebrow">404</span><h1>Page not found.</h1><p class="lead"><a href="#/">Back home</a></p></section>`;
    },
  };

  function statCell(label, key, live = false) {
    return `<div class="statbar__cell">
      <span class="statbar__label">${live ? liveDot() : ''}${label}</span>
      <span class="statbar__num" data-live="${key}">0</span>
    </div>`;
  }

  function roleCard(role, index) {
    return `<article class="role-card" id="role-${esc(role.id)}">
      <button class="role-card__summary" type="button" aria-expanded="false">
        <span class="role-card__number">${String(index + 1).padStart(2, '0')}</span>
        <span class="role-card__title"><b>${esc(role.title)}</b><small>${esc(role.summary)}</small></span>
        <span class="role-card__meta"><span>${esc(role.location)}</span><span>${esc(role.type)}</span></span>
        <span class="role-card__toggle" aria-hidden="true">+</span>
      </button>
      <div class="role-card__details">
        <div><h4>What you'll do</h4><ul>${role.responsibilities.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>
        <div><h4>What you'll bring</h4><ul>${role.requirements.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>
        <a class="btn btn--primary role-apply" href="#/careers" data-career-scroll="apply" data-role="${esc(role.title)}">Apply for this role <span aria-hidden="true">&rarr;</span></a>
      </div>
    </article>`;
  }

  function teamCardSkeleton(m) {
    return `<article class="member reveal" data-user="${m.userId}">
      <div class="member__avatar skeleton"></div>
      <div class="member__body">
        <span class="member__role">${esc(m.role || '')}</span>
        <h3 class="member__name">&nbsp;</h3>
        <p class="member__handle">&nbsp;</p>
        ${m.tagline ? `<p class="member__tagline">${esc(m.tagline)}</p>` : ''}
        <div class="member__socials">${socialLinks(m.socials)}</div>
      </div>
    </article>`;
  }

  async function hydrateTeam() {
    const grid = $('#team-grid');
    if (!grid || !state.team.length) return;
    const ids = state.team.map((m) => m.userId);
    const ttl = 24 * 3600e3;
    const [profiles, heads] = await Promise.all([RBX.users(ids, ttl), RBX.userHeadshots(ids, ttl)]);
    for (const m of state.team) {
      const card = grid.querySelector(`[data-user="${m.userId}"]`);
      if (!card) continue;
      const p = profiles.get(Number(m.userId));
      const head = heads.get(Number(m.userId));
      const av = card.querySelector('.member__avatar');
      if (head) {
        const img = new Image();
        img.alt = p ? p.displayName : 'Team member';
        img.decoding = 'async';
        img.src = head;
        img.onload = () => { av.innerHTML = ''; av.appendChild(img); av.classList.remove('skeleton'); };
        img.onerror = () => av.classList.remove('skeleton');
      } else { av.classList.remove('skeleton'); }
      if (p) {
        card.querySelector('.member__name').textContent = p.displayName;
        card.querySelector('.member__handle').textContent = '@' + p.name;
      }
    }
  }

  /* ---------- games page filters ---------------------------------- */
  function wireGameFilters() {
    const bar = $('.filters');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter');
      if (!btn) return;
      $$('.filter', bar).forEach((b) => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-selected', b === btn); });
      const f = btn.dataset.filter;
      $$('#games-grid .game-card').forEach((card) => {
        const cat = card.querySelector('.chip--cat')?.textContent.trim();
        card.style.display = (f === 'All' || cat === f) ? '' : 'none';
      });
    });
  }

  /* ---------- contact form (AJAX to Formspree) ------------------- */
  function wireContactForm() {
    const form = $('#contact-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#cf-submit');
      const status = $('#cf-status');
      if (form.querySelector('.hp').value) return; // honeypot
      btn.disabled = true;
      btn.textContent = 'Sending…';
      status.textContent = '';
      status.className = 'form-status';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new FormData(form),
        });
        if (res.ok) {
          form.reset();
          status.textContent = 'Thanks — your message is in. We respond personally to every serious inquiry.';
          status.classList.add('is-ok');
          btn.textContent = 'Sent ✓';
        } else {
          const data = await res.json().catch(() => ({}));
          status.textContent = (data.errors && data.errors.map((x) => x.message).join(', ')) || 'Something went wrong. Try again or reach us on Discord.';
          status.classList.add('is-err');
          btn.disabled = false;
          btn.textContent = 'Send message';
        }
      } catch {
        status.textContent = 'Network error. Try again or reach us on Discord.';
        status.classList.add('is-err');
        btn.disabled = false;
        btn.textContent = 'Send message';
      }
    });
  }

  function wireCareers() {
    $$('[data-career-scroll]').forEach((link) => link.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(link.dataset.careerScroll)?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    }));
    $$('.role-card__summary').forEach((button) => button.addEventListener('click', () => {
      const details = button.nextElementSibling;
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      button.closest('.role-card')?.classList.toggle('is-open', !open);
      button.querySelector('.role-card__toggle').textContent = open ? '+' : '−';
    }));
    $$('.role-apply').forEach((link) => link.addEventListener('click', () => {
      const select = $('#career-role');
      if (select) select.value = link.dataset.role;
    }));
    const form = $('#career-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.querySelector('.hp').value) return;
      const btn = $('#career-submit');
      const status = $('#career-status');
      const selectedRole = $('#career-role')?.value || 'Unknown role';
      const subject = $('#career-subject');
      if (subject) subject.value = `New application: ${selectedRole}`;
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      status.textContent = '';
      status.className = 'form-status';
      try {
        const res = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new FormData(form) });
        if (!res.ok) throw new Error('Submission failed');
        form.reset();
        status.textContent = 'Application received. Thanks for taking the time to apply.';
        status.classList.add('is-ok');
        btn.textContent = 'Application sent ✓';
      } catch {
        status.textContent = 'Something went wrong. Please try again or reach us on Discord.';
        status.classList.add('is-err');
        btn.disabled = false;
        btn.textContent = 'Submit application';
      }
    });
  }

  /* ---------- router --------------------------------------------- */
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 'games' && parts[1]) return { name: 'game', slug: parts[1] };
    if (['home', 'games', 'about', 'team', 'careers', 'contact'].includes(parts[0])) return { name: parts[0] };
    return { name: 'notFound' };
  }

  function render() {
    const route = parseRoute();
    const app = $('#app');
    let html;
    if (route.name === 'game') html = views.game(route.slug);
    else html = (views[route.name] || views.notFound)();

    app.classList.add('is-leaving');
    requestAnimationFrame(() => {
      app.innerHTML = html;
      app.classList.remove('is-leaving');
      window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'instant' });
      applyConfig();
      reveal(app);
      paintLiveNumbers();
      hydrateTeam();
      wireGameFilters();
      wireContactForm();
      wireCareers();
      updateNav(route);
    });
  }

  function updateNav(route) {
    const map = { home: '#/', games: '#/games', game: '#/games', about: '#/about', team: '#/team', careers: '#/careers', contact: '#/contact' };
    const target = map[route.name];
    $$('.nav__link').forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === target));
  }

  /* ---------- nav / menu / loader ------------------------------- */
  function wireChrome() {
    const header = $('.site-header');
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = $('.nav__toggle');
    const menu = $('.nav');
    toggle?.addEventListener('click', () => {
      const open = document.body.classList.toggle('menu-open');
      toggle.setAttribute('aria-expanded', open);
    });
    menu?.addEventListener('click', (e) => {
      if (e.target.closest('a')) { document.body.classList.remove('menu-open'); toggle?.setAttribute('aria-expanded', 'false'); }
    });
  }

  function hideLoader() {
    const l = $('#loader');
    if (!l) return;
    l.classList.add('is-done');
    setTimeout(() => l.remove(), 500);
  }

  /* ---------- boot ---------------------------------------------- */
  async function main() {
    wireChrome();
    window.addEventListener('hashchange', render);

    try {
      await bootstrapData();
    } catch (e) {
      $('#app').innerHTML = `<section class="page-head"><h1>Couldn't load site data.</h1><p class="lead">${esc(e.message)}</p></section>`;
      hideLoader();
      return;
    }

    render();                 // paint shell immediately with cached / zero values
    hideLoader();

    // enrich in the background, then repaint + start the live loop
    enrichGames().catch((e) => console.warn('enrich', e)).finally(() => {
      render();
      startCCU();
    });
  }

  document.addEventListener('DOMContentLoaded', main);
})();
