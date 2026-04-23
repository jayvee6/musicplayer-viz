// DataTexture adapter for audio-reactive shaders. Exposes the current frame's
// 32-bin mel magnitudes and 256-point waveform as 1D textures so fragment
// shaders can sample them directly — cleaner than `uniform float[N]` and
// lifts the WebGL uniform-array size limit. Unlocks polar plots, per-column
// reactive walls, in-shader oscilloscope draws, and any pattern that wants
// spatial lookup into the spectrum/waveform.
//
// Inspired by Daniel Sandner's Audio Shader Studio `u_frequencyTexture` /
// `u_timeDomainTexture` pattern (MIT — https://github.com/sandner-art/Audio-Shader-Studio).
//
// Usage in a viz:
//   const magsTex = window.VizAudioTex.getMagsTexture(frame);
//   mat.uniforms.u_mags = { value: magsTex };
//   // in fragment:
//   //   float m = texture2D(u_mags, vec2(uv.x, 0.5)).r;  // 0..1
//
//   const waveTex = window.VizAudioTex.getWaveformTexture(frame);
//   mat.uniforms.u_wave = { value: waveTex };
//   // in fragment:
//   //   float s = texture2D(u_wave, vec2(uv.x, 0.5)).r * 2.0 - 1.0;  // ±1
//
// Textures are shared across all viz — the helper uploads new data at most
// once per frame regardless of how many callers request it, keyed off
// frame.time so the per-frame work is O(1) amortized.

(() => {
  if (typeof THREE === 'undefined') return;

  const MAG_BINS     = 32;
  const WAVE_SAMPLES = 256;

  let magsTex   = null;
  let waveTex   = null;
  let magsBuf   = null;
  let waveBuf   = null;
  let lastMagsT = -1;
  let lastWaveT = -1;

  // LuminanceFormat + UnsignedByteType is the safest WebGL1 / r128 combo —
  // no float-texture extension required, one channel so both `.r` and `.x`
  // swizzles read the data in the fragment, smallest upload bandwidth.
  function createTex(width, initialData) {
    const tex = new THREE.DataTexture(
      initialData, width, 1, THREE.LuminanceFormat, THREE.UnsignedByteType
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS     = THREE.ClampToEdgeWrapping;
    tex.wrapT     = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  function getMagsTexture(frame) {
    if (!magsTex) {
      magsBuf = new Uint8Array(MAG_BINS);
      magsTex = createTex(MAG_BINS, magsBuf);
    }
    const t = (frame && frame.time) || 0;
    if (t === lastMagsT) return magsTex;
    lastMagsT = t;

    const src = frame && frame.magnitudes;
    if (src && src.length) {
      const n = Math.min(MAG_BINS, src.length);
      for (let i = 0; i < n; i++) {
        // Mags arrive post-AGC in ~0..1 range; quantize to 0..255 byte.
        const v = src[i];
        magsBuf[i] = v <= 0 ? 0 : (v >= 1 ? 255 : Math.round(v * 255));
      }
      for (let i = n; i < MAG_BINS; i++) magsBuf[i] = 0;
    } else {
      for (let i = 0; i < MAG_BINS; i++) magsBuf[i] = 0;
    }
    magsTex.needsUpdate = true;
    return magsTex;
  }

  function getWaveformTexture(frame) {
    if (!waveTex) {
      waveBuf = new Uint8Array(WAVE_SAMPLES);
      // Seed to center (silence = 0) so first-frame reads before audio
      // arrives don't produce a hard-edged pulse.
      waveBuf.fill(128);
      waveTex = createTex(WAVE_SAMPLES, waveBuf);
    }
    const t = (frame && frame.time) || 0;
    if (t === lastWaveT) return waveTex;
    lastWaveT = t;

    const src = frame && frame.waveform;
    if (src && src.length) {
      const n = Math.min(WAVE_SAMPLES, src.length);
      for (let i = 0; i < n; i++) {
        // Waveform is ~[-1, 1]; center to 0..255 so zero-crossing is 128
        // and the shader can do `v * 2.0 - 1.0` to recover the signed value.
        const centered = 0.5 + src[i] * 0.5;
        const clamped  = centered < 0 ? 0 : (centered > 1 ? 1 : centered);
        waveBuf[i] = Math.round(clamped * 255);
      }
      for (let i = n; i < WAVE_SAMPLES; i++) waveBuf[i] = 128;
    } else {
      for (let i = 0; i < WAVE_SAMPLES; i++) waveBuf[i] = 128;
    }
    waveTex.needsUpdate = true;
    return waveTex;
  }

  window.VizAudioTex = {
    getMagsTexture,
    getWaveformTexture,
    MAG_BINS,
    WAVE_SAMPLES,
  };
})();
