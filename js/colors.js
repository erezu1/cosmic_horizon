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
    if (nm < 420) k = 0.35 + 0.65 * (nm - 380) / 40;
    else if (nm > 680) k = 0.35 + 0.65 * (750 - nm) / 70;
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

  function physicalRGB(nm) {
    if (nm < 380) return [150, 110, 255];
    if (nm < 750) return visibleRGB(nm);
    if (nm < 1e6) {
      const t = Math.log10(nm / 750) / Math.log10(1e6 / 750);
      return lerp([150, 10, 10], [80, 30, 30], t);
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

  return { visibleRGB, physicalRGB, falseRGB, rgb, band, formatLambda, STOPS };
})();
