// Retro Space Film — full-pass post-processing for a 1970s sci-fi /
// Apollo-archival look. Applies chromatic aberration, scanlines, film
// grain, vignette, and a lifted-black teal/orange colour grade.
//
// Exposes:
//   window.RetroFilmShader  — shader object compatible with THREE.ShaderPass
//   window.makeRetroComposer(renderer, scene, camera)
//     → { composer, retroPass }   — ready-to-use EffectComposer + handle on
//        the retro pass so the caller can update `time` each frame.
//
// Depends on THREE + THREE.EffectComposer + THREE.RenderPass +
// THREE.ShaderPass + THREE.CopyShader (all loaded via CDN in index.html).

(() => {
  if (typeof THREE === 'undefined') return;

  const RetroFilmShader = {
    uniforms: {
      tDiffuse:        { value: null },
      time:            { value: 0.0 },
      grainAmount:     { value: 0.6 },
      scanlineAmount:  { value: 0.5 },
      chromaticAmount: { value: 0.4 },
      vignetteAmount:  { value: 0.8 },
      colorFade:       { value: 0.5 },
    },

    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    // All effects combine multiplicatively / additively onto the base frame.
    // Order matters: aberration → scanlines → grain → vignette → grade.
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float grainAmount;
      uniform float scanlineAmount;
      uniform float chromaticAmount;
      uniform float vignetteAmount;
      uniform float colorFade;

      varying vec2 vUv;

      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }

      void main() {
        vec2 uv = vUv;
        vec2 center = vec2(0.5);
        vec2 dir  = uv - center;
        float dist = length(dir);

        // Chromatic aberration — radial R/B split, G centre.
        vec2 offset = dir * chromaticAmount * 0.01;
        float r = texture2D(tDiffuse, uv + offset).r;
        float g = texture2D(tDiffuse, uv).g;
        float b = texture2D(tDiffuse, uv - offset).b;
        vec3 color = vec3(r, g, b);

        // Scanlines — subtle horizontal sine ripple.
        float scan = sin(uv.y * 800.0 + time * 10.0) * 0.04 * scanlineAmount;
        color -= scan;

        // Film grain — high-frequency per-pixel noise, time-varied.
        float grain = (random(uv + mod(time, 10.0)) - 0.5) * (grainAmount * 0.3);
        color += grain;

        // Vignette — smooth darkening toward the edges.
        float vign = smoothstep(0.85, 0.25, dist);
        color *= mix(1.0, vign, vignetteAmount);

        // Retro grade: lift blacks so dark regions are charcoal not pure
        // black, then apply a subtle teal-shadow / orange-highlight tint
        // scaled by colorFade so 0 = no grade, 1 = full film look.
        color = color * (1.0 - (colorFade * 0.2)) + (colorFade * 0.1);
        float lum = dot(color, vec3(0.299, 0.587, 0.114));
        vec3 shadowTint    = vec3(0.85, 0.96, 1.08);   // teal
        vec3 highlightTint = vec3(1.08, 0.98, 0.86);   // warm orange
        color *= mix(shadowTint, highlightTint,
                     smoothstep(0.0, 1.0, lum)) * 1.0 +
                 mix(vec3(1.0), vec3(1.0), 0.0) * 0.0;   // trick: keep structure
        // Apply the tint only proportionally to colorFade so it can be
        // dialled out entirely.
        color = mix(color, color * mix(shadowTint, highlightTint,
                                       smoothstep(0.0, 1.0, lum)),
                    colorFade * 0.6);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  };

  // Wraps a (renderer, scene, camera) trio in an EffectComposer whose
  // second pass is the retro filter. Caller is responsible for:
  //   - calling composer.setSize(w, h) on window resize (cheap per-frame)
  //   - advancing composer.passes[1].uniforms.time.value each frame
  //   - calling composer.render(dt) instead of renderer.render(...)
  function makeRetroComposer(renderer, scene, camera) {
    if (!THREE.EffectComposer) {
      console.warn('[retro-pass] THREE.EffectComposer not loaded; returning null');
      return null;
    }
    const composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const retroPass = new THREE.ShaderPass(RetroFilmShader);
    retroPass.renderToScreen = true;
    composer.addPass(retroPass);
    return { composer, retroPass };
  }

  window.RetroFilmShader   = RetroFilmShader;
  window.makeRetroComposer = makeRetroComposer;
})();
