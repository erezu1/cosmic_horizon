// Physics checks:  node tests/run.js
const DS = require('../js/physics.js');
const { Spacetime, Worldline, makeHubbleStar, findEmission, rstar } = DS;

let failures = 0;
function check(name, got, want, tol) {
  const err = Math.abs(got - want) / Math.max(1e-12, Math.abs(want));
  const ok = err <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got.toPrecision(10)}, want ${want.toPrecision(10)} (rel err ${err.toExponential(2)})`);
}

function observe(st, wl, tau) {
  const u = st.uOfTau(tau);
  wl.advance(st, u);
  return findEmission(wl, st.pastCone(u), st, 0);
}

// Arrival proper time of the ingoing ray through (u, r), read off the Penrose label V = −e^{−τ_arr}.
function arrival(st, u, r) { return -Math.log(-st.labelV(u, r)); }

// 1. Hubble star in a static region: 1+z = 1/(1 − r_e/r_c).
for (const m0 of [0, 0.5, 0.75]) {
  const st = new Spacetime(m0), a = st.aR[0];
  const wl = makeHubbleStar(st, 0.3 * a);
  for (const tau of [0, 0.7, 2.0, 4.0]) {
    const e = observe(st, wl, tau);
    check(`Hubble star m=${m0} τ=${tau}`, e.z1, 1 / (1 - e.r / a), 2e-6);
  }
}

// 2. Numerical geodesic vs analytic Hubble trajectory r/(a+r) ∝ e^{a u}.
{
  const st = new Spacetime(0.6), a = st.aR[0];
  const wl = makeHubbleStar(st, 0.2 * a);
  const u0 = wl.U[wl.U.length - 1], w0 = 0.2 * a / (a + 0.2 * a);
  wl.advance(st, 2.5);
  const n = wl.U.length - 1, u = wl.U[n];
  const w = w0 * Math.exp(a * (u - u0));
  check('geodesic vs analytic r(u)', wl.R[n], a * w / (1 - w), 1e-8);
}

// 3. Beacon at launch: kinematic Doppler only.
for (const v of [0.5, 0.8, 0.95]) {
  const st = new Spacetime(0.75), a = st.aR[0];
  const g = 1 / Math.sqrt(1 - v * v);
  const wl = new Worldline(0, 0, g * (1 - v) / a);
  const e = observe(st, wl, 1e-4);
  check(`launch Doppler v=${v}`, e.z1, Math.sqrt((1 + v) / (1 - v)), 2e-3);
}

// 4. Late-time e-folding: d ln(1+z)/dτ → 1/ℓ, independent of m.
for (const m0 of [0, 0.75]) {
  const st = new Spacetime(m0), a = st.aR[0];
  const wl = new Worldline(0, 0, (1 / Math.sqrt(1 - 0.64)) * 0.2 / a);
  const e1 = observe(st, wl, 8), e2 = observe(st, wl, 9);
  check(`e-fold rate m=${m0}`, Math.log(e2.z1 / e1.z1), 1, 2e-3);
}

// 5. Time-dependent metric: redshift formula vs direct time-of-flight of two signals,
//    through several shells, including a beacon overtaken by a later shell.
{
  const st = new Spacetime(0.8);
  const a0 = st.aR[0], v = 0.7, g = 1 / Math.sqrt(1 - v * v);
  const wl = new Worldline(0.2, 0, g * (1 - v) / a0);
  const star = makeHubbleStar(st, 0.6 * a0);
  const schedule = [[0.6, 0.15], [1.4, 0.2], [2.5, 0.25]];
  let u = 0;
  for (const [us, dm] of schedule) {
    wl.advance(st, us); star.advance(st, us);
    st.addShell(us, dm);
  }
  for (const tau of [1.0, 2.2, 3.5, 5.0]) {
    for (const [name, w] of [['beacon', wl], ['star', star]]) {
      u = st.uOfTau(tau);
      w.advance(st, u);
      const e = findEmission(w, st.pastCone(u), st, 0);
      // Independent check: 1+z = Δτ_obs / Δτ_src for two signals received δ apart.
      const dt = 1e-5;
      const e2 = findEmission(w, st.pastCone(st.uOfTau(tau + dt)), st, 0);
      const fd = dt / (e2.tau - e.tau);
      check(`shells: ${name} redshift vs time-of-flight τ=${tau}`, e.z1, fd, 1e-4);
      check(`shells: ${name} arrival time τ=${tau}`, arrival(st, e.u, e.r), tau, 1e-9);
    }
  }
}

// 6. Penrose labels: observer is UV = −1, I⁺ is UV = 1, event horizon V = 0.
{
  const st = new Spacetime(0.75);
  st.addShell(1.0, 0.2); st.addShell(2.0, 0.3);
  for (const u of [-1, 0.5, 1.5, 3]) {
    const U = Math.exp(st.tau(u));
    check(`observer UV=-1 at u=${u}`, U * st.labelV(u, 0), -1, 1e-12);
    check(`I+ UV=1 at u=${u}`, U * st.labelV(u, Infinity), 1, 1e-12);
  }
  check('event horizon V=0 (final region)', st.labelV(5, st.aNow) + 1, 1, 1e-12);
}

// 7. Horizon revival: light from just outside the OLD horizon reaches the observer
//    after a shell enlarges the horizon.
{
  const st = new Spacetime(0.75);
  const aOld = st.aR[0];
  st.addShell(0, 0.3);
  const V = st.labelV(-0.5, aOld * 1.01);
  console.log(`${V < 0 ? 'ok  ' : 'FAIL'} ray from 1.01·r_c(old) now reaches observer (V=${V.toExponential(3)})`);
  if (!(V < 0)) failures++;
}

// 8. Pre-game launches: shells at negative u (stars launched before τ = 0).
{
  const st = new Spacetime(0.84);
  const stars = [];
  for (const t of [-3.4, -1.9, -0.4]) {
    const u = st.uOfTau(t);
    st.addShell(u, 0.2 / 3);
    const a = st.aR[st.region(u)];
    stars.push(new Worldline(u, 0, (1 / Math.sqrt(1 - 0.09)) * 0.7 / a, 0));
  }
  check('clock: τ(u(0)) = 0', st.tau(st.uOfTau(0)) + 1, 1, 1e-12);
  check('mass at τ=0 is M0', st.mNow, 0.64, 1e-12);
  for (const tau of [0, 1.5]) {
    const u = st.uOfTau(tau);
    stars.forEach((w, i) => {
      w.advance(st, u);
      const e = findEmission(w, st.pastCone(u), st, 0);
      const dt = 1e-5;
      const e2 = findEmission(w, st.pastCone(st.uOfTau(tau + dt)), st, 0);
      check(`pre-game star ${i} redshift vs time-of-flight τ=${tau}`, e.z1, dt / (e2.tau - e.tau), 1e-4);
      check(`pre-game star ${i} arrival τ=${tau}`, arrival(st, e.u, e.r) + 10, tau + 10, 1e-10);
    });
  }
  const V = st.labelFromV0(-1 / Math.tan(-0.3));   // a point on the antipode's worldline
  console.log(`${isFinite(V) ? 'ok  ' : 'FAIL'} antipode label finite with pre-game shells (V=${V.toExponential(3)})`);
  if (!isFinite(V)) failures++;
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
