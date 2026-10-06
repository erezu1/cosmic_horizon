/*
 * Vaidya–de Sitter₃ physics engine.
 *
 * Units: ℓ = 1.  m ≡ 8GM,  a ≡ √(1−m) = r_c/ℓ.
 *
 * Metric (outgoing Eddington–Finkelstein, exact solution of 2+1 GR with Λ > 0 and null dust):
 *     ds² = −f(u,r) du² − 2 du dr + r² dφ²,      f = 1 − m(u) − r²
 * u is retarded time (labels outgoing light cones leaving the observer at r = 0).
 * m(u) is piecewise constant: it drops at each outgoing null shell the observer emits.
 * Between shells the metric is static SdS₃ = dS₃ with a conical defect of deficit 2π(1−a).
 *
 * Inside one constant-m region we use the tortoise coordinate r*(r) = ∫ dr / f
 * (r*(0) = 0 inside the horizon, r*(∞) = 0 outside), and v = u + 2 r* is constant
 * along ingoing light rays.  So all light propagation is analytic; only the massive
 * worldlines (stars, beacons) are integrated numerically.
 */
const DS = (function () {
  'use strict';

  const IN = 1, OUT = -1;

  // Tortoise coordinate for f = a² − r².
  function rstar(r, a) {
    if (r < a) return Math.atanh(r / a) / a;
    if (r > a) return 0.5 * Math.log((r + a) / (r - a)) / a;
    return Infinity;
  }

  // Inverse of rstar on the given side of the horizon.
  function rOf(x, a, side) {
    return side === IN ? a * Math.tanh(a * x) : a / Math.tanh(a * x);
  }

  // f = a² − r² evaluated at r = rOf(x), written to avoid cancellation near the horizon.
  function fOf(x, a, side) {
    const y = a * x;
    if (side === IN) { const c = Math.cosh(y); return (a * a) / (c * c); }
    const s = Math.sinh(y); return -(a * a) / (s * s);
  }

  class Spacetime {
    constructor(m0) {
      this.m0 = m0;
      this.shellU = [];                 // retarded times of the shells (increasing)
      this.mR = [m0];                   // m in region k (region k lies after shellU[k-1])
      this.aR = [Math.sqrt(1 - m0)];
      this.tauR = [0];                  // observer proper time at the start of region k
      this.uR = [0];                    // u at the start of region k (region 0: reference u = 0)
      this.version = 0;                 // bumps whenever the spacetime changes
    }

    get mNow() { return this.mR[this.mR.length - 1]; }
    get aNow() { return this.aR[this.aR.length - 1]; }

    // Index of the region containing u (shells at exactly u count as already passed).
    region(u) {
      const s = this.shellU;
      let lo = 0, hi = s.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] <= u) lo = mid + 1; else hi = mid; }
      return lo;
    }

    m(u) { return this.mR[this.region(u)]; }

    // Observer proper time as a function of retarded time:  dτ = √f(u,0) du = a(u) du.
    tau(u) {
      if (u === Infinity) return Infinity;
      const k = this.region(u);
      return this.tauR[k] + this.aR[k] * (u - this.uR[k]);
    }

    uOfTau(t) {
      for (let k = this.tauR.length - 1; k >= 1; k--) {
        if (t >= this.tauR[k]) return this.uR[k] + (t - this.tauR[k]) / this.aR[k];
      }
      return t / this.aR[0];
    }

    // The observer at r = 0 emits a null shell carrying Δm at retarded time u.
    addShell(u, dm) {
      const n = this.shellU.length;
      const mOld = this.mR[n];
      const mNew = Math.max(0, mOld - dm);
      if (!(mNew < mOld)) return false;
      if (n > 0 && Math.abs(u - this.shellU[n - 1]) < 1e-12) {
        this.mR[n] = mNew; this.aR[n] = Math.sqrt(1 - mNew);
      } else {
        const t = this.tau(u);
        this.shellU.push(u); this.mR.push(mNew); this.aR.push(Math.sqrt(1 - mNew));
        this.tauR.push(t); this.uR.push(u);
      }
      this.version++;
      return true;
    }

    /*
     * Past light cone of the observer event (r = 0, u = uArr): the ingoing null surface,
     * followed backwards region by region.  In region k it is v = v_k on one side of r_c,k.
     * D_k = dv_k / du_arr is carried along (exact; it changes only at the shells:
     * D_{k−1} = D_k · f_k(r_s) / f_{k−1}(r_s)).
     */
    pastCone(uArr) {
      const segs = [];
      let k = this.region(uArr), v = uArr, side = IN, D = 1, uHi = uArr;
      for (;;) {
        const a = this.aR[k];
        const uLo = k === 0 ? -Infinity : this.shellU[k - 1];
        segs.push({ k, a, uLo, uHi, v, side, D });
        if (k === 0) break;
        const r = rOf((v - uLo) / 2, a, side);
        const fk = a * a - r * r;
        const ap = this.aR[k - 1];
        const fp = ap * ap - r * r;
        side = r <= ap ? IN : OUT;
        v = uLo + 2 * rstar(r, ap);
        D = D * fk / fp;
        uHi = uLo; k--;
      }
      return { uArr, aNow: this.aR[this.region(uArr)], segs };
    }

    /*
     * Label of the ingoing light ray through (u, r), used as the second null coordinate
     * of the Penrose diagram.  Follow the ray forward through the shells (assuming no
     * further emission) until it reaches either the observer (r = 0) at u_end, giving
     * V = −exp(−τ(u_end)), or future infinity I⁺ at u_end, giving V = +exp(−τ(u_end)).
     * The observer's event horizon is V = 0.
     */
    labelV(u, r) { const [sg, t] = this.labelVlog(u, r); return sg * Math.exp(-t); }

    // The same label as V = s·exp(−t), returned as [s, t]: safe for any τ (no overflow).
    labelVlog(u, r) {
      if (r === Infinity) return [1, this.tau(u)];
      let k = this.region(u), a = this.aR[k];
      let side = r <= a ? IN : OUT;
      let v = u + 2 * rstar(r, a);
      for (;;) {
        const uEnd = k < this.shellU.length ? this.shellU[k] : Infinity;
        if (v <= uEnd) return [side === IN ? -1 : 1, this.tau(v)];
        const rr = rOf((v - uEnd) / 2, a, side);
        k++; a = this.aR[k];
        side = rr <= a ? IN : OUT;
        v = uEnd + 2 * rstar(rr, a);
      }
    }

    /*
     * Same label for a ray given by its Kruskal coordinate V0 in the initial (static,
     * m = m0) spacetime.  Needed for the part of the diagram behind the past horizon
     * (antipode, I⁻), which the u chart does not cover.
     */
    labelFromV0(V0) { const [sg, t] = this.labelFromV0log(V0); return sg * Math.exp(-t); }

    labelFromV0log(V0) {
      const a0 = this.aR[0];
      // A reference slice before the first shell (shells may lie at u < 0: pre-game launches).
      const uRef = Math.min(-1, this.shellU.length ? this.shellU[0] - 1 : -1);
      const U0 = Math.exp(a0 * uRef);
      const w = U0 * V0;
      if (w <= -1 || w >= 1) return [Math.sign(V0), -Math.log(Math.abs(V0))];   // ray ends before any shell
      return this.labelVlog(uRef, a0 * (1 + w) / (1 - w));
    }

    // Penrose null coordinates (P, Q) ∈ (−π/2, π/2)² of the point (u, r).
    pq(u, r) {
      return [Math.atan(Math.exp(this.tau(u))), Math.atan(this.labelV(u, r))];
    }
  }

  function coneSeg(cone, u) {
    const s = cone.segs;
    let lo = 0, hi = s.length - 1;       // segs ordered by decreasing u
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (u >= s[mid].uLo) hi = mid; else lo = mid + 1;
    }
    return s[lo];
  }

  // Outermost areal radius on the past light cone: the edge of the sky you can see now.
  // (r is monotone along each segment; the far end of the oldest segment tends to r_c,0.)
  function coneMaxR(cone) {
    let best = 0;
    for (const sg of cone.segs) {
      const rLo = sg.uLo === -Infinity ? sg.a : rOf((sg.v - sg.uLo) / 2, sg.a, sg.side);
      best = Math.max(best, rLo);
    }
    return best;
  }

  function coneR(cone, u) {
    const sg = coneSeg(cone, u);
    return rOf((sg.v - u) / 2, sg.a, sg.side);
  }

  /*
   * Radial timelike geodesics with u as the parameter.
   * Conserved p_r = −u̇ gives  du̇/dτ = −r u̇²  (independent of m),
   * normalisation gives       ṙ = (1 − f u̇²) / (2u̇).
   * Across a null shell only p_u jumps, so u̇ is continuous: the junction is automatic.
   */
  function drdu(r, ud, m) {
    const f = 1 - m - r * r;
    return (1 - f * ud * ud) / (2 * ud * ud);
  }

  function rk4(r, ud, m, h) {
    const k1r = drdu(r, ud, m), k1u = -r * ud, k1t = 1 / ud;
    let rr = r + 0.5 * h * k1r, uu = ud + 0.5 * h * k1u;
    const k2r = drdu(rr, uu, m), k2u = -rr * uu, k2t = 1 / uu;
    rr = r + 0.5 * h * k2r; uu = ud + 0.5 * h * k2u;
    const k3r = drdu(rr, uu, m), k3u = -rr * uu, k3t = 1 / uu;
    rr = r + h * k3r; uu = ud + h * k3u;
    const k4r = drdu(rr, uu, m), k4u = -rr * uu, k4t = 1 / uu;
    return [
      r + h / 6 * (k1r + 2 * k2r + 2 * k3r + k4r),
      ud + h / 6 * (k1u + 2 * k2u + 2 * k3u + k4u),
      h / 6 * (k1t + 2 * k2t + 2 * k3t + k4t),
    ];
  }

  const R_STOP = 1.02;   // beyond r = ℓ nothing can ever be seen again (m ≥ 0 ⇒ r_c ≤ ℓ)

  class Worldline {
    constructor(u0, r0, ud0, T0 = 0) {
      this.U = [u0]; this.R = [r0]; this.Ud = [ud0]; this.T = [T0];
      this.prov = false;   // last sample is a provisional partial step to "now"
      this.done = false;
    }

    get committed() { return this.U.length - (this.prov ? 1 : 0); }

    _push(u, r, ud, T) { this.U.push(u); this.R.push(r); this.Ud.push(ud); this.T.push(T); }

    // Integrate up to uTarget.  Steps never cross a shell; a final partial step to
    // uTarget is kept as provisional (a new shell may still be emitted at uTarget).
    advance(st, uTarget) {
      if (this.done) return;
      if (this.prov) { this.U.pop(); this.R.pop(); this.Ud.pop(); this.T.pop(); this.prov = false; }
      const n = this.U.length - 1;
      let u = this.U[n], r = this.R[n], ud = this.Ud[n], T = this.T[n];
      let guard = 0;
      while (u < uTarget && guard++ < 20000) {
        const k = st.region(u), m = st.mR[k];
        const uNext = k < st.shellU.length ? st.shellU[k] : Infinity;
        const d = Math.abs(drdu(r, ud, m));
        let h = Math.min(0.02, (0.003 + 0.02 * r) / Math.max(d, 1e-9));
        let toShell = false, prov = false;
        if (u + h >= uNext) { h = uNext - u; toShell = true; }
        if (u + h > uTarget) { h = uTarget - u; prov = true; toShell = false; }
        let s = rk4(r, ud, m, h);
        if (s[0] <= 0) {
          // Turned around by a shell and fell back to r = 0: it has hit you. End the
          // worldline exactly at r = 0 (bisect the step length) and stop.
          let lo = 0, hi = h;
          for (let it = 0; it < 50; it++) { const mid = 0.5 * (lo + hi); if (rk4(r, ud, m, mid)[0] > 0) lo = mid; else hi = mid; }
          s = rk4(r, ud, m, hi);
          this._push(u + hi, 0, s[1], T + s[2]);
          this.done = true; this.absorbed = true;
          break;
        }
        u = toShell ? uNext : u + h; r = s[0]; ud = s[1]; T += s[2];
        this._push(u, r, ud, T);
        if (prov) { this.prov = true; break; }
        if (r > R_STOP) { this.done = true; break; }
      }
    }
  }

  // Continue a worldline into the future assuming no further emission (Penrose display only).
  function tailOf(st, wl, rEnd = 25) {
    const n = wl.U.length - 1;
    let u = wl.U[n], r = wl.R[n], ud = wl.Ud[n];
    const U = [u], R = [r];
    if (wl.absorbed) return { U, R };
    let guard = 0;
    while (r < rEnd && guard++ < 4000) {
      const k = st.region(u), m = st.mR[k];
      const uNext = k < st.shellU.length ? st.shellU[k] : Infinity;
      const d = Math.abs(drdu(r, ud, m));
      let h = Math.min(0.15, (0.01 + 0.05 * r) / Math.max(d, 1e-9));
      let toShell = false;
      if (u + h >= uNext) { h = uNext - u; toShell = true; }
      const s = rk4(r, ud, m, h);
      if (s[0] <= 0) { U.push(u + h); R.push(0); break; }   // will fall back into you
      u = toShell ? uNext : u + h; r = s[0]; ud = s[1];
      U.push(u); R.push(r);
    }
    return { U, R };
  }

  /*
   * A "Hubble-flow" star: a geodesic with Killing energy E = a in the initial static
   * region, i.e. a comoving galaxy of the flat slicing (ṙ = r/ℓ exactly).
   * It is placed so that the observer sees it at areal radius rSeen at τ = 0.
   * Its earlier history is analytic:  r/(a+r) ∝ e^{a u},  dτ/du = a + r.
   */
  function makeHubbleStar(st, rSeen) {
    const a = st.aR[0];
    const ue = -2 * rstar(rSeen, a);
    const we = rSeen / (a + rSeen);
    const rMin = Math.min(0.002, 0.5 * rSeen);
    const uMin = ue + Math.log((rMin / (a + rMin)) / we) / a;
    const N = Math.max(8, Math.ceil((ue - uMin) / 0.04));
    const wl = new Worldline(0, 0, 1);
    wl.U = []; wl.R = []; wl.Ud = []; wl.T = [];
    for (let i = 0; i <= N; i++) {
      const u = i === N ? ue : uMin + (ue - uMin) * i / N;
      const w = we * Math.exp(a * (u - ue));
      const r = i === N ? rSeen : a * w / (1 - w);
      wl._push(u, r, 1 / (a + r), a * (u - ue) - Math.log(1 - w) + Math.log(1 - we));
    }
    return wl;
  }

  /*
   * Where does the past light cone of "now" cross a worldline, and what is the redshift?
   *
   * With v_k = u + 2r* along the cone segment and v̇ = 1/(f u̇) along any radial
   * timelike worldline (the double-null normalisation −f u̇ v̇ = −1):
   *     dτ_obs/dτ_src = a_now · (du_arr/dv_k) · (dv_k/dτ_src)
   *     1 + z = a_now / (u̇ · f · D_k)
   * exactly, through every shell the light crossed on its way in.
   */
  function findEmission(wl, cone, st, hint) {
    const U = wl.U, R = wl.R, Ud = wl.Ud, T = wl.T, n = U.length;
    if (n < 2) return null;
    const g = j => R[j] - coneR(cone, U[j]);
    let j = Math.max(0, Math.min(hint | 0, n - 2));
    if (g(j) > 0) { while (j > 0 && g(j) > 0) j--; if (g(j) > 0) return null; }
    while (j + 1 < n && g(j + 1) <= 0) j++;
    if (j + 1 >= n) return null;

    // Cubic Hermite interpolation of r(u) on [U_j, U_{j+1}] (no shell inside a step).
    const u0 = U[j], h = U[j + 1] - u0;
    const m = st.mR[st.region(u0)];
    const r0 = R[j], r1 = R[j + 1];
    const d0 = drdu(r0, Ud[j], m) * h, d1 = drdu(r1, Ud[j + 1], m) * h;
    const H = s => {
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * r0 + (s3 - 2 * s2 + s) * d0 + (-2 * s3 + 3 * s2) * r1 + (s3 - s2) * d1;
    };
    let lo = 0, hi = 1;
    for (let it = 0; it < 52; it++) {
      const mid = 0.5 * (lo + hi);
      if (H(mid) - coneR(cone, u0 + mid * h) <= 0) lo = mid; else hi = mid;
    }
    const s = 0.5 * (lo + hi);
    const ue = u0 + s * h;
    // Proper time: Hermite with dτ/du = 1/u̇.
    const s2 = s * s, s3 = s2 * s;
    const te = (2 * s3 - 3 * s2 + 1) * T[j] + (s3 - 2 * s2 + s) * h / Ud[j]
             + (-2 * s3 + 3 * s2) * T[j + 1] + (s3 - s2) * h / Ud[j + 1];
    const sg = coneSeg(cone, ue);
    const x = (sg.v - ue) / 2;
    const re = rOf(x, sg.a, sg.side);
    const fe = fOf(x, sg.a, sg.side);
    // Killing energy E = (f u̇² + 1)/(2u̇) is conserved inside a region, so u̇ at the
    // emission point follows exactly from E and f there:  f u̇² − 2E u̇ + 1 = 0.
    const fj = 1 - m - r0 * r0, fj1 = 1 - m - r1 * r1;
    const E = 0.5 * ((fj * Ud[j] * Ud[j] + 1) / (2 * Ud[j]) + (fj1 * Ud[j + 1] * Ud[j + 1] + 1) / (2 * Ud[j + 1]));
    const disc = Math.sqrt(Math.max(0, E * E - fe));
    const outgoing = (d0 + d1) >= 0;
    // outgoing branch: u̇ = 1/(E + √(E²−f)); ingoing: u̇ = (E + √(E²−f))/f
    const z1 = outgoing
      ? cone.aNow * (E + disc) / (fe * sg.D)
      : cone.aNow / ((E + disc) * sg.D);
    return { j, u: ue, r: re, tau: te, z1 };
  }

  return {
    IN, OUT, rstar, rOf, fOf, drdu, rk4,
    Spacetime, Worldline, coneR, coneMaxR, coneSeg, tailOf, makeHubbleStar, findEmission, R_STOP,
  };
})();

if (typeof module !== 'undefined') module.exports = DS;
