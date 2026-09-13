// <hw-board part="esp32|pi5|both"> — real-time render of hardware that exists on the bench.
// ESP32 DevKit V1 from build 01 (15 cm solid-core wire on GPIO36, WS2812B strip lit purple)
// and the Raspberry Pi 5 it loses to on throughput in build 08.
//
// three.js is fetched from here rather than from <helmet>: the helmet inserted it on
// every compile pass, so the 600 kB UMD bundle was parsed twice on every load ("WARNING:
// Multiple instances of Three.js being imported"). Injecting it from the one module that
// needs it makes that impossible and defers the download until a board is actually on the
// page. If it never arrives, the board falls back to a static panel instead of a hole.
(function () {
  const GROUND = 0x0b0910;
  const THREE_URL = 'https://unpkg.com/three@0.149.0/build/three.min.js';

  function ensureThree() {
    if (window.THREE) return;
    if (document.querySelector('script[data-mmv-three]')) return;
    // the host page may already carry its own copy; never add a second
    if (document.querySelector('script[src*="three.min.js"],script[src*="three.module"]')) return;
    const tag = document.createElement('script');
    tag.src = THREE_URL;
    tag.async = true;
    tag.crossOrigin = 'anonymous';
    tag.setAttribute('data-mmv-three', '');
    document.head.appendChild(tag);
  }

  // A studio render of a board is decoration, not content, on every placement it has.
  // It must never block, never be announced, and never be the reason the page is slow.
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
  const FINE_POINTER = matchMedia('(hover: hover) and (pointer: fine)');
  const LOW_POWER =
    (navigator.hardwareConcurrency || 8) <= 4 ||
    (navigator.deviceMemory || 8) <= 4 ||
    matchMedia('(pointer: coarse)').matches;

  class HwBoard extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.style.display = 'block';
      this.style.position = 'relative';
      this.style.width = '100%';
      this.style.height = '100%';
      this.setAttribute('aria-hidden', 'true');
      this._waitForThree();
    }
    _waitForThree() {
      if (window.THREE) return this._boot();
      ensureThree();
      let n = 0;
      this._poll = setInterval(() => {
        if (this._stop) { clearInterval(this._poll); this._poll = 0; return; }
        if (window.THREE) { clearInterval(this._poll); this._poll = 0; this._boot(); }
        else if (++n > 200) { clearInterval(this._poll); this._poll = 0; this._fallback(); }  // 10 s
      }, 50);
    }
    _boot() {
      try {
        this._start();
      } catch (err) {
        // no WebGL context, a blocked CDN, a driver refusing the request: the panel is
        // 88vh of the home sheet and cannot be allowed to render as an empty hole
        console.warn('[hw-board] render unavailable:', (err && err.message) || err);
        this._fallback();
      }
    }
    _fallback() {
      if (this._fell || !this.isConnected) return;
      this._fell = true;
      const d = document.createElement('div');
      d.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;' +
        'padding:16px 18px;background:radial-gradient(120% 90% at 62% 38%,#191324 0%,#0B0910 70%);' +
        "font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:9px;" +
        'letter-spacing:0.14em;color:#4b4356';
      d.textContent = 'DUT RENDER UNAVAILABLE';
      this.appendChild(d);
    }
    disconnectedCallback() {
      this._stop = true;
      if (this._poll) { clearInterval(this._poll); this._poll = 0; }
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._io) { this._io.disconnect(); this._io = null; }
      if (this._offVis) { this._offVis(); this._offVis = null; }
      // a browser allows a handful of live WebGL contexts; the three sheets each mount
      // their own board, so switching views without releasing them exhausts the pool
      if (this._scene) {
        this._scene.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of mats) {
            for (const k of ['map', 'lightMap', 'aoMap', 'emissiveMap', 'normalMap', 'alphaMap']) {
              if (m[k] && m[k].dispose) m[k].dispose();
            }
            m.dispose();
          }
        });
        this._scene = null;
      }
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.forceContextLoss) { try { this.renderer.forceContextLoss(); } catch (e) {} }
        const el = this.renderer.domElement;
        if (el && el.parentNode) el.parentNode.removeChild(el);
        this.renderer = null;
      }
    }

    _start() {
      const THREE = window.THREE;
      const part = this.getAttribute('part') || 'esp32';
      const w = this.clientWidth || 800, h = this.clientHeight || 600;

      const renderer = this.renderer = new THREE.WebGLRenderer({
        antialias: !LOW_POWER, alpha: false, preserveDrawingBuffer: false,
        powerPreference: 'low-power'
      });
      // fill rate is the whole cost of this scene; a phone gets exactly one pixel per
      // CSS pixel, a desktop gets a little more only when the panel is small
      renderer.setPixelRatio(LOW_POWER ? 1 : Math.min(window.devicePixelRatio || 1, w * h > 500000 ? 1 : 1.5));
      renderer.setSize(w, h);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
      this.appendChild(renderer.domElement);

      const scene = this._scene = new THREE.Scene();
      scene.background = new THREE.Color(GROUND);

      const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 200);
      const baseZoom = parseFloat(this.getAttribute('zoom') || '1');
      const baseLookX = parseFloat(this.getAttribute('lookx') || this.getAttribute('look-x') || '0');
      const baseLookY = parseFloat(this.getAttribute('looky') || '0.6');

      // The framing is authored for a wide panel. Once the layout stacks, the same panel
      // is portrait, the horizontal field of view collapses with the aspect ratio, and
      // the boards fall clean outside the frustum — a blank 88vh hero on a phone. Pull
      // the camera back and re-centre the look target as the box narrows, so the same
      // composition survives the breakpoint instead of disappearing at it.
      let zoom = baseZoom, lookX = baseLookX, lookY = baseLookY;
      scene.fog = new THREE.Fog(GROUND, 13 * zoom, 24 * zoom);
      function fitFraming(aspect) {
        const a = Math.max(0.35, aspect || 1);
        const narrow = Math.max(0, 1.3 - a);          // 0 on a wide panel, ~0.83 on a phone
        zoom = baseZoom * (1 + narrow * 0.78);
        lookX = baseLookX * Math.min(1, Math.max(0, (a - 0.45) / 0.85));
        // drop the look target as the panel goes portrait: the copy stacks into the
        // bottom of the hero, so the boards have to ride up out from under it
        lookY = baseLookY - narrow * 2.8;
        scene.fog.near = 13 * zoom;
        scene.fog.far = 24 * zoom;
      }
      fitFraming(w / h);
      camera.position.set(7.4 * zoom, 6.6 * zoom, 12.6 * zoom);
      camera.lookAt(lookX, lookY, 0);

      // ---- studio: one hard key, deep falloff into the ground colour
      const key = new THREE.DirectionalLight(0xfff4e8, 2.0);
      key.position.set(6, 9, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(LOW_POWER ? 512 : 1024, LOW_POWER ? 512 : 1024);
      key.shadow.camera.near = 1; key.shadow.camera.far = 40;
      key.shadow.camera.left = -10; key.shadow.camera.right = 10;
      key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
      key.shadow.bias = -0.0006;
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xe8dcff, 0.12);
      rim.position.set(-7, 3, -6); scene.add(rim);
      scene.add(new THREE.HemisphereLight(0x151020, 0x07050b, 0.06));

      const bench = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 90),
        new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.62 })
      );
      bench.rotation.x = -Math.PI / 2; bench.position.y = -0.02;
      bench.receiveShadow = true; scene.add(bench);

      const root = new THREE.Group();
      root.position.y = 0.02;
      scene.add(root);

      // ---- shared materials
      const M = {
        gold: new THREE.MeshStandardMaterial({ color: 0xd8b04a, roughness: 0.29, metalness: 0.95 }),
        black: new THREE.MeshStandardMaterial({ color: 0x0d0b11, roughness: 0.75, metalness: 0.05 }),
        solder: new THREE.MeshStandardMaterial({ color: 0x8d8f96, roughness: 0.32, metalness: 0.85 }),
        steel: new THREE.MeshStandardMaterial({ color: 0xa9adb4, roughness: 0.36, metalness: 0.9 }),
        can: new THREE.MeshStandardMaterial({ color: 0xb7bcc4, roughness: 0.34, metalness: 0.92 }),
        copper: new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.32, metalness: 0.95 })
      };
      const cast = m => { m.castShadow = true; return m; };

      // silkscreen baked onto an opaque dark canvas — the board top IS this texture
      function silkTexture(px, py, draw, base) {
        const c = document.createElement('canvas');
        c.width = px; c.height = py;
        const s = c.getContext('2d');
        s.fillStyle = base; s.fillRect(0, 0, px, py);
        draw(s);
        const t = new THREE.CanvasTexture(c);
        t.anisotropy = 8;
        t.encoding = THREE.sRGBEncoding;
        return t;
      }

      // ============================================================ ESP32 DevKit V1
      // 25.5 x 52 mm — 1 unit = 1 cm
      function makeEsp32() {
        const g = new THREE.Group();
        const pcb = cast(new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.16, 5.2),
          new THREE.MeshStandardMaterial({ color: 0x0f0b14, roughness: 0.62, metalness: 0.06 })));
        pcb.position.y = 0.44; pcb.receiveShadow = true; g.add(pcb);

        const tex = silkTexture(512, 1024, s => {
          s.strokeStyle = 'rgba(236,230,244,0.9)'; s.lineWidth = 3;
          s.strokeRect(16, 16, 480, 992);
          s.fillStyle = 'rgba(232,226,240,0.80)';
          s.font = 'bold 30px ui-monospace, monospace';
          s.save(); s.translate(256, 690); s.textAlign = 'center';
          s.fillText('ESP32 DEVKIT V1', 0, 0);
          s.font = '20px ui-monospace, monospace';
          s.fillStyle = 'rgba(232,226,240,0.5)';
          s.fillText('MMV-01  DR BITFLIP', 0, 30);
          s.restore();
          const R = ['3V3', 'GND', 'D15', 'D2', 'D4', 'RX2', 'TX2', 'D5', 'D18', 'D19', 'D21', 'RX0', 'TX0', 'D22', 'D23'];
          const L = ['VIN', 'GND', 'D13', 'D12', 'D14', 'D27', 'D26', 'D25', 'D33', 'D32', 'D35', 'D34', 'VN', 'GPIO36', 'EN'];
          s.font = '17px ui-monospace, monospace';
          for (let i = 0; i < 15; i++) {
            const y = 120 + i * 56;
            s.fillStyle = 'rgba(160,150,175,0.85)';
            s.textAlign = 'left'; s.fillText(L[i], 70, y + 6);
            s.textAlign = 'right'; s.fillText(R[i], 442, y + 6);
            [46, 466].forEach(px => {
              s.fillStyle = '#c9a227';
              s.beginPath(); s.arc(px, y, 13, 0, 6.284); s.fill();
              s.fillStyle = '#0f0c14';
              s.beginPath(); s.arc(px, y, 6, 0, 6.284); s.fill();
            });
          }
          s.strokeStyle = 'rgba(206,196,220,0.30)'; s.lineWidth = 4;
          for (let i = 0; i < 9; i++) {
            s.beginPath(); s.moveTo(80 + i * 8, 200 + i * 30); s.lineTo(430 - i * 6, 210 + i * 34); s.stroke();
          }
        }, '#120d18');
        const top = new THREE.Mesh(new THREE.PlaneGeometry(2.55, 5.2),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.58, metalness: 0.08 }));
        top.rotation.x = -Math.PI / 2; top.position.y = 0.523; g.add(top);

        const can = cast(new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.26, 1.62), M.can));
        can.position.set(0, 0.65, -1.42); g.add(can);
        const canTop = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.44),
          new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.8 }));
        canTop.rotation.x = -Math.PI / 2; canTop.position.set(0, 0.782, -1.42); g.add(canTop);
        const ant = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.02, 0.5),
          new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.4, metalness: 0.8 }));
        ant.position.set(0, 0.535, -2.35); g.add(ant);

        const pinGeo = new THREE.BoxGeometry(0.06, 0.62, 0.06);
        const solderGeo = new THREE.SphereGeometry(0.055, 12, 10);
        [-1.15, 1.15].forEach(xs => {
          const strip = cast(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 3.9), M.black));
          strip.position.set(xs, 0.42, 0.35); g.add(strip);
          for (let i = 0; i < 15; i++) {
            const z = 1.95 - i * 0.254 + 0.2;
            const pin = cast(new THREE.Mesh(pinGeo, M.gold));
            pin.position.set(xs, 0.30, z); g.add(pin);
            const sd = new THREE.Mesh(solderGeo, M.solder);
            sd.position.set(xs, 0.535, z); sd.scale.set(1, 0.5, 1); g.add(sd);
          }
        });

        const usb = cast(new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.28, 0.52), M.steel));
        usb.position.set(0, 0.66, 2.62); g.add(usb);
        [[-0.72, 2.05], [0.72, 2.05]].forEach(([x, z]) => {
          const b = cast(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), M.black));
          b.position.set(x, 0.62, z); g.add(b);
        });
        const reg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.36), M.black);
        reg.position.set(0.5, 0.6, 1.1); g.add(reg);
        [[-0.45, 0.9], [-0.2, 1.35], [0.3, 0.2]].forEach(([x, z]) => {
          const cap = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 16),
            new THREE.MeshStandardMaterial({ color: 0x2b2333, roughness: 0.6, metalness: 0.2 })));
          cap.position.set(x, 0.62, z); g.add(cap);
        });
        const pwr = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.12),
          new THREE.MeshStandardMaterial({ color: 0xd9552a, emissive: 0xd9552a, emissiveIntensity: 0.8, roughness: 0.4 }));
        pwr.position.set(0.75, 0.56, 1.6); g.add(pwr);

        // 15 cm of solid-core wire off GPIO36 (left row, index 13)
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-1.15, 0.6, 1.95 - 13 * 0.254 + 0.2),
          new THREE.Vector3(-1.9, 2.2, 0.2),
          new THREE.Vector3(-3.2, 3.4, 1.1),
          new THREE.Vector3(-4.4, 3.0, 2.2),
          new THREE.Vector3(-5.0, 1.5, 3.0),
          new THREE.Vector3(-5.2, 0.24, 3.7)
        ]);
        const wire = cast(new THREE.Mesh(new THREE.TubeGeometry(curve, 140, 0.038, 10, false),
          new THREE.MeshStandardMaterial({ color: 0xd6cfdd, roughness: 0.55, metalness: 0.1 })));
        g.add(wire);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.8, 12), M.copper);
        tip.position.set(-5.2, 0.22, 4.15); tip.rotation.x = Math.PI / 2.2; g.add(tip);

        // WS2812B x 8
        const strip = new THREE.Group();
        strip.position.set(2.9, 0.05, 0.2);
        strip.rotation.y = -0.16;
        g.add(strip);
        const flex = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.09, 5.4),
          new THREE.MeshStandardMaterial({ color: 0x0a080e, roughness: 0.85, metalness: 0.05 }));
        flex.receiveShadow = true; strip.add(flex);
        const leds = [];
        for (let i = 0; i < 8; i++) {
          const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.5),
            new THREE.MeshStandardMaterial({
              color: 0x140420, emissive: 0xa94bcc, emissiveIntensity: 0, roughness: 0.25, metalness: 0.0
            }));
          led.position.set(0, 0.09, -2.3 + i * 0.66); strip.add(led); leds.push(led);
        }
        const glowA = new THREE.PointLight(0xa94bcc, 0, 1.3, 2.4);
        glowA.position.set(3.1, 0.34, -1.4); g.add(glowA);
        const glowB = new THREE.PointLight(0xa94bcc, 0, 1.3, 2.4);
        glowB.position.set(3.1, 0.34, 1.6); g.add(glowB);
        g.userData.leds = leds;
        g.userData.glows = [glowA, glowB];
        return g;
      }

      // ============================================================ Raspberry Pi 5
      // 85 x 56 mm
      function makePi5() {
        const g = new THREE.Group();
        const green = 0x143a24;
        const pcb = cast(new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.14, 5.6),
          new THREE.MeshStandardMaterial({ color: green, roughness: 0.6, metalness: 0.06 })));
        pcb.position.y = 0.43; pcb.receiveShadow = true; g.add(pcb);

        const tex = silkTexture(1024, 676, s => {
          s.strokeStyle = 'rgba(236,244,238,0.55)'; s.lineWidth = 3;
          s.strokeRect(14, 14, 996, 648);
          // 40-pin header footprint, top edge
          for (let i = 0; i < 20; i++) {
            const x = 176 + i * 30.5;
            [70, 100].forEach(y => {
              s.fillStyle = '#c9a227';
              s.beginPath(); s.arc(x, y, 10, 0, 6.284); s.fill();
              s.fillStyle = '#0d1a12';
              s.beginPath(); s.arc(x, y, 4.6, 0, 6.284); s.fill();
            });
          }
          s.fillStyle = 'rgba(240,248,242,0.9)';
          s.font = 'bold 40px ui-monospace, monospace';
          s.textAlign = 'left';
          s.fillText('Raspberry Pi 5', 300, 400);
          s.font = '22px ui-monospace, monospace';
          s.fillStyle = 'rgba(220,232,224,0.55)';
          s.fillText('MODEL B  8 GB   \u00a9 2023', 300, 434);
          s.font = '19px ui-monospace, monospace';
          s.fillStyle = 'rgba(200,216,206,0.7)';
          s.fillText('GPIO', 120, 150);
          s.fillText('PCIe', 860, 200);
          s.fillText('CAM/DISP 0', 60, 560);
          s.fillText('CAM/DISP 1', 60, 610);
          // routing
          s.strokeStyle = 'rgba(210,226,214,0.20)'; s.lineWidth = 4;
          for (let i = 0; i < 12; i++) {
            s.beginPath();
            s.moveTo(180 + i * 26, 130);
            s.lineTo(300 + i * 30, 300 + (i % 4) * 22);
            s.stroke();
          }
          // mounting holes
          [[64, 64], [960, 64], [64, 612], [960, 612]].forEach(([x, y]) => {
            s.fillStyle = '#b9c4bc';
            s.beginPath(); s.arc(x, y, 22, 0, 6.284); s.fill();
            s.fillStyle = '#07100a';
            s.beginPath(); s.arc(x, y, 12, 0, 6.284); s.fill();
          });
        }, '#0f2a1b');
        const top = new THREE.Mesh(new THREE.PlaneGeometry(8.5, 5.6),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.56, metalness: 0.08 }));
        top.rotation.x = -Math.PI / 2; top.position.y = 0.503; g.add(top);

        // BCM2712 with its metal heat spreader
        const soc = cast(new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.12, 1.55),
          new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.5, metalness: 0.2 })));
        soc.position.set(-0.5, 0.56, 0.2); g.add(soc);
        const lid = cast(new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.09, 1.25),
          new THREE.MeshStandardMaterial({ color: 0xc2c8cf, roughness: 0.28, metalness: 0.95 })));
        lid.position.set(-0.5, 0.66, 0.2); g.add(lid);

        // RP1 southbridge
        const rp1 = cast(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 0.95),
          new THREE.MeshStandardMaterial({ color: 0x16141c, roughness: 0.55, metalness: 0.15 })));
        rp1.position.set(1.9, 0.55, 1.5); g.add(rp1);
        // LPDDR4X package
        const ram = cast(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.9),
          new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.5, metalness: 0.2 })));
        ram.position.set(-2.0, 0.54, -0.4); g.add(ram);

        // 40-pin GPIO header along the long edge
        const hdr = cast(new THREE.Mesh(new THREE.BoxGeometry(5.15, 0.22, 0.5), M.black));
        hdr.position.set(-0.05, 0.61, -2.45); g.add(hdr);
        const pinGeo = new THREE.BoxGeometry(0.055, 0.55, 0.055);
        for (let i = 0; i < 20; i++) {
          for (const dz of [-0.127, 0.127]) {
            const pin = cast(new THREE.Mesh(pinGeo, M.gold));
            pin.position.set(-2.46 + i * 0.254, 0.86, -2.45 + dz); g.add(pin);
          }
        }

        // right edge: 2x micro-HDMI + USB-C power + fan header
        [[-1.4, 'hdmi'], [-0.28, 'hdmi']].forEach(([x]) => {
          const hd = cast(new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.3, 0.42), M.steel));
          hd.position.set(x, 0.63, 2.6); g.add(hd);
        });
        const usbc = cast(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.4), M.steel));
        usbc.position.set(-2.85, 0.63, 2.6); g.add(usbc);
        const fanh = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.18), M.black);
        fanh.position.set(0.75, 0.59, 2.5); g.add(fanh);

        // left/far edge: Ethernet + 2x USB3 (blue) + 2x USB2 (black)
        const rj45 = cast(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.35, 2.1), M.steel));
        rj45.position.set(3.55, 1.05, -1.6); g.add(rj45);
        const usb3 = cast(new THREE.Mesh(new THREE.BoxGeometry(1.55, 1.55, 1.75), M.steel));
        usb3.position.set(3.6, 1.15, 0.55); g.add(usb3);
        [[-0.4, 0x2a4fa8], [0.4, 0x2a4fa8]].forEach(([dz, col]) => {
          const inner = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.72),
            new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.2 }));
          inner.position.set(4.39, 1.45, 0.55 + dz); g.add(inner);
        });
        const usb2 = cast(new THREE.Mesh(new THREE.BoxGeometry(1.55, 1.55, 1.75), M.steel));
        usb2.position.set(3.6, 1.15, 2.4); g.add(usb2);
        [[-0.4], [0.4]].forEach(([dz]) => {
          const inner = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.72), M.black);
          inner.position.set(4.39, 1.45, 2.4 + dz); g.add(inner);
        });

        // PCIe FPC connector + 2 MIPI connectors + power button + status LEDs
        const pcie = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 1.5),
          new THREE.MeshStandardMaterial({ color: 0x1b1a22, roughness: 0.7, metalness: 0.1 }));
        pcie.position.set(2.75, 0.57, -2.3); g.add(pcie);
        [[-3.3, 1.75], [-3.3, 0.55]].forEach(([x, z]) => {
          const mipi = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 1.15),
            new THREE.MeshStandardMaterial({ color: 0x1b1a22, roughness: 0.7, metalness: 0.1 }));
          mipi.position.set(x, 0.56, z); g.add(mipi);
        });
        const btn = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 14), M.black));
        btn.position.set(-4.0, 0.58, 2.35); g.add(btn);
        const ledG = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.1),
          new THREE.MeshStandardMaterial({ color: 0x0f2416, emissive: 0x3fbf6a, emissiveIntensity: 0.5, roughness: 0.4 }));
        ledG.position.set(-4.05, 0.54, 1.9); g.add(ledG);
        const ledR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.1),
          new THREE.MeshStandardMaterial({ color: 0x2a0d08, emissive: 0xd9552a, emissiveIntensity: 0.55, roughness: 0.4 }));
        ledR.position.set(-4.05, 0.54, 1.6); g.add(ledR);

        // standoffs
        [[-3.75, -2.25], [3.75, -2.25], [-3.75, 2.25], [3.75, 2.25]].forEach(([x, z]) => {
          const so = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.36, 14), M.solder);
          so.position.set(x, 0.2, z); g.add(so);
        });
        return g;
      }

      // ---- assemble
      const rig = new THREE.Group();
      root.add(rig);
      let esp = null, pi = null;
      if (part === 'esp32' || part === 'both') { esp = makeEsp32(); rig.add(esp); }
      if (part === 'pi5' || part === 'both') { pi = makePi5(); rig.add(pi); }
      if (part === 'both') {
        esp.position.set(-1.7, 0, 2.9);
        esp.rotation.y = 0.34;
        pi.position.set(4.3, 0, -1.7);
        pi.rotation.y = -0.12;
        rig.position.x = 1.6;
        rig.children.forEach(c => { c.position.x -= 1.6; });
      } else if (part === 'pi5') {
        pi.rotation.y = -0.06;
      }

      // ---- interaction + loop
      const wantsSpin = this.getAttribute('spin') === 'on';
      let reduce = REDUCE.matches;
      let spin = wantsSpin && !reduce;
      const leds = esp ? esp.userData.leds : [];
      const glows = esp ? esp.userData.glows : [];
      const clock = new THREE.Clock();

      // a spinning rig moves its own shadow; a still one does not, so bake it once
      renderer.shadowMap.autoUpdate = spin;
      renderer.shadowMap.needsUpdate = true;

      let px = 0, py = 0, tx = 0, ty = 0;
      // parallax is a mouse affordance; on touch it only fights the scroll gesture
      if (FINE_POINTER.matches && !reduce) {
        this.addEventListener('pointermove', e => {
          if (e.pointerType && e.pointerType !== 'mouse') return;
          const r = this.getBoundingClientRect();
          tx = ((e.clientX - r.left) / r.width - 0.5) * 0.5;
          ty = ((e.clientY - r.top) / r.height - 0.5) * 0.32;
          request();
        }, { passive: true });
        this.addEventListener('pointerleave', () => { tx = 0; ty = 0; request(); }, { passive: true });
      }

      // one rAF-coalesced resize, and only when the box really changed
      let lastW = w, lastH = h, roQueued = false;
      this._ro = new ResizeObserver(() => {
        if (roQueued) return;
        roQueued = true;
        requestAnimationFrame(() => {
          roQueued = false;
          const W = this.clientWidth, H = this.clientHeight;
          if (!W || !H || (W === lastW && H === lastH)) return;
          lastW = W; lastH = H;
          renderer.setSize(W, H);
          camera.aspect = W / H; camera.updateProjectionMatrix();
          fitFraming(W / H);
          renderer.shadowMap.needsUpdate = true;
          request();
        });
      });
      this._ro.observe(this);

      // visibility from an observer, not a getBoundingClientRect on every scroll event:
      // with three boards mounted that was three forced layouts per scroll tick
      // starts true so the first frame paints even if the observer never reports; the
      // observer only ever corrects it downwards for a board that is off screen
      let visible = true;
      if ('IntersectionObserver' in window) {
        this._io = new IntersectionObserver(entries => {
          for (const e of entries) {
            const was = visible;
            visible = e.isIntersecting;
            // the clock is lazy (THREE.Clock autoStart), so it begins on the first frame
            // this element is actually on screen and the LED walk is never missed
            if (visible && !was) request();
          }
        }, { rootMargin: '120px 0px 120px 0px', threshold: 0 });
        this._io.observe(this);
      }
      const onVis = () => { if (document.visibilityState === 'visible') request(); };
      document.addEventListener('visibilitychange', onVis);
      this._offVis = () => document.removeEventListener('visibilitychange', onVis);

      // Render on demand. The scene is a still studio shot; it repaints only for the
      // intro LED walk, pointer parallax, a resize, or the optional slow spin — and
      // never at all while it is off screen or the tab is in the background.
      let need = true;
      const MIN_DT = 1000 / (LOW_POWER ? 24 : 30);
      let lastFrame = 0;

      const draw = () => {
        if (this._stop) { this._raf = 0; return; }
        if (!visible || document.visibilityState === 'hidden') { this._raf = 0; return; }

        const t = clock.getElapsedTime();
        const intro = t < 2.4 && !reduce;
        const moving = Math.abs(tx - px) > 0.002 || Math.abs(ty - py) > 0.002;
        const live = intro || moving || spin;

        if (!need && !live) { this._raf = 0; return; }

        const nowMs = performance.now();
        if (nowMs - lastFrame >= MIN_DT) {
          lastFrame = nowMs;
          need = false;
          if (spin) rig.rotation.y = t * 0.16;

          // power-on: the strip walks up one LED at a time, then holds
          if (leds.length) {
            const litF = reduce ? 8 : Math.min(8, t / 0.16);
            let sum = 0;
            for (let i = 0; i < 8; i++) {
              const v = Math.max(0, Math.min(1, litF - i)) * 0.42;
              leds[i].material.emissiveIntensity = v;
              sum += v;
            }
            const gi = sum / (8 * 0.42);
            glows[0].intensity = 0.30 * gi;
            glows[1].intensity = 0.24 * gi;
          }

          px += (tx - px) * 0.05; py += (ty - py) * 0.05;
          camera.position.x = (7.4 + px * 4) * zoom;
          camera.position.y = (6.6 + py * 3) * zoom;
          camera.lookAt(lookX, lookY, 0);
          renderer.render(scene, camera);
        }

        // `need` survives a throttled frame, so a resize that lands between two ticks
        // still gets painted instead of being dropped on the floor
        this._raf = (live || need) ? requestAnimationFrame(draw) : 0;
      };

      const request = () => {
        need = true;
        if (!this._raf && !this._stop) this._raf = requestAnimationFrame(draw);
      };
      this._need = request;

      // honour a mid-session change to the OS motion setting rather than only the one
      // that happened to be set when the element mounted
      const onMotion = () => {
        reduce = REDUCE.matches;
        spin = wantsSpin && !reduce;
        renderer.shadowMap.autoUpdate = spin;
        renderer.shadowMap.needsUpdate = true;
        request();
      };
      if (REDUCE.addEventListener) REDUCE.addEventListener('change', onMotion);
      else if (REDUCE.addListener) REDUCE.addListener(onMotion);
      const offMotion = this._offVis;
      this._offVis = () => {
        offMotion();
        if (REDUCE.removeEventListener) REDUCE.removeEventListener('change', onMotion);
        else if (REDUCE.removeListener) REDUCE.removeListener(onMotion);
      };

      // the sheet's layout settles a beat after mount; take the final size then
      requestAnimationFrame(() => {
        const W = this.clientWidth, H = this.clientHeight;
        if (W && H && (W !== lastW || H !== lastH)) {
          lastW = W; lastH = H;
          renderer.setSize(W, H);
          camera.aspect = W / H; camera.updateProjectionMatrix();
          fitFraming(W / H);
        }
        request();
      });
      request();
    }
  }
  if (!customElements.get('hw-board')) customElements.define('hw-board', HwBoard);
})();
