// <scope-plot kind="fft|tail|discharge|hist|trace|infer"> — instrument captures drawn from deterministic data.
(function () {
  const C = {
    // #6E6579 sat at 3.5:1 on the plot ground; every axis label and caption drawn in it
    // was below AA. Same hue, 5.0:1.
    ground: '#0B0910', surface: '#141019', ink: '#EDE7F2', muted: '#857D91',
    accent: '#A94BCC', signal: '#E0B33A', warn: '#D9552A', grid: '#241d2e'
  };
  const MONO = '"IBM Plex Mono", ui-monospace, monospace';

  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  // a canvas is opaque to assistive tech; each capture states what it shows
  const ALT = {
    fft: 'FFT of the ADC noise floor, with mains harmonics at 60 Hz and above',
    tail: 'latency percentile curves, blocking build against the state-machine build',
    discharge: 'battery discharge curves, deep sleep against always-on',
    hist: 'loop-period histogram with the jitter tail past 1006 microseconds',
    trace: 'two-channel scope trace, piezo impact to servo drive',
    infer: 'per-window classifier confidence against the withheld verdict band'
  };

  class ScopePlot extends HTMLElement {
    connectedCallback() {
      if (!this._built) {
        this._built = true;
        this.style.display = 'block';
        this.style.position = 'relative';
        this.style.width = '100%';
        this.style.height = '100%';
        // the x-import host forwards only positioning properties to the wrapper, so the
        // authored 1px frame around every capture has to be restored from in here
        this.style.border = '1px solid ' + C.grid;
        this.style.boxSizing = 'border-box';
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%';
        this.canvas.setAttribute('role', 'img');
        this.appendChild(this.canvas);
        this.prog = 1;
      }
      const cap = this.getAttribute('caption');
      const kind = this.getAttribute('kind') || 'fft';
      this.canvas.setAttribute('aria-label', (cap ? cap + ' — ' : '') + (ALT[kind] || 'instrument capture'));

      // one rAF-coalesced redraw per resize burst, and draw() itself no-ops when the
      // box has not actually changed
      this._ro = new ResizeObserver(() => this.queueDraw());
      this._ro.observe(this);
      this.queueDraw();

      // IntersectionObserver rather than a document scroll listener: six plots on the
      // home sheet meant six getBoundingClientRect calls on every scroll event
      if (!this._swept && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this._vo = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (!e.isIntersecting || this._swept) continue;
            this._swept = true;
            if (this._vo) { this._vo.disconnect(); this._vo = null; }
            this.sweep();
          }
        }, { rootMargin: '0px 0px -6% 0px', threshold: 0 });
        this._vo.observe(this);
      }
    }

    disconnectedCallback() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._vo) { this._vo.disconnect(); this._vo = null; }
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._drawRaf) { cancelAnimationFrame(this._drawRaf); this._drawRaf = 0; }
    }

    queueDraw() {
      if (this._drawRaf) return;
      this._drawRaf = requestAnimationFrame(() => { this._drawRaf = 0; this.draw(); });
    }

    // The trace writes itself on, left to right, like a scope sweeping. Progress comes
    // from performance.now() inside the callback, not the frame timestamp: the two are
    // different clocks in this host, and a negative t raises a negative base to 2.2,
    // yielding NaN — which turns every following canvas op into a silent no-op and
    // leaves the capture blank. A wall-clock timer finishes the sweep even if the frame
    // loop stalls, because a half-drawn capture is worse than no animation.
    sweep() {
      this.prog = 0;
      const t0 = performance.now(), dur = 1050;
      const step = () => {
        this._raf = 0;
        if (!this.isConnected) { this.prog = 1; return; }
        const t = Math.min(1, Math.max(0, (performance.now() - t0) / dur));
        this.prog = 1 - Math.pow(1 - t, 2.2);
        this.paint();
        if (t < 1) this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
      setTimeout(() => {
        if (this.prog < 1) { this.prog = 1; this.paint(); }
      }, dur + 200);
    }

    paint() {
      const g = this._g, off = this._off, b = this._b;
      if (!g || !off) return;
      const w = this._w, h = this._h, prog = this.prog;
      g.clearRect(0, 0, w, h);
      if (prog >= 1 || !b) { g.drawImage(off, 0, 0, w, h); return; }
      const edge = b.x + b.w * prog;
      g.save();
      g.beginPath(); g.rect(0, 0, edge, h); g.clip();
      g.drawImage(off, 0, 0, w, h);
      g.restore();
      g.strokeStyle = 'rgba(224,179,58,0.85)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(edge, b.y); g.lineTo(edge, b.y + b.h); g.stroke();
      g.fillStyle = 'rgba(224,179,58,0.10)';
      g.fillRect(Math.max(b.x, edge - 26), b.y, Math.min(26, edge - b.x), b.h);
    }

    draw() {
      const w = this.clientWidth, h = this.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const kind0 = this.getAttribute('kind') || 'fft';
      // a ResizeObserver fires on every layout pass that touches this element, most of
      // which leave the box exactly as it was; re-rasterising the whole capture for
      // those is the difference between a smooth window resize and a stuttering one
      if (this._w === w && this._h === h && this._dpr === dpr && this._kind === kind0) {
        this.paint();
        return;
      }
      this._dpr = dpr; this._kind = kind0;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
      this._g = this.canvas.getContext('2d');
      this._g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = w; this._h = h;
      const off = this._off = this._off || document.createElement('canvas');
      off.width = w * dpr; off.height = h * dpr;
      const g = off.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const kind = kind0;
      const pad = { l: 52, r: 14, t: 16, b: 30 };
      const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
      if (box.w < 40 || box.h < 30) return;
      (this['p_' + kind] || this.p_fft).call(this, g, box);
      this.paint();
    }

    frame(g, b, opts) {
      this._b = b;
      const { xTicks, yTicks, xLabel, yLabel } = opts;
      g.fillStyle = C.ground; g.fillRect(b.x, b.y, b.w, b.h);
      g.strokeStyle = C.grid; g.lineWidth = 1;
      g.font = '10px ' + MONO; g.fillStyle = C.muted;
      yTicks.forEach(t => {
        const y = Math.round(b.y + b.h - t.p * b.h) + 0.5;
        g.beginPath(); g.moveTo(b.x, y); g.lineTo(b.x + b.w, y); g.stroke();
        g.textAlign = 'right'; g.textBaseline = 'middle';
        g.fillText(t.label, b.x - 8, y);
      });
      xTicks.forEach(t => {
        const x = Math.round(b.x + t.p * b.w) + 0.5;
        g.beginPath(); g.moveTo(x, b.y); g.lineTo(x, b.y + b.h); g.stroke();
        g.textAlign = 'center'; g.textBaseline = 'top';
        g.fillText(t.label, x, b.y + b.h + 8);
      });
      g.strokeStyle = '#332a3f';
      g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      g.fillStyle = C.muted; g.font = '9px ' + MONO;
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.save(); g.translate(b.x - 40, b.y); g.rotate(-Math.PI / 2);
      g.textAlign = 'right'; g.fillText(yLabel, 0, 0); g.restore();
      g.textAlign = 'right'; g.textBaseline = 'top';
      g.fillText(xLabel, b.x + b.w, b.y + b.h + 20);
    }

    trace(g, pts, color, width) {
      g.strokeStyle = color; g.lineWidth = width || 1.25;
      g.lineJoin = 'round'; g.beginPath();
      pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      g.stroke();
    }

    tag(g, x, y, text, color) {
      g.font = '10px ' + MONO; const wd = g.measureText(text).width + 10;
      const b = this._b;
      if (b) {
        x = Math.min(Math.max(x, b.x + 4), b.x + b.w - wd - 4);
        y = Math.min(Math.max(y, b.y + 11), b.y + b.h - 11);
      }
      g.fillStyle = 'rgba(11,9,16,0.9)'; g.fillRect(x, y - 7, wd, 15);
      g.strokeStyle = color; g.lineWidth = 1; g.strokeRect(x + 0.5, y - 6.5, wd - 1, 14);
      g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(text, x + 5, y + 1);
    }

    // 1 — FFT of ADC noise floor
    p_fft(g, b) {
      this.frame(g, b, {
        xLabel: 'Hz', yLabel: 'dBV',
        xTicks: [{ p: 0, label: '0' }, { p: 0.25, label: '125' }, { p: 0.5, label: '250' }, { p: 0.75, label: '375' }, { p: 1, label: '500' }],
        yTicks: [{ p: 0, label: '-110' }, { p: 0.33, label: '-90' }, { p: 0.66, label: '-70' }, { p: 1, label: '-50' }]
      });
      const r = rng(7), N = 300, pts = [];
      const toY = db => b.y + b.h - ((db + 110) / 60) * b.h;
      for (let i = 0; i < N; i++) {
        const f = (i / (N - 1)) * 500;
        let db = -101 + (r() - 0.5) * 7 - f * 0.004;
        [60, 120, 180, 240, 300].forEach((hf, k) => {
          const amp = [52, 30, 19, 11, 7][k];
          db += amp * Math.exp(-Math.pow((f - hf) / 3.2, 2));
        });
        pts.push([b.x + (i / (N - 1)) * b.w, toY(db)]);
      }
      this.trace(g, pts, C.accent, 1.15);
      const y60 = toY(-49);
      g.setLineDash([3, 3]); g.strokeStyle = C.signal; g.lineWidth = 1;
      g.beginPath(); g.moveTo(b.x, y60); g.lineTo(b.x + b.w, y60); g.stroke(); g.setLineDash([]);
      this.tag(g, b.x + b.w * 0.13, y60 - 14, '60.0 Hz  -49 dBV', C.signal);
      this.tag(g, b.x + b.w * 0.52, toY(-101) - 16, 'floor 1.8 mV RMS', C.muted);
    }

    // 2 — latency tail
    p_tail(g, b) {
      this.frame(g, b, {
        xLabel: 'percentile', yLabel: 'ms',
        xTicks: [{ p: 0, label: 'p50' }, { p: 0.3, label: 'p90' }, { p: 0.6, label: 'p99' }, { p: 0.82, label: 'p99.9' }, { p: 1, label: 'max' }],
        yTicks: [{ p: 0, label: '0' }, { p: 0.25, label: '4' }, { p: 0.5, label: '8' }, { p: 0.75, label: '12' }, { p: 1, label: '16' }]
      });
      const toY = ms => b.y + b.h - (ms / 16) * b.h;
      const mk = arr => arr.map(([p, ms]) => [b.x + p * b.w, toY(ms)]);
      const blocking = mk([[0, 2.1], [0.3, 3.4], [0.6, 7.8], [0.82, 12.6], [1, 15.1]]);
      const clean = mk([[0, 0.9], [0.3, 1.1], [0.6, 1.6], [0.82, 2.4], [1, 3.1]]);
      this.trace(g, blocking, C.warn, 1.5);
      this.trace(g, clean, C.signal, 1.8);
      [blocking, clean].forEach((s, i) => s.forEach(p => {
        g.fillStyle = i ? C.signal : C.warn;
        const cx = Math.min(p[0], b.x + b.w - 3.4);
        g.beginPath(); g.arc(cx, p[1], 2.4, 0, 6.284); g.fill();
      }));
      this.tag(g, b.x + b.w * 0.30, toY(13.6), 'delay() build  15.1 ms', C.warn);
      this.tag(g, b.x + b.w * 0.30, toY(3.4), 'state machine  3.1 ms', C.signal);
    }

    // 3 — battery discharge
    p_discharge(g, b) {
      this.frame(g, b, {
        xLabel: 'days', yLabel: 'V',
        xTicks: [{ p: 0, label: '0' }, { p: 0.25, label: '30' }, { p: 0.5, label: '60' }, { p: 0.75, label: '90' }, { p: 1, label: '120' }],
        yTicks: [{ p: 0, label: '3.2' }, { p: 0.33, label: '3.5' }, { p: 0.66, label: '3.8' }, { p: 1, label: '4.1' }]
      });
      const toY = v => b.y + b.h - ((v - 3.2) / 0.9) * b.h;
      const toX = d => b.x + (d / 120) * b.w;
      const curve = (days, seed) => {
        const r = rng(seed), pts = [];
        for (let i = 0; i <= 120; i++) {
          const t = i / 120;
          const v = 4.09 - 0.30 * Math.pow(Math.min(1, (i / days)), 0.55) - 0.55 * Math.pow(Math.min(1, i / days), 6.5) + (r() - 0.5) * 0.006;
          pts.push([toX(i), toY(Math.max(3.21, v))]);
          if (i / days >= 1) break;
        }
        return pts;
      };
      this.trace(g, curve(11, 3), C.warn, 1.4);
      this.trace(g, curve(112, 11), C.signal, 1.7);
      g.setLineDash([2, 4]); g.strokeStyle = C.grid;
      g.beginPath(); g.moveTo(b.x, toY(3.4)); g.lineTo(b.x + b.w, toY(3.4)); g.stroke(); g.setLineDash([]);
      this.tag(g, toX(6), toY(3.62), 'always-on  11 d', C.warn);
      this.tag(g, toX(52), toY(3.86), 'deep sleep 14 uA  112 d', C.signal);
    }

    // 4 — loop-period histogram
    p_hist(g, b) {
      this.frame(g, b, {
        xLabel: 'us', yLabel: 'count',
        xTicks: [{ p: 0, label: '990' }, { p: 0.33, label: '1000' }, { p: 0.66, label: '1010' }, { p: 1, label: '1020' }],
        yTicks: [{ p: 0, label: '0' }, { p: 0.5, label: '3k' }, { p: 1, label: '6k' }]
      });
      const bins = 60, r = rng(23);
      const vals = [];
      for (let i = 0; i < bins; i++) {
        const us = 990 + (i / (bins - 1)) * 30;
        let c = 6000 * Math.exp(-Math.pow((us - 1000) / 1.9, 2));
        if (us > 1004) c += 180 * Math.exp(-(us - 1004) / 7) * (0.7 + r() * 0.6);
        vals.push(c);
      }
      const bw = b.w / bins;
      vals.forEach((c, i) => {
        const hh = Math.max(0, (c / 6200) * b.h);
        const x = b.x + i * bw;
        g.fillStyle = (990 + (i / (bins - 1)) * 30) > 1006 ? C.warn : C.accent;
        g.fillRect(x + 0.6, b.y + b.h - hh, Math.max(1, bw - 1.2), hh);
      });
      this.tag(g, b.x + b.w * 0.40, b.y + 14, 'sigma 1.9 us  n=98304', C.signal);
      this.tag(g, b.x + b.w * 0.62, b.y + b.h - 46, 'jitter tail 0.06%', C.warn);
    }

    // 5 — scope trace: trigger to actuation
    p_trace(g, b) {
      this.frame(g, b, {
        xLabel: 'ms', yLabel: 'ch',
        xTicks: [{ p: 0, label: '0' }, { p: 0.25, label: '5' }, { p: 0.5, label: '10' }, { p: 0.75, label: '15' }, { p: 1, label: '20' }],
        yTicks: [{ p: 0.2, label: 'CH2' }, { p: 0.75, label: 'CH1' }]
      });
      const toX = ms => b.x + (ms / 20) * b.w;
      const lane = (p, amp) => ({ base: b.y + b.h - p * b.h, amp });
      const c1 = lane(0.75, b.h * 0.16), c2 = lane(0.2, b.h * 0.14);
      const r = rng(5), p1 = [];
      for (let ms = 0; ms <= 20; ms += 0.05) {
        const v = ms < 3 ? (r() - 0.5) * 0.06 : Math.exp(-(ms - 3) / 2.4) * Math.sin((ms - 3) * 9) * 0.95;
        p1.push([toX(ms), c1.base - v * c1.amp]);
      }
      this.trace(g, p1, C.accent, 1.3);
      const p2 = [];
      for (let ms = 0; ms <= 20; ms += 0.05) {
        const hi = ms > 9.4 && (((ms - 9.4) % 1.2) < 0.6);
        p2.push([toX(ms), c2.base - (hi ? 1 : 0) * c2.amp]);
      }
      this.trace(g, p2, C.signal, 1.5);
      g.setLineDash([3, 3]); g.strokeStyle = C.muted; g.lineWidth = 1;
      [3, 9.4].forEach(ms => { g.beginPath(); g.moveTo(toX(ms), b.y); g.lineTo(toX(ms), b.y + b.h); g.stroke(); });
      g.setLineDash([]);
      g.strokeStyle = C.signal; g.beginPath();
      const ay = b.y + b.h * 0.5;
      g.moveTo(toX(3), ay); g.lineTo(toX(9.4), ay); g.stroke();
      this.tag(g, toX(3.4), ay - 14, 'slap -> servo  6.4 ms', C.signal);
    }

    // 6 — on-device inference: confidence vs verdict band
    p_infer(g, b) {
      this.frame(g, b, {
        xLabel: 'window #', yLabel: 'p(lie)',
        xTicks: [{ p: 0, label: '0' }, { p: 0.33, label: '400' }, { p: 0.66, label: '800' }, { p: 1, label: '1200' }],
        yTicks: [{ p: 0, label: '0.0' }, { p: 0.5, label: '0.5' }, { p: 1, label: '1.0' }]
      });
      const bandTop = b.y + b.h - 0.72 * b.h, bandBot = b.y + b.h - 0.28 * b.h;
      g.fillStyle = 'rgba(110,101,121,0.16)';
      g.fillRect(b.x + 1, bandTop, b.w - 2, bandBot - bandTop);
      g.font = '10px ' + MONO; g.fillStyle = C.muted; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText('VERDICT WITHHELD', b.x + 8, (bandTop + bandBot) / 2);
      const r = rng(41);
      for (let i = 0; i < 260; i++) {
        const x = b.x + r() * b.w;
        const u = r();
        const p = u < 0.42 ? 0.10 + r() * 0.16 : u < 0.72 ? 0.76 + r() * 0.2 : 0.3 + r() * 0.4;
        const y = b.y + b.h - p * b.h;
        const inBand = y > bandTop && y < bandBot;
        g.fillStyle = inBand ? 'rgba(110,101,121,0.75)' : C.signal;
        g.beginPath(); g.arc(x, y, 1.7, 0, 6.284); g.fill();
      }
      g.setLineDash([4, 4]); g.strokeStyle = C.muted; g.lineWidth = 1;
      [bandTop, bandBot].forEach(y => { g.beginPath(); g.moveTo(b.x, y); g.lineTo(b.x + b.w, y); g.stroke(); });
      g.setLineDash([]);
      this.tag(g, b.x + b.w * 0.46, b.y + 14, '3.1 ms/window on-device', C.signal);
    }
  }
  if (!customElements.get('scope-plot')) customElements.define('scope-plot', ScopePlot);
})();
