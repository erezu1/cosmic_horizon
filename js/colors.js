// Received wavelength → how it is drawn.
const Colors = (function () {
  'use strict';

  // Classic Bruton approximation of the visible spectrum.
  function visibleRGB(nm) {
    let r = 0, g = 0, b = 0;
    if (nm < 440) { r = -(nm - 440) / 60; b = 1; }
    else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
    else if (nm < 510) { g = 1; b = -(nm - 510) / 20; }
    else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
    else if (nm < 645) { r = 1; g = -(nm - 645) / 65; }
    else { r = 1; }
    let k = 1;
    if (nm > 680) k = 0.35 + 0.65 * (750 - nm) / 70;
    const c = x => Math.round(255 * Math.pow(Math.max(0, x * k), 0.8));
    return [c(r), c(g), c(b)];
  }

  function band(nm) {
    if (nm < 380) return 'UV';
    if (nm < 750) return 'visible';
    if (nm < 1e6) return 'infrared';
    if (nm < 1e9) return 'microwave';
    return 'radio';
  }

  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));

  // OKLCH → sRGB (0–255), reducing chroma until the colour fits the sRGB gamut.
  function oklchRGB(L, C, hDeg) {
    const enc = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
    for (let c = C; ; c *= 0.9) {
      const h = hDeg * Math.PI / 180, A = c * Math.cos(h), B = c * Math.sin(h);
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
      const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
      const q = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
      const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q,
      ];
      if (rgb.every(x => x >= -1e-4 && x <= 1 + 1e-4) || c < 1e-3) {
        return rgb.map(x => Math.round(255 * enc(Math.min(1, Math.max(0, x)))));
      }
    }
  }

  // Spectral hue in OKLCH degrees, by wavelength (nm).
  const HUE = [[380, 305], [420, 290], [450, 268], [475, 245], [495, 205], [515, 160], [545, 135],
               [570, 112], [590, 82], [620, 52], [660, 36], [700, 29], [750, 26]];
  function hueOf(nm) {
    if (nm <= HUE[0][0]) return HUE[0][1];
    for (let i = 1; i < HUE.length; i++) {
      if (nm <= HUE[i][0]) {
        const t = (nm - HUE[i - 1][0]) / (HUE[i][0] - HUE[i - 1][0]);
        return HUE[i - 1][1] + t * (HUE[i][1] - HUE[i - 1][1]);
      }
    }
    return HUE[HUE.length - 1][1];
  }

  // Perceptual colour for a received wavelength: the hue follows the spectrum, while the
  // lightness only ever decreases with wavelength (white-hot UV → … → dark red), so a
  // reddening source dims steadily instead of pulsing through bright cyan/yellow bands.
  function physicalRGB(nm) {
    if (nm < 750) {
      const L = nm <= 300 ? 0.97 : nm <= 420 ? 0.97 - 0.15 * (nm - 300) / 120 : 0.82 - 0.22 * (nm - 420) / 330;
      const C = nm <= 300 ? 0 : nm <= 440 ? 0.17 * (nm - 300) / 140 : 0.17;
      return oklchRGB(L, C, hueOf(nm));
    }
    if (nm < 1e6) {
      // Continue smoothly from the red end of the visible palette into dark infrared.
      const t = Math.log10(nm / 750) / Math.log10(1e6 / 750);
      return lerp(physicalRGB(749.999), [70, 28, 28], Math.min(1, 3 * t));
    }
    if (nm < 1e9) return [85, 85, 100];
    return [65, 65, 78];
  }

  // "Infrared camera": false colour over log λ, so nothing ever becomes invisible.
  const STOPS = [
    [2.4, [235, 235, 255]], [2.75, [120, 200, 255]], [3.2, [90, 240, 150]],
    [4.5, [255, 230, 80]], [6, [255, 140, 50]], [8, [255, 70, 110]], [10, [210, 90, 255]],
  ];
  function falseRGB(nm) {
    const x = Math.log10(nm);
    if (x <= STOPS[0][0]) return STOPS[0][1];
    for (let i = 1; i < STOPS.length; i++) {
      if (x <= STOPS[i][0]) {
        const t = (x - STOPS[i - 1][0]) / (STOPS[i][0] - STOPS[i - 1][0]);
        return lerp(STOPS[i - 1][1], STOPS[i][1], t);
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  function rgb(nm, irCam) { return irCam ? falseRGB(nm) : physicalRGB(nm); }

  function formatLambda(nm) {
    if (nm < 1e3) return nm.toFixed(0) + ' nm';
    if (nm < 1e6) return (nm / 1e3).toPrecision(3) + ' µm';
    if (nm < 1e9) return (nm / 1e6).toPrecision(3) + ' mm';
    return (nm / 1e9).toPrecision(3) + ' m';
  }

  return { visibleRGB, oklchRGB, physicalRGB, falseRGB, rgb, band, formatLambda, STOPS };
})();
