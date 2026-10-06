(function () {
  'use strict';
  const { Spacetime, Worldline, makeHubbleStar, findEmission, tailOf } = DS;
  const $ = id => document.getElementById(id);
  const PI = Math.PI, HALF = PI / 2, TAU = 2 * PI;

  const SEEN_AT_LAUNCH = 450;   // nm: beacons are tuned so you first receive them blue
  // Everything you launch leaves at nearly the speed of light, so the mass it carries travels
  // with it as a null shell (exact Vaidya, up to 1 − v = 0.1%), yet it can still signal back.
  const V_LAUNCH = 0.999;
  const GAMMA_LAUNCH = 1 / Math.sqrt(1 - V_LAUNCH * V_LAUNCH);
  const DOP_LAUNCH = Math.sqrt((1 + V_LAUNCH) / (1 - V_LAUNCH));   // ≈ 45: launch Doppler factor
  const MSG_PERIOD = 0.15 / DOP_LAUNCH;   // beacon proper time per message: one per 0.15ℓ of yours at launch
  const Z_LOST = 1e7;           // beyond this, treat a source as gone from view
  const N_STARS = 90;
  const BURST_TIME = 0.2;        // each pre-game star burst lasts this long (ℓ)…
  const BURST_STEPS = 8;         // …as this many sub-launches, each star carrying its share of the mass
  const RING_N = 12;

  const sky = $('sky'), spec = $('spectrum'), pen = $('penrose');
  const cS = sky.getContext('2d'), cP = spec.getContext('2d'), cN = pen.getContext('2d');

  // ---------- UI ----------
  const ui = {};
  function readUI() {
    ui.speed = Math.pow(10, +$('speed').value);
    ui.dm = +$('dm').value;
    ui.m0 = +$('m0').value;
    ui.mStars = +$('mStars').value;
    ui.ir = $('ir').checked;
    ui.waves = $('waves').checked;
    ui.oldH = $('oldH').checked;
    ui.stars = $('stars').checked;
    $('speedVal').textContent = ui.speed.toFixed(2) + ' ℓ/s';
    $('dmVal').textContent = ui.dm.toFixed(2) + ' /8G';
    const pending = S && (Math.abs(ui.m0 - S.m0) > 1e-9 || Math.abs(ui.mStars - S.mStars) > 1e-9);
    $('m0Val').textContent = ui.m0.toFixed(2) + ' /8G' + (pending ? ' · on reset' : '');
    $('mStarsVal').textContent = ui.mStars.toFixed(2) + ' /8G' + (pending ? ' · on reset' : '');
  }
  for (const id of ['speed', 'dm', 'm0', 'mStars', 'ir', 'waves', 'oldH', 'stars']) $(id).addEventListener('input', readUI);

  // ---------- state ----------
  let S = null;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const newPQ = () => ({ ver: -1, P: [], S: [], T: [] });

  // Before τ = 0 you launched the stars in bursts. Each burst cost you a slice of mass,
  // radiated outward as a flash of light (an exact Vaidya shell); the stars are test particles.
  const STAR_BURSTS = [-3.4, -2.6, -1.9, -1.3, -0.8, -0.4];   // your proper time (ℓ)
  function reset() {
    readUI();
    const mStars = Math.min(ui.mStars, Math.max(0, 0.96 - ui.m0));
    const st = new Spacetime(ui.m0 + mStars);
    const rnd = mulberry32(20261006);
    const sources = [];
    const oldHorizons = [];
    const perBurst = Math.round(N_STARS / STAR_BURSTS.length);
    // Stars leave at the launch speed and, like beacons, transmit very blue light,
    // tuned so that at launch you would receive them in the visible.
    const v = V_LAUNCH, g = GAMMA_LAUNCH, dop = DOP_LAUNCH;
    for (const tb of STAR_BURSTS) {
      oldHorizons.push(st.aNow);
      const off = rnd() * TAU;
      // The burst is BURST_STEPS sub-launches over BURST_TIME; each sub-launch's stars
      // carry its share of the mass (one thin shell travelling with them).
      for (let k = 0; k < BURST_STEPS; k++) {
        const u = st.uOfTau(tb + BURST_TIME * k / BURST_STEPS);
        if (mStars > 0) st.addShell(u, mStars / STAR_BURSTS.length / BURST_STEPS);
        const a = st.aR[st.region(u)];
        for (let j = k; j < perBurst; j += BURST_STEPS) {
          sources.push({
            kind: 'star', phi: off + TAU * (j + 0.8 * (rnd() - 0.5)) / perBurst,
            wl: new Worldline(u, 0, g * (1 - v) / a, 0),
            lamEm: (380 + 110 * rnd()) / dop, size: 0.9 + 1.5 * rnd() * rnd(), jit: rnd(), rot: 0.25 * (rnd() - 0.5),
            hint: 1e9, obs: null, pq: newPQ(), tail: null,
          });
        }
      }
    }
    const playing = S ? S.playing : true;
    S = { st, sources, tau: 0, u: 0, playing, m0: ui.m0, mStars: ui.mStars, nBeacons: 0, flashes: [], frame: 0, cone: null,
          oldHorizons,
          ring: S ? S.ring : false, pen: { ver: -1 }, tailFrame: -1 };
    readUI();
    step();
    updateList();
  }

  function fire(phi, ring) {
    const st = S.st;
    // What you launch carries the mass: a thin shell leaving with it (s-wave for one beacon).
    const dm = Math.min(ui.dm, st.mNow);
    if (dm > 1e-9) { S.oldHorizons.push(st.aNow); st.addShell(S.u, dm); }
    const a = st.aR[st.region(S.u)];
    const v = V_LAUNCH, g = GAMMA_LAUNCH;
    const n = ring ? RING_N : 1;
    for (let i = 0; i < n; i++) {
      const id = ++S.nBeacons;
      S.sources.push({
        kind: 'beacon', id, v, phi: phi + TAU * i / n,
        wl: new Worldline(S.u, 0, g * (1 - v) / a, 0),
        lamEm: SEEN_AT_LAUNCH / DOP_LAUNCH,
        hue: (id * 137.508) % 360, jit: Math.random(),
        hint: 0, msg: 0, obs: null, pq: newPQ(), tail: null, tau0: S.tau,
      });
    }
    S.flashes.push({ t: performance.now(), dm });
    $('hint').classList.add('hidden');
    step();
    updateList();
  }

  // ---------- physics step ----------
  function step() {
    const st = S.st;
    S.u = st.uOfTau(S.tau);
    for (const s of S.sources) if (!s.gone) s.wl.advance(st, S.u);
    const cone = st.pastCone(S.u);
    S.cone = cone;
    for (const s of S.sources) {
      if (s.gone) { s.obs = null; continue; }
      const e = findEmission(s.wl, cone, st, s.hint);
      if (!e) { s.obs = null; continue; }
      s.hint = e.j;
      e.lam = s.lamEm * e.z1;
      s.obs = e;
      if (s.kind === 'beacon') s.msg = Math.max(s.msg, Math.floor(e.tau / MSG_PERIOD));
      if (e.z1 > Z_LOST && s.wl.done) { s.gone = true; s.obs = null; }
    }
  }

  // ---------- canvas helpers ----------
  function fit(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    return { w, h, dpr };
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const brightness = z1 => Math.min(1, 1.4 * Math.pow(z1, -0.5));

  function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, Math.max(0, r), 0, TAU); }

  // ---------- the sky ----------
  function skyGeom() {
    const { w, h } = { w: sky.clientWidth, h: sky.clientHeight };
    return { cx: w / 2, cy: h / 2, R: 0.47 * Math.min(w, h) };
  }

  function drawSky(now) {
    const { w, h, dpr } = fit(sky);
    const c = cS;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cx, cy, R } = skyGeom();
    const st = S.st, aNow = st.aNow, mNow = st.mNow;

    c.fillStyle = '#04060c';
    c.fillRect(0, 0, w, h);

    // Edge of what you can see now: the outermost point of your past light cone.
    // After an emission it grows from the old r_c towards the new one as light from the
    // newly enclosed region arrives (over ~ℓ), while r_c(M_now) itself jumps at once.
    const rEdge = DS.coneMaxR(S.cone);

    // Inside the visible edge: faint glow, so the observable region reads as a disc.
    const g0 = c.createRadialGradient(cx, cy, 0, cx, cy, rEdge * R);
    g0.addColorStop(0, 'rgba(30,40,80,0.35)');
    g0.addColorStop(1, 'rgba(20,28,60,0.10)');
    c.fillStyle = g0; circle(c, cx, cy, rEdge * R); c.fill();

    // Reference circles in areal radius.
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    for (const r of [0.25, 0.5, 0.75]) { circle(c, cx, cy, r * R); c.stroke(); }
    c.setLineDash([3, 5]);
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    circle(c, cx, cy, R); c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255,255,255,0.32)';
    c.font = '13px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('r = ℓ  (empty dS)', cx, cy + R + 15 < h - 4 ? cy + R + 15 : cy + R - 7);
    c.textAlign = 'center';

    // Earlier horizons.
    if (ui.oldH) {
      c.setLineDash([2, 4]);
      c.strokeStyle = 'rgba(127,208,255,0.28)';
      for (const a of S.oldHorizons) if (Math.abs(a - aNow) > 1e-4) { circle(c, cx, cy, a * R); c.stroke(); }
      c.setLineDash([]);
    }

    // Horizon set by your mass now (jumps when you emit).
    const rh = aNow * R;
    const catching = aNow - rEdge > 2e-4;
    if (catching) {
      c.setLineDash([5, 4]);
      c.strokeStyle = 'rgba(160,215,255,0.7)';
      c.lineWidth = 1.2;
      circle(c, cx, cy, rh); c.stroke();
      c.setLineDash([]);
    }

    // The visible horizon (solid).
    const re = rEdge * R;
    const gh = c.createRadialGradient(cx, cy, Math.max(0, re - 14), cx, cy, re + 16);
    gh.addColorStop(0, 'rgba(127,208,255,0)');
    gh.addColorStop(0.47, 'rgba(127,208,255,0.30)');
    gh.addColorStop(1, 'rgba(127,208,255,0)');
    c.fillStyle = gh; circle(c, cx, cy, re + 16); c.fill();
    c.strokeStyle = 'rgba(160,215,255,0.95)';
    c.lineWidth = 1.6;
    circle(c, cx, cy, re); c.stroke();
    c.fillStyle = 'rgba(160,215,255,0.95)';
    const ly = cy - rh - 8 < 12 ? cy - rh + 16 : cy - rh - 8;
    c.fillText(`horizon  r꜀ = ${aNow.toFixed(3)} ℓ`, cx, ly);
    if (catching) {
      // Just below the solid circle, on a dark pill so it stays legible over the dashed r_c.
      const txt = `visible edge ${rEdge.toFixed(3)} ℓ`;
      const tw = c.measureText(txt).width, ty = cy + re + 17;
      c.fillStyle = 'rgba(4,6,13,0.78)';
      c.beginPath(); c.roundRect(cx - tw / 2 - 7, ty - 13, tw + 14, 18, 9); c.fill();
      c.fillStyle = 'rgba(190,225,255,0.95)';
      c.fillText(txt, cx, ty);
    }

    // Sources.
    const t = now / 1000;
    if (ui.stars) for (const s of S.sources) if (s.kind === 'star') drawStar(c, s, cx, cy, R);
    labelsOn = !$('beaconSheet').hidden;
    for (const s of S.sources) if (s.kind === 'beacon') drawBeacon(c, s, cx, cy, R, t);

    // You.
    const rm = 3 + 7 * mNow;
    const go = c.createRadialGradient(cx, cy, 0, cx, cy, rm * 3);
    go.addColorStop(0, 'rgba(255,240,210,0.9)');
    go.addColorStop(1, 'rgba(255,200,120,0)');
    c.fillStyle = go; circle(c, cx, cy, rm * 3); c.fill();
    c.fillStyle = '#fff6e6'; circle(c, cx, cy, rm); c.fill();

    // Launch flashes (just a UI cue at your position).
    S.flashes = S.flashes.filter(f => now - f.t < 700);
    for (const f of S.flashes) {
      const p = (now - f.t) / 700;
      c.strokeStyle = `rgba(255,170,90,${0.6 * (1 - p)})`;
      c.lineWidth = 2;
      circle(c, cx, cy, rm + 30 * p); c.stroke();
    }

  }

  function drawStar(c, s, cx, cy, R) {
    const e = s.obs;
    if (!e || e.z1 > Z_LOST) return;
    const x = cx + e.r * R * Math.cos(s.phi), y = cy - e.r * R * Math.sin(s.phi);
    const col = Colors.rgb(e.lam, ui.ir);
    let al = brightness(e.z1);
    if (ui.ir) al = Math.max(al, 0.6);
    const rad = s.size * (0.6 + 0.6 * al);
    const g = c.createRadialGradient(x, y, 0, x, y, rad * 4);
    g.addColorStop(0, rgba(col, 0.55 * al));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; circle(c, x, y, rad * 4); c.fill();
    c.fillStyle = rgba(col, Math.min(1, 0.25 + al));
    starPath(c, x, y, rad * 2.4, rad * 1.0, s.rot); c.fill();
  }

  // Five-pointed star outline centred on (x, y).
  function starPath(c, x, y, rOut, rIn, rot) {
    c.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = rot - HALF + k * PI / 5, r = k % 2 ? rIn : rOut;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (k) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.closePath();
  }

  let labelsOn = false;
  function drawBeacon(c, s, cx, cy, R, t) {
    const e = s.obs;
    if (!e || e.z1 > Z_LOST) return;
    const cos = Math.cos(s.phi), sin = Math.sin(s.phi);
    const dist = e.r * R;
    const x = cx + dist * cos, y = cy - dist * sin;
    const col = Colors.rgb(e.lam, ui.ir);
    const band = Colors.band(e.lam);
    let al = Math.max(0.22, brightness(e.z1));
    if (ui.ir) al = Math.max(al, 0.75);
    const dash = ui.ir ? [] : band === 'infrared' ? [3, 2] : (band === 'microwave' || band === 'radio') ? [1, 3] : [];

    // Wave glyph: a wavetrain heading to you, its drawn wavelength stretching with 1+z.
    if (ui.waves && dist > 14) {
      const L = Math.min(34, dist - 8);
      const lpx = Math.min(90, 3.2 * Math.pow(e.z1, 0.33));
      const nx = sin, ny = cos;                 // perpendicular to the radial direction (screen)
      const dx = -cos, dy = sin;                // towards you
      c.beginPath();
      for (let k = 0; k <= L; k += 0.75) {
        const amp = 2.6 * Math.sin(PI * k / L);
        const off = amp * Math.sin(TAU * (k / lpx) - TAU * 1.2 * t);
        const px = x + dx * (6 + k) + nx * off, py = y + dy * (6 + k) + ny * off;
        if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.setLineDash(dash);
      c.strokeStyle = rgba(col, 0.85 * al);
      c.lineWidth = 1.3;
      c.stroke();
      c.setLineDash([]);
    }

    const g = c.createRadialGradient(x, y, 0, x, y, 14);
    g.addColorStop(0, rgba(col, 0.6 * al));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; circle(c, x, y, 14); c.fill();
    c.fillStyle = rgba(col, Math.min(1, 0.3 + al));
    circle(c, x, y, 3.4); c.fill();

    // Message flash: once per MSG_PERIOD of the beacon's own clock, as received.
    const ph = (e.tau / MSG_PERIOD) % 1;
    if (ph < 0.3) {
      const p = ph / 0.3;
      c.setLineDash(dash);
      c.strokeStyle = rgba(col, (1 - p) * Math.max(al, 0.4));
      c.lineWidth = 1.4;
      circle(c, x, y, 4 + 10 * p); c.stroke();
      c.setLineDash([]);
    }

    if (labelsOn) {                 // names only while the beacon list is open
      c.fillStyle = `rgba(230,236,255,${0.45 + 0.4 * Math.min(1, al)})`;
      c.font = '12px Inter, system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(`B${s.id} #${Math.floor(e.tau / MSG_PERIOD)}`, x + 7, y - 6);
    }
  }

  // ---------- spectrum strip ----------
  const L0 = 2, L1 = 10;   // log10(λ / nm): 100 nm … 10 m
  function drawSpectrum() {
    const { w, h, dpr } = fit(spec);
    const c = cP;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#070a14'; c.fillRect(0, 0, w, h);
    const x0 = 8, x1 = w - 8;
    const X = nm => x0 + (Math.log10(nm) - L0) / (L1 - L0) * (x1 - x0);
    const top = 16, bot = h - 16;

    if (ui.ir) {
      const g = c.createLinearGradient(x0, 0, x1, 0);
      for (const [lx, col] of Colors.STOPS) {
        const f = (lx - L0) / (L1 - L0);
        if (f >= 0 && f <= 1) g.addColorStop(f, rgba(col, 0.35));
      }
      c.fillStyle = g; c.fillRect(x0, top, x1 - x0, bot - top);
    } else {
      const bands = [[750, 1e6, [90, 20, 25]], [1e6, 1e9, [45, 50, 70]], [1e9, 1e10, [30, 32, 45]]];
      for (const [a, b, col] of bands) { c.fillStyle = rgba(col, 0.45); c.fillRect(X(a), top, X(b) - X(a), bot - top); }
      // UV through visible, with the same colours the sky uses (UV fades to white).
      const g = c.createLinearGradient(X(100), 0, X(750), 0);
      for (const nm of [100, 150, 200, 250, 300, 340, 380, 400, 420, 440, 470, 500, 530, 560, 590, 620, 650, 680, 710, 750]) {
        g.addColorStop((Math.log10(nm) - 2) / (Math.log10(750) - 2), rgba(Colors.physicalRGB(nm), nm < 380 ? 0.55 : 0.8));
      }
      c.fillStyle = g; c.fillRect(X(100), top, X(750) - X(100), bot - top);
    }

    c.font = '11.5px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(200,210,240,0.75)';
    const lbl = [['UV', 200], ['vis', 530], ['infrared', 2.5e4], ['microwave', 3e7], ['radio', 3e9]];
    for (const [t, nm] of lbl) c.fillText(t, X(nm), 11);
    c.fillStyle = 'rgba(138,150,187,0.8)';
    for (const [t, nm] of [['1 µm', 1e3], ['1 mm', 1e6], ['1 m', 1e9]]) {
      c.fillRect(X(nm), bot, 1, 3);
      c.fillText(t, X(nm), h - 3);
    }

    for (const s of S.sources) {
      const e = s.obs;
      if (!e || e.z1 > Z_LOST) continue;
      if (s.kind === 'star' && !ui.stars) continue;
      const x = X(e.lam);
      if (x < x0 || x > x1) continue;
      if (s.kind === 'star') {
        c.fillStyle = `rgba(230,236,255,${0.25 + 0.5 * brightness(e.z1)})`;
        circle(c, x, top + 4 + s.jit * (bot - top - 8), 1.3); c.fill();
      } else {
        const y = top + 6 + s.jit * (bot - top - 12);
        c.fillStyle = `hsl(${s.hue},85%,68%)`;
        c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 4, y + 3); c.lineTo(x - 4, y + 3); c.closePath(); c.fill();
      }
    }
  }

  // ---------- Penrose diagram ----------
  function penGeom() {
    const w = pen.clientWidth, h = pen.clientHeight;
    const pad = 26;
    return { cx: w / 2, cy: h / 2, s: (Math.min(w, h) / 2 - pad) / HALF };
  }
  function toXY(g, P, Q) { return [g.cx + (Q - P) * g.s, g.cy - (P + Q) * g.s]; }

  /*
   * Points are cached as raw null coordinates (ln U = τ_out, V).  The display applies
   * U → U e^{−σ}, V → V e^{σ} before compactifying.  This is the static-time translation
   * of the current region: it keeps your worldline (UV = −1) and I⁺ (UV = 1) fixed.
   * σ = 0 shows the full history; σ = τ_now centres the diagram on the present.
   */
  let penSigma = 0;
  const mapP = lnU => Math.atan(Math.exp(lnU - penSigma));
  // V = sg·exp(−t) is kept in log form so that the shift by e^{σ} never overflows.
  const mapQ = (sg, t) => Math.atan(sg * Math.exp(penSigma - t));

  function rebuildPenroseStatic() {
    const st = S.st, N = 160;
    const right = [], bottom = [];
    for (let i = 1; i < N; i++) {                                // antipode (right edge), I⁻ (bottom edge)
      const P0 = -HALF * i / N, U0 = Math.tan(P0);
      right.push([U0, ...st.labelFromV0log(-1 / U0)]);
      bottom.push([U0, ...st.labelFromV0log(1 / U0)]);
    }
    S.pen.right = right;
    S.pen.bottom = bottom.reverse();
    S.pen.corner = st.labelFromV0log(0);

    // Apparent horizon r = r_c(M(u)) in every region (future part assumes no more emission).
    const ah = [];
    const nR = st.aR.length;
    for (let k = 0; k < nR; k++) {
      const uLo = k === 0 ? Math.min(-12, (st.shellU.length ? st.shellU[0] : 0) - 8) : st.shellU[k - 1];
      const uHi = k < nR - 1 ? st.shellU[k] : uLo + 60;
      const M = 80, seg = [];
      for (let i = 0; i <= M; i++) {
        const u = uLo + (uHi - uLo) * i / M;
        const uu = i === M && k < nR - 1 ? u - 1e-9 : u;
        seg.push([st.tau(uu), ...st.labelVlog(uu, st.aR[k])]);
      }
      ah.push(seg);
    }
    S.pen.ah = ah;
    S.pen.ver = st.version;
  }

  function updatePQ(s) {
    const st = S.st, pq = s.pq, wl = s.wl;
    if (pq.ver !== st.version) { pq.ver = st.version; pq.P.length = 0; pq.S.length = 0; pq.T.length = 0; }
    const n = wl.committed;
    for (let i = pq.P.length; i < n; i++) {
      const [sg, t] = st.labelVlog(wl.U[i], wl.R[i]);
      pq.P.push(st.tau(wl.U[i])); pq.S.push(sg); pq.T.push(t);
    }
  }

  function updateTail(s) {
    const st = S.st;
    const t = tailOf(st, s.wl);
    const P = [], Sg = [], T = [], Uu = [];
    for (let i = 0; i < t.U.length; i++) {
      if (i % 2 && i !== t.U.length - 1) continue;
      const [sg, tt] = st.labelVlog(t.U[i], t.R[i]);
      Uu.push(t.U[i]); P.push(st.tau(t.U[i])); Sg.push(sg); T.push(tt);
    }
    s.tail = { P, S: Sg, T, U: Uu, ver: st.version };
  }

  // lnU / V arrays → polyline
  function strokeRaw(c, g, L, Sg, T, i0 = 0, i1 = L.length) {
    c.beginPath();
    for (let i = i0; i < i1; i++) {
      const [x, y] = toXY(g, mapP(L[i]), mapQ(Sg[i], T[i]));
      if (i === i0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  // Worldline: solid for the determined past (u ≤ u_now, i.e. up to your future light
  // cone), dashed for the prediction beyond it (assumes you emit nothing more).
  function drawWorldline(c, g, s, solid, dashed) {
    const t = s.tail;
    let k = 0;
    while (k < t.U.length && t.U[k] <= S.u) k++;
    c.strokeStyle = solid;
    strokeRaw(c, g, s.pq.P, s.pq.S, s.pq.T);
    if (k > 0) strokeRaw(c, g, t.P, t.S, t.T, 0, Math.min(k + 1, t.U.length));
    if (k < t.U.length) {
      c.setLineDash([4, 4]);
      c.strokeStyle = dashed;
      strokeRaw(c, g, t.P, t.S, t.T, Math.max(0, k - 1), t.U.length);
      c.setLineDash([]);
    }
  }

  function drawPenrose() {
    const st = S.st;
    if (S.pen.ver !== st.version) rebuildPenroseStatic();
    const refreshTails = S.frame - S.tailFrame > 30 || S.tailVer !== st.version;
    if (refreshTails) { S.tailFrame = S.frame; S.tailVer = st.version; }
    penSigma = penMode === 'now' ? S.tau : 0;

    const { w, h, dpr } = fit(pen);
    const c = cN;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const g = penGeom();
    const Pn = mapP(S.tau), Qn = mapQ(-1, S.tau);
    const eS = Math.exp(-penSigma);

    // Outline and clip.
    const outline = new Path2D();
    const pts = [[0, -HALF], [HALF, 0], [0, HALF]];               // you (left edge), I⁺ (top edge)
    for (const [U0, sg, t] of S.pen.right) pts.push([Math.atan(U0 * eS), mapQ(sg, t)]);
    pts.push([-HALF, mapQ(...S.pen.corner)]);
    for (const [U0, sg, t] of S.pen.bottom) pts.push([Math.atan(U0 * eS), mapQ(sg, t)]);
    pts.forEach(([P, Q], i) => { const [x, y] = toXY(g, P, Q); if (i) outline.lineTo(x, y); else outline.moveTo(x, y); });
    outline.closePath();
    // The far side (antipode, I⁻) is relabelled by the shells and gets squeezed hard when
    // re-centred; keep everything inside the conformal square.
    const square = new Path2D();
    [[0, -HALF], [HALF, 0], [0, HALF], [-HALF, 0]].forEach(([P, Q], i) => { const [x, y] = toXY(g, P, Q); if (i) square.lineTo(x, y); else square.moveTo(x, y); });
    square.closePath();
    c.save();
    c.clip(square);
    c.save();
    c.clip(outline);
    c.fillStyle = '#060913'; c.fill(outline);

    const quad = (Pa, Pb, Qa, Qb, fill) => {
      c.beginPath();
      [[Pa, Qa], [Pb, Qa], [Pb, Qb], [Pa, Qb]].forEach(([P, Q], i) => { const [x, y] = toXY(g, P, Q); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
      c.closePath(); c.fillStyle = fill; c.fill();
    };
    quad(-HALF, HALF, -HALF, 0, 'rgba(90,130,255,0.08)');       // everything you will ever see
    quad(-HALF, Pn, -HALF, Qn, 'rgba(255,210,122,0.10)');        // everything you have seen so far

    // Worldlines.
    c.lineWidth = 0.8;
    for (const s of S.sources) {
      if (s.kind !== 'star' || !ui.stars) continue;
      updatePQ(s);
      if (refreshTails || !s.tail) { if (!s.gone || !s.tail || s.tail.ver !== st.version) updateTail(s); }
      drawWorldline(c, g, s, 'rgba(159,176,224,0.24)', 'rgba(159,176,224,0.14)');
    }
    c.lineWidth = 1.3;
    for (const s of S.sources) {
      if (s.kind !== 'beacon') continue;
      updatePQ(s);
      if (refreshTails || !s.tail) { if (!s.gone || !s.tail || s.tail.ver !== st.version) updateTail(s); }
      drawWorldline(c, g, s, `hsla(${s.hue},85%,68%,0.85)`, `hsla(${s.hue},85%,68%,0.4)`);
    }

    // Apparent horizon.
    c.strokeStyle = 'rgba(127,208,255,0.9)';
    c.lineWidth = 1.5;
    for (const seg of S.pen.ah) strokeRaw(c, g, seg.map(p => p[0]), seg.map(p => p[1]), seg.map(p => p[2]));

    // Event horizon V = 0.
    c.setLineDash([5, 4]);
    c.strokeStyle = 'rgba(232,238,255,0.7)';
    c.lineWidth = 1;
    { const [x1, y1] = toXY(g, HALF, 0), [x2, y2] = toXY(g, -HALF, 0); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    c.setLineDash([]);

    // Your light cones now.
    c.strokeStyle = 'rgba(255,210,122,0.95)';
    c.lineWidth = 1.6;
    { const [x1, y1] = toXY(g, Pn, Qn), [x2, y2] = toXY(g, -HALF, Qn); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    c.strokeStyle = 'rgba(255,210,122,0.35)';
    c.lineWidth = 1;
    { const [x1, y1] = toXY(g, Pn, Qn), [x2, y2] = toXY(g, Pn, HALF - Pn); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }

    // What you are seeing right now: emission events on the past cone.
    for (const s of S.sources) {
      const e = s.obs;
      if (!e || e.z1 > Z_LOST || (s.kind === 'star' && !ui.stars)) continue;
      const [x, y] = toXY(g, mapP(st.tau(e.u)), mapQ(...st.labelVlog(e.u, e.r)));
      c.fillStyle = s.kind === 'star' ? 'rgba(230,236,255,0.6)' : `hsl(${s.hue},85%,68%)`;
      circle(c, x, y, s.kind === 'star' ? 1.4 : 2.6); c.fill();
    }
    c.restore();

    c.strokeStyle = 'rgba(232,238,255,0.55)';
    c.lineWidth = 1.2;
    c.stroke(outline);
    c.restore();
    { const [x, y] = toXY(g, Pn, Qn); c.fillStyle = '#ffd27a'; circle(c, x, y, 4); c.fill(); }

    c.font = '13px Inter, system-ui, sans-serif';
    c.fillStyle = 'rgba(200,210,240,0.85)';
    c.textAlign = 'center';
    c.fillText('I⁺', g.cx, g.cy - HALF * g.s - 7);
    c.save();
    c.translate(g.cx - HALF * g.s - 8, g.cy); c.rotate(-HALF);
    c.fillText('you (r = 0)', 0, 0);
    c.restore();
    c.save();
    c.translate(g.cx + HALF * g.s + 8, g.cy); c.rotate(HALF);
    c.fillText('antipode', 0, 0);
    c.restore();
    if (penMode === 'now') {
      c.textAlign = 'left';
      c.fillStyle = 'rgba(255,210,122,0.9)';
      const [x, y] = toXY(g, Pn, Qn);
      c.fillText('now', x + 8, y + 4);
    }
  }

  // ---------- beacon list ----------
  function updateList() {
    const bs = S.sources.filter(s => s.kind === 'beacon').slice(-16).reverse();
    const el = $('beacons');
    if (!bs.length) { el.innerHTML = '<p class="muted">No beacons yet. Tap the sky to launch one.</p>'; return; }
    el.innerHTML = bs.map(s => {
      const e = s.obs;
      const sw = `<span class="sw" style="background:hsl(${s.hue},85%,68%)"></span>`;
      const head = `${sw}<b>B${s.id}</b>`;
      if (!e || e.z1 > Z_LOST) {
        const why = s.wl.absorbed ? 'fell back into you' : 'gone: 1+z &gt; 10⁷';
        return `<div class="b gone">${head}<span>last message #${s.msg}</span><span>${why}</span></div>`;
      }
      const col = Colors.rgb(e.lam, false);
      const z = e.z1 < 1000 ? e.z1.toFixed(e.z1 < 10 ? 2 : 1) : e.z1.toExponential(1);
      return `<div class="b">${head}<span>message #${Math.floor(e.tau / MSG_PERIOD)}</span><span>1+z = ${z}</span>` +
             `<span style="color:${rgba(col.map(x => Math.max(x, 70)), 1)}">${Colors.formatLambda(e.lam)} · ${Colors.band(e.lam)}</span></div>`;
    }).join('');
  }

  // ---------- readouts ----------
  function updateHUD() {
    if ($('hud').hidden) return;
    const st = S.st, a = st.aNow, m = st.mNow;
    $('hTau').textContent = S.tau.toFixed(2);
    $('hM').textContent = m.toFixed(3);
    $('hRc').textContent = a.toFixed(3);
    $('hEdge').textContent = DS.coneMaxR(S.cone).toFixed(3);
    $('hDef').textContent = m === 0 ? 'none' : (360 * (1 - a)).toFixed(0) + '°';
    $('hS').textContent = a.toFixed(3);
  }

  // ---------- events ----------
  const store = {
    get(k) { try { return localStorage.getItem('ch.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('ch.' + k, v); } catch (e) { /* storage unavailable */ } },
  };

  sky.addEventListener('pointerdown', ev => {
    const rect = sky.getBoundingClientRect();
    const { cx, cy } = skyGeom();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (Math.hypot(x - cx, y - cy) < 2) return;
    fire(Math.atan2(-(y - cy), x - cx), S.ring || ev.shiftKey);
  });

  function setPlaying(p) {
    S.playing = p;
    $('play').innerHTML = `<svg><use href="#i-${p ? 'pause' : 'play'}"/></svg>`;
    $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  }
  $('play').addEventListener('click', () => setPlaying(!S.playing));
  $('ring').addEventListener('click', () => {
    S.ring = !S.ring;
    $('ring').setAttribute('aria-pressed', String(S.ring));
    $('hint').textContent = S.ring ? 'Tap the sky to emit a shell of 12 beacons' : 'Tap the sky to launch a beacon';
  });
  $('reset').addEventListener('click', () => { reset(); $('hint').classList.remove('hidden'); });

  let view = 'sky';
  let penMode = store.get('penMode') === 'full' ? 'full' : 'now';
  function setPenMode(m) {
    penMode = m;
    $('pFull').setAttribute('aria-pressed', String(m === 'full'));
    $('pNow').setAttribute('aria-pressed', String(m === 'now'));
    store.set('penMode', m);
  }
  $('pFull').addEventListener('click', () => setPenMode('full'));
  $('pNow').addEventListener('click', () => setPenMode('now'));
  const wideMQ = window.matchMedia('(min-width: 1000px)');
  function setView(v) {
    if (v === 'both' && !wideMQ.matches) v = 'sky';
    view = v;
    const showSky = v !== 'penrose', showPen = v !== 'sky';
    $('vSky').setAttribute('aria-selected', String(v === 'sky'));
    $('vBoth').setAttribute('aria-selected', String(v === 'both'));
    $('vPen').setAttribute('aria-selected', String(v === 'penrose'));
    $('view').classList.toggle('both', v === 'both');
    sky.hidden = !showSky; pen.hidden = !showPen;
    spec.hidden = !showSky; $('legend').hidden = !showPen;
    $('hint').style.display = showSky ? '' : 'none';
    $('penZoom').hidden = !showPen;
    store.set('view', v);
  }
  $('vSky').addEventListener('click', () => setView('sky'));
  $('vBoth').addEventListener('click', () => setView('both'));
  wideMQ.addEventListener('change', () => { if (view === 'both' && !wideMQ.matches) setView('sky'); });
  $('vPen').addEventListener('click', () => setView('penrose'));

  function setHUD(on) {
    $('hud').hidden = !on;
    $('hudBtn').setAttribute('aria-pressed', String(on));
    store.set('hud', on ? '1' : '0');
    updateHUD();
  }
  $('hudBtn').addEventListener('click', () => setHUD($('hud').hidden));

  const sheetBtns = [...document.querySelectorAll('[data-sheet]')];
  function closeSheets() {
    for (const b of sheetBtns) {
      const el = $(b.dataset.sheet);
      b.setAttribute('aria-expanded', 'false');
      if (el.hidden || el.classList.contains('closing')) continue;
      el.classList.add('closing');
      el._t = setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 180);
    }
  }
  for (const b of sheetBtns) {
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      const el = $(b.dataset.sheet), open = el.hidden || el.classList.contains('closing');
      closeSheets();
      if (open) {
        clearTimeout(el._t);
        el.classList.remove('closing');
        el.hidden = false; b.setAttribute('aria-expanded', 'true');
        if (b.dataset.sheet === 'beaconSheet') updateList();
        if (b.dataset.sheet === 'aboutSheet') renderMath(el);
      }
    });
  }
  for (const x of document.querySelectorAll('[data-close]')) x.addEventListener('click', closeSheets);
  document.addEventListener('pointerdown', ev => {
    // Menus stay open while you play (sky, toolbar); other clicks outside close them.
    if (!ev.target.closest('.sheet, [data-sheet], #view, .toolbar')) closeSheets();
  });

  let mathDone = false;
  function renderMath(el) {
    if (mathDone || typeof renderMathInElement !== 'function') return;
    renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false });
    mathDone = true;
  }

  window.addEventListener('keydown', ev => {
    if (ev.code === 'Space' && ev.target === document.body) { ev.preventDefault(); setPlaying(!S.playing); }
    if (ev.key === 'Escape') closeSheets();
  });

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (S.playing) S.tau += ui.speed * dt;
    step();
    if (view !== 'penrose') { drawSky(now); drawSpectrum(); }
    if (view !== 'sky') drawPenrose();
    if (S.frame % 6 === 0) updateHUD();
    if (S.frame % 10 === 0 && !$('beaconSheet').hidden) updateList();
    S.frame++;
    requestAnimationFrame(frame);
  }

  reset();
  { const v = store.get('view'); setView(v === 'penrose' || v === 'sky' || v === 'both' ? v : (wideMQ.matches ? 'both' : 'sky')); }
  setHUD(store.get('hud') === '1');
  setPenMode(penMode);
  window.cosmicHorizon = { state: () => S, fire: (phi, ring) => fire(phi, !!ring) };
  requestAnimationFrame(frame);
})();
