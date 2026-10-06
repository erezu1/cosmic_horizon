# Cosmic Horizon

An interactive toy for building intuition about the cosmological horizon.

You sit on a point mass in 2+1 de Sitter space. Launch beacons, watch the light they send back redshift into the horizon, and watch the horizon grow as you radiate your mass away.

Live: https://erezu1.github.io/cosmic_horizon/

## Physics

- Spacetime is outgoing Vaidya–de Sitter₃, an exact solution: `ds² = −f du² − 2du dr + r²dφ²`, `f = 1 − 8GM(u) − r²/ℓ²`. The point mass is a conical defect, with its horizon at `r_c = ℓ√(1−8GM)`.
- Each launch radiates Δm as an outgoing null shell. This is exact for a ring burst; a single beacon is an s-wave average.
- Light propagation is analytic within each constant-mass region. Redshifts are exact through every shell: `1+z = a_now / (u̇ f D)`, with `D = dv/du_arr` carried along the past light cone.
- Stars are Hubble-flow geodesics. Beacons are test particles launched at speed v, whose geodesics are integrated with RK4.

Run the physics checks with `node tests/run.js`. To run locally, serve the folder (`python3 -m http.server`) and open it.
