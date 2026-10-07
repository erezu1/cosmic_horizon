(function () {
  'use strict';
  const { Spacetime, Worldline, makeHubbleStar, findEmission, tailOf } = DS;
  const $ = id => document.getElementById(id);
  const PI = Math.PI, HALF = PI / 2, TAU = 2 * PI;

  const SEEN_AT_LAUNCH = 260;   // nm: beacons are tuned so you first receive them in the UV (white-hot)
  // Everything you launch leaves at nearly the speed of light, so the mass it carries travels
  // with it as a null shell (exact Vaidya, up to 1 − v = 0.1%), yet it can still signal back.
  const V_LAUNCH = 0.999;
  const GAMMA_LAUNCH = 1 / Math.sqrt(1 - V_LAUNCH * V_LAUNCH);
  const DOP_LAUNCH = Math.sqrt((1 + V_LAUNCH) / (1 - V_LAUNCH));   // ≈ 45: launch Doppler factor
  const MSG_PERIOD = 0.15 / DOP_LAUNCH;   // beacon proper time per message: one per 0.15ℓ of yours at launch
  const Z_LOST = 1e7;           // beyond this, treat a source as gone from view
  const N_STARS = 90;
  // Drawn thickness along the line of sight: the true flattening f·u̇ spans several decades
  // (≈1/50 … 0 at 0.999c), so it is shown on a log scale: 1 → 1, 1/1000 and below → 0.2.
  const drawnSquash = q => 0.2 + 0.8 * Math.min(1, Math.max(0, 1 + Math.log10(Math.max(Math.abs(q), 1e-12)) / 3.5));
  const GALAXY_GLOW = { r: 1.3, a: 0.18 }, BEACON_GLOW = { r: 1.9, a: 0.5 };   // halo radius (× iconR), strength
  // Outer radius of every galaxy and beacon icon: fixed on a given screen (brightness only fades
  // it), scaled with the size of the sky so icons keep their proportions on wide screens.
  let iconR = 6.5;
  const BEACON_FRAC = 0.4;        // beacon ball radius as a fraction of iconR
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
    ui.ir = $('ir').checked;
    ui.oldH = $('oldH').checked;
    ui.stars = $('galaxies').checked;
    $('speedVal').textContent = ui.speed.toFixed(2) + ' ℓ/c per s';
    $('dmVal').textContent = ui.dm.toFixed(2) + ' c²/8G';
    const pending = S && Math.abs(ui.m0 - S.m0) > 1e-9;
    $('m0Val').textContent = ui.m0.toFixed(2) + ' c²/8G' + (pending ? ' · on reset' : '');
  }
  for (const id of ['speed', 'dm', 'm0', 'ir', 'oldH', 'galaxies']) $(id).addEventListener('input', readUI);

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
  const M_GALAXIES = 0.2;          // mass (c²/8G) you launched as galaxies before τ = 0
  const STAR_BURSTS = [-3.4, -2.6, -1.9, -1.3, -0.8, -0.4];   // your proper time (ℓ)
  function reset() {
    readUI();
    const mStars = Math.min(M_GALAXIES, Math.max(0, 0.96 - ui.m0));
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
            lamEm: (260 + 220 * rnd()) / dop, jit: rnd(), rot: rnd() * TAU, tilt: 0.35 + 0.5 * rnd(),
            hint: 1e9, obs: null, pq: newPQ(), tail: null,
          });
        }
      }
    }
    const playing = S ? S.playing : true;
    S = { st, sources, tau: 0, u: 0, playing, m0: ui.m0, nBeacons: 0, flashes: [], frame: 0, cone: null,
          oldHorizons,
          pen: { ver: -1 }, tailFrame: -1 };
    readUI();
    step();
    updateList();
  }

  // Every launch is a shell: RING_N beacons evenly spaced, at a random overall rotation.
  function fire() {
    const st = S.st;
    // What you launch carries the mass: a thin shell leaving with the ring of beacons.
    // You can only give away mass you still have (the last launch takes the remainder).
    if (st.mNow <= 1e-9 && ui.dm > 0) {
      showHint('No mass left: you are empty de Sitter now', 2500);
      return;
    }
    const dm = Math.min(ui.dm, st.mNow);
    if (dm > 1e-9) { S.oldHorizons.push(st.aNow); st.addShell(S.u, dm); }
    const a = st.aR[st.region(S.u)];
    const v = V_LAUNCH, g = GAMMA_LAUNCH;
    const n = RING_N, phi = Math.random() * TAU;
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
    showHint(null);
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
  // In the infrared camera, fade out smoothly over the last two decades before Z_LOST.
  const irFade = z1 => Math.min(1, Math.max(0, (Math.log10(Z_LOST) - Math.log10(z1)) / 2));

  // Brightness follows the received colour: full up to blue, then fading steeply,
  // so reds are already faint and the infrared nearly gone (schematic, not photometric).
  // Canvas elements that come and go (labels, the dashed horizon) fade over the same FX_MS as the
  // HTML panels: fade(key, on) eases a per-key level towards 1 or 0 and returns the eased alpha.
  const fadeLevel = {};
  let frameDt = 0;
  function fade(key, on) {
    const v0 = fadeLevel[key] ?? (on ? 1 : 0);
    const step = frameDt * 1000 / FX_MS;
    const v = on ? Math.min(1, v0 + step) : Math.max(0, v0 - step);
    fadeLevel[key] = v;
    return 1 - Math.pow(1 - v, 3);               // ease-out, like the CSS curve
  }

  const brightness = (z1, lam) => Math.min(1, Math.pow(lam / 450, -3));

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
    iconR = Math.max(6.5, 0.036 * R);

    c.fillStyle = '#0b1120';
    c.fillRect(0, 0, w, h);

    // Edge of what you can see now: the outermost point of your past light cone.
    // After an emission it grows from the old r_c towards the new one as light from the
    // newly enclosed region arrives (over ~ℓ), while r_c(M_now) itself jumps at once.
    const rEdge = DS.coneMaxR(S.cone);

    // Inside the visible edge: a flat, slightly lighter disc.
    c.fillStyle = '#0f1729'; circle(c, cx, cy, rEdge * R); c.fill();

    // Reference circles in areal radius.
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(243,234,216,0.06)';
    for (const r of [0.25, 0.5, 0.75]) { circle(c, cx, cy, r * R); c.stroke(); }
    c.setLineDash([3, 5]);
    c.strokeStyle = 'rgba(243,234,216,0.22)';
    circle(c, cx, cy, R); c.stroke();
    c.setLineDash([]);
    c.fillStyle = '#9fb0c8';
    c.font = '400 11px "Space Mono", monospace';
    c.textAlign = 'center';
    c.fillText('r = ℓ · empty dS', cx, cy + R + 15 < h - 4 ? cy + R + 15 : cy + R - 7);
    c.textAlign = 'center';

    // Earlier horizons.
    if (ui.oldH) {
      c.setLineDash([2, 4]);
      c.strokeStyle = 'rgba(255,92,138,0.3)';
      for (const a of S.oldHorizons) if (Math.abs(a - aNow) > 1e-4) { circle(c, cx, cy, a * R); c.stroke(); }
      c.setLineDash([]);
    }

    // Horizon set by your mass now (jumps when you emit).
    const rh = aNow * R;
    const catching = fade('catching', aNow - rEdge > 2e-4);   // 0…1: dashed circle and its labels
    if (catching > 0) {
      c.globalAlpha = catching;
      c.setLineDash([5, 4]);
      c.strokeStyle = 'rgba(255,92,138,0.75)';
      c.lineWidth = 1.5;
      circle(c, cx, cy, rh); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }

    // The visible horizon (solid).
    const re = rEdge * R;
    c.strokeStyle = '#ff5c8a';
    c.lineWidth = 2;
    circle(c, cx, cy, re); c.stroke();
    // Labels carry a small sample of the line they name: dashed = apparent horizon (fainter),
    // solid = visible edge. When the two coincide there is one line and one label.
    const tagged = (txt, y, color, dashed, below) => {
      c.font = '700 11px "Space Mono", monospace';
      c.textAlign = 'left';
      const tw = c.measureText(txt).width, sw = 18, gap = 7, x0 = cx - (sw + gap + tw) / 2;
      if (below) { c.fillStyle = '#0b1120'; c.beginPath(); c.roundRect(x0 - 7, y - 13, sw + gap + tw + 14, 18, 6); c.fill(); }
      c.strokeStyle = color; c.lineWidth = dashed ? 1.5 : 2; c.setLineDash(dashed ? [5, 4] : []);
      c.beginPath(); c.moveTo(x0, y - 4); c.lineTo(x0 + sw, y - 4); c.stroke(); c.setLineDash([]);
      c.fillStyle = color; c.fillText(txt, x0 + sw + gap, y);
      c.textAlign = 'center';
    };
    const ly = cy - rh - 8 < 12 ? cy - rh + 16 : cy - rh - 8;
    // Crossfade between the two-circle labels and the single "HORIZON" label.
    if (catching > 0) {
      c.globalAlpha = catching;
      tagged(`APPARENT HORIZON  r꜀ = ${aNow.toFixed(3)} ℓ`, ly, 'rgba(255,92,138,0.75)', true, false);
      tagged(`VISIBLE EDGE ${rEdge.toFixed(3)} ℓ`, cy + re + 17, '#ff5c8a', false, true);
    }
    if (catching < 1) {
      c.globalAlpha = 1 - catching;
      tagged(`HORIZON  r꜀ = ${aNow.toFixed(3)} ℓ`, ly, '#ff5c8a', false, false);
    }
    c.globalAlpha = 1;

    // Sources.
    if (ui.stars) for (const s of S.sources) if (s.kind === 'star') drawStar(c, s, cx, cy, R);
    labelsOn = fade('beaconNames', isShown($('beaconSheet')));
    for (const s of S.sources) if (s.kind === 'beacon') drawBeacon(c, s, cx, cy, R);

    // You: a little rocket, larger the more mass you still carry.
    const rm = 3 + 7 * mNow;
    rocket(c, cx, cy, (1.2 * rm + 8) * iconR / 6.5);

    // Launch flashes (just a UI cue at your position).
    S.flashes = S.flashes.filter(f => now - f.t < 700);
    for (const f of S.flashes) {
      const p = (now - f.t) / 700;
      c.strokeStyle = `rgba(255,170,90,${0.6 * (1 - p)})`;
      c.lineWidth = 2;
      circle(c, cx, cy, rm + 30 * p); c.stroke();
    }

  }

  // A minimal rocket silhouette of height H centred on (x, y), nose up.
  function rocket(c, x, y, H) {
    const w = 0.3 * H, top = y - 0.5 * H, bot = y + 0.3 * H;
    c.fillStyle = '#f3ead8';
    c.beginPath();
    c.moveTo(x, top);                                                     // nose
    c.quadraticCurveTo(x + 0.62 * w, top + 0.3 * H, x + 0.5 * w, bot - 0.1 * H);
    c.lineTo(x + w, y + 0.5 * H);                                         // right fin
    c.lineTo(x + 0.3 * w, bot);
    c.lineTo(x - 0.3 * w, bot);
    c.lineTo(x - w, y + 0.5 * H);                                         // left fin
    c.lineTo(x - 0.5 * w, bot - 0.1 * H);
    c.quadraticCurveTo(x - 0.62 * w, top + 0.3 * H, x, top);
    c.fill();
  }

  // Galaxies and beacons share one frame: centred on the image, flattened along your line of
  // sight by what light from the object's near and far ends implies (f·u̇, log-scaled), with a
  // faint glow. drawFn draws the icon itself with outer radius iconR at the origin.
  function iconFrame(c, s, cx, cy, R, irBoost, glow, drawFn) {
    const e = s.obs;
    if (!e || e.z1 > Z_LOST) return null;
    const x = cx + e.r * R * Math.cos(s.phi), y = cy - e.r * R * Math.sin(s.phi);
    const col = Colors.rgb(e.lam, ui.ir);
    let al = brightness(e.z1, e.lam);
    if (ui.ir) al = Math.max(al, irBoost * irFade(e.z1));
    al = Math.min(1, al);
    c.save();
    c.translate(x, y); c.rotate(-s.phi);
    c.scale(drawnSquash(e.squash), 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, iconR * glow.r);
    g.addColorStop(0, rgba(col, glow.a * al));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; circle(c, 0, 0, iconR * glow.r); c.fill();
    drawFn(col, al);
    c.restore();
    return { x, y, al };
  }

  function drawStar(c, s, cx, cy, R) {
    iconFrame(c, s, cx, cy, R, 0.6, GALAXY_GLOW, (col, al) => galaxy(c, 0, 0, iconR, s.rot, s.tilt, col, al));
  }

  // A small two-armed spiral galaxy of outer radius R: bright bulge, logarithmic arms, tilted.
  const ARM_END = 1.7 * PI, ARM_K = 0.33, ARM_R0 = 1 / Math.exp(ARM_K * ARM_END);   // arms end at r = R
  function galaxy(c, x, y, R, rot, tilt, col, al) {
    c.save();
    c.translate(x, y); c.rotate(rot); c.scale(1, tilt);
    c.lineCap = 'round';
    for (let arm = 0; arm < 2; arm++) {
      c.beginPath();
      for (let k = 0; k <= 24; k++) {
        const th = ARM_END * k / 24, r = ARM_R0 * R * Math.exp(ARM_K * th);
        const px = r * Math.cos(th + arm * PI), py = r * Math.sin(th + arm * PI);
        if (k) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.strokeStyle = rgba(col, 0.7 * al);
      c.lineWidth = Math.max(0.8, 0.18 * R);
      c.stroke();
    }
    const gb = c.createRadialGradient(0, 0, 0, 0, 0, 0.4 * R);
    gb.addColorStop(0, `rgba(255,255,255,${al})`);
    gb.addColorStop(0.45, rgba(col, al));
    gb.addColorStop(1, rgba(col, 0));
    c.fillStyle = gb; circle(c, 0, 0, 0.4 * R); c.fill();
    c.restore();
  }


  let labelsOn = false;
  function drawBeacon(c, s, cx, cy, R) {
    // A small solid ball with a stronger glow, flattened like a galaxy.
    const p = iconFrame(c, s, cx, cy, R, 0.75, BEACON_GLOW, (col, al) => {
      c.fillStyle = rgba(col, al);
      circle(c, 0, 0, BEACON_FRAC * iconR); c.fill();
    });
    if (!p) return;
    const { x, y, al } = p, e = s.obs;
    if (labelsOn > 0) {             // names only while the beacon list is open (faded in and out)
      c.fillStyle = `rgba(230,236,255,${labelsOn * (0.45 + 0.4 * Math.min(1, al))})`;
      c.font = '400 11px "Space Mono", monospace';
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
    c.fillStyle = '#121a2b'; c.fillRect(0, 0, w, h);
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

    c.font = '400 10.5px "Space Mono", monospace';
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
      // Same dot for galaxies and beacons; beacons keep their orange.
      const a = 0.25 + 0.5 * brightness(e.z1, e.lam);
      c.fillStyle = s.kind === 'star' ? `rgba(230,236,255,${a})` : PEN.beacon;
      circle(c, x, top + 4 + s.jit * (bot - top - 8), 1.3); c.fill();
    }
  }

  // ---------- Penrose diagram ----------
  function penGeom() {
    const w = pen.clientWidth, h = pen.clientHeight - 92;   // bottom: legend + Now/Full overlay
    const pad = 46;   // room for the "Now" label left of the diagram
    return { cx: w / 2, cy: h / 2 + 6, s: (Math.min(w, h) / 2 - pad) / HALF };
  }
  const PEN = {
    space: '#0e1626', frame: 'rgba(243,234,216,0.45)', halo: '#0b1120', muted: '#9fb0c8',
    past: '#ffc94d', pastFill: 'rgba(255,201,77,0.16)',
    future: '#7ec8ff', futureFill: 'rgba(126,200,255,0.11)',
    horizon: '#ff5c8a', horizonDim: 'rgba(255,92,138,0.75)',
    you: '#3fc1c9',
    now: '#f3ead8', galaxy: 'rgba(185,167,255,0.6)', galaxyFuture: 'rgba(185,167,255,0.28)',
    beacon: '#ff6b35', beaconFuture: 'rgba(255,107,53,0.45)',
  };
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
    c.fillStyle = PEN.space; c.fill(outline);

    const quad = (Pa, Pb, Qa, Qb, fill) => {
      c.beginPath();
      [[Pa, Qa], [Pb, Qa], [Pb, Qb], [Pa, Qb]].forEach(([P, Q], i) => { const [x, y] = toXY(g, P, Q); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
      c.closePath(); c.fillStyle = fill; c.fill();
    };
    quad(-HALF, Pn, -HALF, Qn, PEN.pastFill);       // your past: everything you have seen
    quad(Pn, HALF, Qn, HALF, PEN.futureFill);       // your future: everything you can still reach

    // Worldlines.
    c.lineWidth = 1.4;
    for (const s of S.sources) {
      if (s.kind !== 'star' || !ui.stars) continue;
      updatePQ(s);
      if (refreshTails || !s.tail) { if (!s.gone || !s.tail || s.tail.ver !== st.version) updateTail(s); }
      drawWorldline(c, g, s, PEN.galaxy, PEN.galaxyFuture);
    }
    c.lineWidth = 2;
    for (const s of S.sources) {
      if (s.kind !== 'beacon') continue;
      updatePQ(s);
      if (refreshTails || !s.tail) { if (!s.gone || !s.tail || s.tail.ver !== st.version) updateTail(s); }
      drawWorldline(c, g, s, PEN.beacon, PEN.beaconFuture);
    }

    // Your light cones now.
    c.strokeStyle = PEN.past;
    c.lineWidth = 3;
    { const [x1, y1] = toXY(g, Pn, Qn), [x2, y2] = toXY(g, -HALF, Qn); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    c.strokeStyle = PEN.future;
    c.lineWidth = 2.4;
    { const [x1, y1] = toXY(g, Pn, Qn), [x2, y2] = toXY(g, Pn, HALF - Pn); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }

    // Apparent horizon (dashed) and event horizon V = 0 (solid): the same hot colour.
    c.strokeStyle = PEN.horizonDim;
    c.lineWidth = 2;
    c.setLineDash([6, 5]);
    { const all = S.pen.ah.flat(); strokeRaw(c, g, all.map(p => p[0]), all.map(p => p[1]), all.map(p => p[2])); }
    c.setLineDash([]);
    c.strokeStyle = PEN.horizon;
    c.lineWidth = 3;
    { const [x1, y1] = toXY(g, HALF, 0), [x2, y2] = toXY(g, -HALF, 0); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }

    // The visible edge: where your past light cone crosses the apparent-horizon staircase. After a
    // launch this is on a jump of the staircase (a shell), between the old and the new r_c.
    {
      let best = null;
      for (const sg of S.cone.segs) {
        if (sg.uLo === -Infinity) continue;
        const r = DS.rOf((sg.v - sg.uLo) / 2, sg.a, sg.side);
        const kIn = st.region(sg.uLo) - 1;           // region just before this shell
        if (kIn >= 0 && r > st.aR[kIn] + 1e-6 && (!best || r > best.r)) best = { u: sg.uLo, r };
      }
      if (best) {
        const [x, y] = toXY(g, mapP(st.tau(best.u)), mapQ(...st.labelVlog(best.u - 1e-9, best.r)));
        c.strokeStyle = PEN.horizon; c.lineWidth = 2;
        circle(c, x, y, 5); c.stroke();
      }
    }

    // What you are seeing right now: emission events on the past cone.
    for (const s of S.sources) {
      const e = s.obs;
      if (!e || e.z1 > Z_LOST || (s.kind === 'star' && !ui.stars)) continue;
      const [x, y] = toXY(g, mapP(st.tau(e.u)), mapQ(...st.labelVlog(e.u, e.r)));
      c.fillStyle = s.kind === 'star' ? PEN.galaxy : PEN.beacon;
      circle(c, x, y, s.kind === 'star' ? 1.8 : 3); c.fill();
    }
    c.restore();

    c.strokeStyle = PEN.frame;
    c.lineWidth = 1.5;
    c.stroke(outline);
    c.restore();

    // Labels, written on the diagram (each with a dark halo so lines never cut through them).
    const top = g.cy - HALF * g.s, bot = g.cy + HALF * g.s, left = g.cx - HALF * g.s;
    const label = (txt, x, y, color, align = 'left', rot = 0, size = 12, alpha = 1) => {
      if (alpha <= 0) return;
      c.save();
      c.globalAlpha = alpha;
      c.translate(x, y); c.rotate(rot);
      c.font = `700 ${size}px "Space Mono", monospace`;
      c.textAlign = align;
      c.lineJoin = 'round'; c.lineWidth = 4; c.strokeStyle = PEN.halo;
      c.strokeText(txt, 0, 0);
      c.fillStyle = color; c.fillText(txt, 0, 0);
      c.restore();
    };
    const [xn, yn] = toXY(g, Pn, Qn);
    label('Now', xn - 10, yn + 4, PEN.now, 'right', 0, 13);
    // Inside each triangle: the cones are at 45°, so keep the text below/above the diagonal.
    label('Past', xn + 8, yn + 62, PEN.past, 'left', 0, 12, fade('penPast', yn + 66 < bot - 4));
    label('Future', xn + 8, yn - 70, PEN.future, 'left', 0, 12, fade('penFuture', yn - 84 > top + 4));
    {
      const [hx, hy] = toXY(g, 0.32, 0);
      label('event horizon', hx + 4, hy - 7, PEN.horizon, 'left', PI / 4, 11);
    }
    c.font = '700 12px "Space Mono", monospace';
    c.fillStyle = PEN.muted;
    c.textAlign = 'center';
    c.fillText('I⁺', g.cx, top - 8);

    // Your worldline (r = 0, the left edge): thick, in its own teal, labelled "you".
    c.strokeStyle = PEN.you; c.lineWidth = 4; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(left, top); c.lineTo(left, bot); c.stroke();
    c.save();
    c.translate(left - 14, (yn + bot) / 2); c.rotate(-HALF);   // centred on your past worldline, below Now
    c.font = '700 13px "Space Mono", monospace';
    c.fillStyle = PEN.you;
    c.textAlign = 'center';
    c.fillText('you', 0, 0);
    c.restore();

    // The Now dot goes on top of everything.
    c.fillStyle = PEN.now; c.strokeStyle = PEN.halo; c.lineWidth = 2.5;
    circle(c, xn, yn, 5.5); c.fill(); c.stroke();
  }

  // ---------- beacon list ----------
  function updateList() {
    const bs = S.sources.filter(s => s.kind === 'beacon').slice(-16).reverse();
    const el = $('beacons');
    if (!bs.length) { el.innerHTML = '<p class="muted">No beacons yet. Tap the sky to launch one.</p>'; return; }
    el.innerHTML = bs.map(s => {
      const e = s.obs;
      const sw = `<span class="sw" style="background:${PEN.beacon}"></span>`;
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
    $('hS').textContent = a.toFixed(3);
  }

  // ---------- transitions: one show/hide and one option selector, shared timing ----------
  const FX_MS = 220;                                       // the one duration (also --t in CSS)
  document.documentElement.style.setProperty('--t', FX_MS + 'ms');
  const isShown = el => !el.hidden && !el.classList.contains('fx-out');
  // Show or hide any panel, overlay or view: fade + slide in, the same in reverse on the way out.
  function setShown(el, on) {
    if (on === isShown(el)) return;
    clearTimeout(el._fxT);
    el.classList.remove('fx-in', 'fx-out');
    void el.offsetWidth;                                   // restart the animation
    if (on) { el.hidden = false; el.classList.add('fx-in'); }
    else {
      el.classList.add('fx-out');
      el._fxT = setTimeout(() => { el.hidden = true; el.classList.remove('fx-out'); }, FX_MS);
    }
  }
  // Option groups: slide the selector to the chosen option (instantly on first layout/resize).
  const segs = [...document.querySelectorAll('.seg')];
  for (const sg of segs) { const t = document.createElement('span'); t.className = 'seg-thumb'; sg.prepend(t); }
  function syncSeg(sg, instant) {
    const sel = sg.querySelector('[aria-selected="true"], [aria-pressed="true"]');
    const th = sg.querySelector('.seg-thumb');
    if (!sel || !th || !sel.offsetWidth) return;
    if (instant) th.style.transition = 'none';
    th.style.width = sel.offsetWidth + 'px';
    th.style.transform = `translateX(${sel.offsetLeft}px)`;
    if (instant) { void th.offsetWidth; th.style.transition = ''; }
  }
  const syncSegs = instant => segs.forEach(sg => syncSeg(sg, instant));
  window.addEventListener('resize', () => syncSegs(true));
  if (document.fonts) document.fonts.ready.then(() => syncSegs(true));

  // The hint at the top of the sky: shown for a while, only over the sky.
  let hintOn = false;
  const defaultHint = () => 'Tap the sky to emit a shell of 12 beacons';
  function updateHint() { setShown($('hint'), hintOn && view !== 'penrose'); }
  function showHint(text, ms) {
    clearTimeout(showHint._t);
    hintOn = text != null;
    if (hintOn) $('hint').textContent = text;
    updateHint();
    if (hintOn && ms) showHint._t = setTimeout(() => { hintOn = false; updateHint(); }, ms);
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
    fire();
  });

  function setPlaying(p) {
    S.playing = p;
    $('play').innerHTML = `<svg><use href="#i-${p ? 'pause' : 'play'}"/></svg>`;
    $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  }
  $('play').addEventListener('click', () => setPlaying(!S.playing));
  $('reset').addEventListener('click', () => {
    reset();
    showHint(defaultHint(), 7000);
  });

  let view = 'sky';
  let penMode = store.get('penMode') === 'full' ? 'full' : 'now';
  function setPenMode(m) {
    penMode = m;
    $('pFull').setAttribute('aria-pressed', String(m === 'full'));
    $('pNow').setAttribute('aria-pressed', String(m === 'now'));
    syncSeg($('penZoom'));
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
    syncSeg($('vSky').parentElement);
    setShown(sky, showSky); setShown(pen, showPen);
    setShown($('legend'), showPen); setShown($('penZoom'), showPen);
    if (showPen) syncSeg($('penZoom'), true);
    updateHint();
    store.set('view', v);
  }
  $('vSky').addEventListener('click', () => setView('sky'));
  $('vBoth').addEventListener('click', () => setView('both'));
  wideMQ.addEventListener('change', () => { if (view === 'both' && !wideMQ.matches) setView('sky'); });
  $('vPen').addEventListener('click', () => setView('penrose'));

  function setHUD(on) {
    setShown($('hud'), on);
    $('hudBtn').setAttribute('aria-pressed', String(on));
    store.set('hud', on ? '1' : '0');
    updateHUD();
  }
  $('hudBtn').addEventListener('click', () => setHUD(!isShown($('hud'))));

  const sheetBtns = [...document.querySelectorAll('[data-sheet]')];
  function closeSheets() {
    for (const b of sheetBtns) {
      const el = $(b.dataset.sheet);
      b.setAttribute('aria-expanded', 'false');
      setShown(el, false);
    }
  }
  for (const b of sheetBtns) {
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      const el = $(b.dataset.sheet), open = !isShown(el);
      closeSheets();
      if (open) {
        setShown(el, true); b.setAttribute('aria-expanded', 'true');
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
    frameDt = dt;
    last = now;
    if (S.playing) S.tau += ui.speed * dt;
    step();
    if (view !== 'penrose') drawSky(now);
    if (view !== 'sky') drawPenrose();
    drawSpectrum();
    if (S.frame % 6 === 0) updateHUD();
    if (S.frame % 10 === 0 && isShown($('beaconSheet'))) updateList();
    S.frame++;
    requestAnimationFrame(frame);
  }

  reset();
  { const v = store.get('view'); setView(v === 'penrose' || v === 'sky' || v === 'both' ? v : (wideMQ.matches ? 'both' : 'sky')); }
  setHUD(store.get('hud') === '1');
  setPenMode(penMode);
  syncSegs(true);
  // The opening hint fades out after 7 s (or on the first launch).
  showHint(defaultHint(), 7000);
  window.cosmicHorizon = { state: () => S, fire: () => fire() };
  requestAnimationFrame(frame);
})();
