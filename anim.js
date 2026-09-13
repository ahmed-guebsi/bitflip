// Motion layer for the datasheet.
//   data-reveal="up|pop|left|right|wipe|scale"   entrance, scroll-driven
//   data-count                                   roll the first number up on first sight
//   data-glitch                                  bitflip scramble on hover
//   data-type                                    type the text out on first sight
//
// Entrances are SCROLL-LINKED, not animated: each element's offset and opacity are a
// pure function of its rect. This host freezes the document animation clock when the
// frame is idle, so neither time-based keyframes nor animation-timeline: view() advance
// reliably (view() reports as supported and then sits at its authored state) — but
// scroll events and DOM writes do work.
//
// Scheduling: every input (scroll, resize, mutation, view switch) funnels into ONE
// rAF-coalesced tick. There is no free-running rAF loop and no 80 ms interval — those
// cost a getBoundingClientRect per tracked element per frame, forever, which is the
// most expensive thing that can be done to a mid-range phone. An IntersectionObserver
// decides which elements are near enough to the viewport to be worth measuring at all,
// and each tick reads every rect before it writes any style, so one reflow covers the lot.
//
// The invariant that keeps content safe is unchanged: inline styles are only ever set on
// elements BELOW the fold, and are removed the moment one is in view. A stalled tick can
// therefore only ever leave an off-screen element offset.
(function () {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = mq.matches;
  const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // eased 1 -> 0 travel for each entrance kind
  const KIND = {
    up:    k => 'translateY(' + (34 * k).toFixed(2) + 'px)',
    pop:   k => 'translateY(' + (26 * k).toFixed(2) + 'px) scale(' + (1 - 0.028 * k).toFixed(4) + ')',
    left:  k => 'translateX(' + (-38 * k).toFixed(2) + 'px)',
    right: k => 'translateX(' + (38 * k).toFixed(2) + 'px)',
    scale: k => 'scale(' + (1 - 0.015 * k).toFixed(4) + ')'
  };

  // A 38 px horizontal entrance is nothing inside a 96 px desktop gutter and a
  // horizontal scrollbar inside a 20 px phone gutter: an armed element below the fold
  // really is 38 px wider than the viewport until it settles. Below the stacking
  // breakpoint the side entrances become the vertical one, which cannot overflow a
  // page that already scrolls that way.
  let narrow = innerWidth < 760;
  function kindFn(name) {
    if (narrow && (name === 'left' || name === 'right')) return KIND.up;
    return KIND[name] || KIND.up;
  }

  const seen = new WeakSet();
  const active = new Set();   // near the viewport: measured on every tick
  const waiting = new Set();  // counters / type-ons that have not fired yet

  // ---------------------------------------------------------------- scheduler
  let frameQueued = false;
  function schedule() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(tick);
  }

  function tick() {
    frameQueued = false;
    if (document.visibilityState === 'hidden') return;
    rail();
    sweep();
    stepAll();
  }

  // ---------------------------------------------------------------- entrances
  // One observer decides membership of `active`. Elements far below the fold are never
  // measured, so per-tick cost tracks what is on screen, not what is in the document.
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (e.isIntersecting) active.add(e.target);
      else { step(e.target); active.delete(e.target); }
    }
    schedule();
  }, { rootMargin: '100% 0px 100% 0px', threshold: 0 }) : null;

  function reveal(el) {
    if (reduce) return;
    // grid and flex peers share a scroll position, so they need an index offset to
    // arrive one after another rather than all together
    let i = 0, n = 0;
    if (el.parentElement) {
      const peers = el.parentElement.children;
      for (let k = 0; k < peers.length; k++) {
        const c = peers[k];
        if (c === el) { i = n; break; }
        if (c.hasAttribute && c.hasAttribute('data-reveal')) n++;
      }
    }
    el._mmvI = i;
    if (io) io.observe(el); else active.add(el);
    step(el);
  }

  function settle(el) {
    if (!el._mmvOn) return;
    el._mmvOn = false;
    el.style.removeProperty('will-change');
    el.style.removeProperty('clip-path');
    // restore the AUTHORED inline values, not blank: several elements are authored at
    // a reduced opacity and would brighten if the property were simply removed
    const au = el._mmvAuthored;
    if (au && au.transform) el.style.setProperty('transform', au.transform);
    else el.style.removeProperty('transform');
    if (au && au.opacity) el.style.setProperty('opacity', au.opacity);
    else el.style.removeProperty('opacity');
  }

  // read phase: touches no styles, so the whole set costs one reflow
  function measure(el, vh) {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const span = vh * 0.30 * (1 + el._mmvI * 0.22);
    let p = (vh - r.top) / span;
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    return { p: p, settled: p >= 1 || r.top < vh * 0.68 };
  }

  // write phase
  function apply(el, m) {
    if (m.settled) { settle(el); return; }
    if (!el._mmvAuthored) el._mmvAuthored = { transform: el.style.transform, opacity: el.style.opacity };
    const base = parseFloat(el._mmvAuthored.opacity || '1') || 1;
    el._mmvOn = true;
    const e = 1 - Math.pow(m.p, 2.2);          // remaining travel, eased out
    el.style.willChange = 'transform, opacity';
    el.style.opacity = (base * (0.06 + 0.94 * Math.pow(m.p, 0.55))).toFixed(3);
    if (el.getAttribute('data-reveal') === 'wipe') {
      el.style.clipPath = 'inset(0 ' + (100 * e).toFixed(2) + '% 0 0)';
      el.style.removeProperty('transform');
    } else {
      el.style.transform = kindFn(el.getAttribute('data-reveal'))(e);
    }
  }

  function step(el) {
    if (!el.isConnected) { active.delete(el); return; }
    const m = measure(el, innerHeight);
    if (m) apply(el, m);
  }

  function stepAll() {
    if (!active.size) return;
    const vh = innerHeight;
    const reads = [];
    const drop = [];
    active.forEach(function (el) {
      const m = measure(el, vh);
      if (!m) { drop.push(el); return; }
      reads.push([el, m]);
    });
    for (let i = 0; i < drop.length; i++) { active.delete(drop[i]); if (io) io.unobserve(drop[i]); }
    for (let i = 0; i < reads.length; i++) apply(reads[i][0], reads[i][1]);
  }

  // ---------------------------------------------------------------- number roll-up
  // preserves prefix, suffix, grouping and decimal places
  function count(el) {
    const raw = el.dataset._raw || el.textContent;
    el.dataset._raw = raw;
    if (reduce) return;
    const m = raw.match(/-?\d[\d  ]*(?:\.\d+)?/);
    if (!m) return;
    const numText = m[0];
    const target = parseFloat(numText.replace(/[  ]/g, ''));
    if (!isFinite(target)) return;
    const dec = (numText.split('.')[1] || '').length;
    const grouped = /[  ]/.test(numText);
    const pre = raw.slice(0, m.index), post = raw.slice(m.index + numText.length);
    const dur = 900, t0 = performance.now();
    const fmt = function (v) {
      let s = v.toFixed(dec);
      if (grouped) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); s = p.join('.'); }
      return s;
    };
    // The number is the point of the receipt, so it is never allowed to be left mid-roll.
    // Progress is measured off performance.now() inside the callback rather than the
    // frame timestamp handed in: the two come from different clocks in this host and can
    // arrive out of order, and an unclamped negative p cubes into a huge negative
    // multiplier that renders as "-19443.3 mV RMS". A wall-clock timer then guarantees
    // the true value lands even if the frame loop is frozen and never ticks at all.
    const frame = function () {
      if (!el.isConnected || el._mmvDone) return;
      const p = Math.min(1, Math.max(0, (performance.now() - t0) / dur));
      // p === 0 means the clock has not moved yet; leave the true figure on screen
      // rather than writing a zero that a frozen frame loop would then never clear
      if (p > 0) el.textContent = pre + fmt(target * (1 - Math.pow(1 - p, 3))) + post;
      if (p < 1) requestAnimationFrame(frame);
      else { el._mmvDone = true; el.textContent = raw; }
    };
    requestAnimationFrame(frame);
    setTimeout(function () {
      if (!el._mmvDone && el.isConnected) { el._mmvDone = true; el.textContent = raw; }
    }, dur + 160);
  }

  // ---------------------------------------------------------------- monospace type-on
  function type(el) {
    const raw = el.dataset._raw || el.textContent;
    el.dataset._raw = raw;
    if (reduce) return;
    let i = 0;
    const frame = function () {
      if (!el.isConnected) { el.textContent = raw; return; }
      el.textContent = raw.slice(0, i);
      if (i++ <= raw.length) setTimeout(frame, 18); else el.textContent = raw;
    };
    frame();
  }

  // ---------------------------------------------------------------- bitflip scramble
  const GLYPHS = '0123456789ABCDEF';
  function glitch(el) {
    if (el._g || reduce) return;
    const raw = el.textContent;
    let n = 0;
    el._g = setInterval(function () {
      if (n++ > 6 || !el.isConnected) { clearInterval(el._g); el._g = null; el.textContent = raw; return; }
      el.textContent = raw.split('').map(function (c) {
        return c.trim() && Math.random() < 0.45 ? GLYPHS[(Math.random() * 16) | 0] : c;
      }).join('');
    }, 42);
  }

  // counters and type-ons need a JS trigger, so they wait for first sight
  function sweep() {
    if (!waiting.size) return;
    const line = innerHeight * 0.94;
    const fire = [];
    const drop = [];
    waiting.forEach(function (el) {
      if (!el.isConnected) { drop.push(el); return; }
      if (el.getBoundingClientRect().top < line) fire.push(el);
    });
    for (let i = 0; i < drop.length; i++) waiting.delete(drop[i]);
    for (let i = 0; i < fire.length; i++) {
      const el = fire[i];
      waiting.delete(el);
      if (el.hasAttribute('data-count')) count(el);
      if (el.hasAttribute('data-type')) type(el);
    }
  }

  // ---------------------------------------------------------------- scanning
  const SEL = '[data-reveal],[data-count],[data-type],[data-glitch]';

  function adopt(el) {
    if (seen.has(el)) return;
    seen.add(el);
    if (canHover && !reduce && el.hasAttribute('data-glitch')) {
      const host = el.closest('[data-glitch-host]') || el;
      host.addEventListener('pointerenter', function () { glitch(el); });
    }
    if (el.hasAttribute('data-reveal')) reveal(el);
    if (el.hasAttribute('data-count') || el.hasAttribute('data-type')) waiting.add(el);
  }

  function scan(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    if (root.matches && root.matches(SEL)) adopt(root);
    const list = root.querySelectorAll ? root.querySelectorAll(SEL) : [];
    for (let i = 0; i < list.length; i++) adopt(list[i]);
  }

  // React commits a view switch as a burst of insertions; coalesce them into one scan
  let pending = null;
  const mo = new MutationObserver(function (muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (!pending) pending = [];
        pending.push(n);
      }
    }
    if (!pending) return;
    railDirty = true;
    requestAnimationFrame(function () {
      const q = pending; pending = null;
      if (q) for (const n of q) if (n.isConnected) scan(n);
      schedule();
    });
  });

  // ---------------------------------------------------------------- WS2812B rail
  // driven here rather than from the component, because the DC's componentDidMount
  // fires before the template's DOM exists
  let segs = null, railDirty = true, lastStep = -1;
  function rail() {
    if (railDirty) { segs = document.querySelectorAll('[data-seg]'); railDirty = false; }
    if (!segs || !segs.length) return;
    const el = document.scrollingElement || document.documentElement;
    const max = el.scrollHeight - el.clientHeight;
    const p = max < 200 ? 0 : Math.min(1, Math.max(0, el.scrollTop / max));
    const lit = Math.min(8, Math.floor(p * 8 + 0.0001));
    const full = p > 0.985;
    const stepN = lit * 2 + (full ? 1 : 0);
    if (stepN === lastStep) return;
    lastStep = stepN;
    const col = full ? '#E0B33A' : '#A94BCC';
    const glow = full ? '0 0 10px rgba(224,179,58,0.55)' : '0 0 10px rgba(169,75,204,0.5)';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const on = (+seg.getAttribute('data-seg')) < lit || full;
      seg.style.background = on ? col : '#1c1626';
      seg.style.boxShadow = on ? glow : 'none';
    }
  }

  // the component calls this after a view switch: the DOM has just been replaced and no
  // scroll event is delivered for a programmatic scroll reset
  window.__mmvRefresh = function () {
    railDirty = true; lastStep = -1;
    scan(document);
    schedule();
    setTimeout(function () { railDirty = true; lastStep = -1; scan(document); schedule(); }, 140);
  };
  window.__mmvRail = function (force) { if (force) { railDirty = true; lastStep = -1; } schedule(); };

  // ---------------------------------------------------------------- wiring
  document.addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', function () { narrow = innerWidth < 760; railDirty = true; schedule(); }, { passive: true });
  addEventListener('orientationchange', function () { narrow = innerWidth < 760; railDirty = true; lastStep = -1; schedule(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') schedule();
  });

  // safety net for frames this host delivers no scroll event for: two ticks a second,
  // skipped entirely when the tab is hidden or there is nothing left to settle
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    if (!active.size && !waiting.size && lastStep >= 0) return;
    schedule();
  }, 500);

  function onMotionPrefChange() {
    reduce = mq.matches;
    if (!reduce) return;
    active.forEach(settle);
    active.clear();
    waiting.forEach(function (el) { if (el.dataset._raw) el.textContent = el.dataset._raw; });
    waiting.clear();
  }
  if (mq.addEventListener) mq.addEventListener('change', onMotionPrefChange);
  else if (mq.addListener) mq.addListener(onMotionPrefChange);

  function boot() {
    scan(document);
    mo.observe(document.body, { childList: true, subtree: true });
    schedule();
    addEventListener('load', schedule, { once: true });
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
