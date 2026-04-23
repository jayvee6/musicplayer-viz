// Anamorphic Star Flare — full-pass post-processing for cross-shaped
// lens flares on the brightest pixels. Threshold the input, then blur
// separately along X and Y, and add the streaks back on top. Each
// bright specular spec grows horizontal + vertical rays — the "4-point
// star" look you see in Daft Punk RAM press photos and film stills.
//
// Exposes:
//   window.DiscoFlareShader — ShaderPass-compatible shader object
//   window.makeDiscoComposer(renderer, scene, camera)
//     → { composer, flarePass }
//
// Depends on THREE + THREE.EffectComposer + THREE.RenderPass +
// THREE.ShaderPass (all loaded via CDN in index.html, already included
// for the Lunar retro pass).

(() => {
  if (typeof THREE === 'undefined') return;

  const DiscoFlareShader = {
    uniforms: {
      tDiffuse:     { value: null },
      threshold:    { value: 0.70 },   // brightness floor for flare contribution
      flareStrength:{ value: 0.35 },   // how much streak is added back
      flareLength:  { value: 0.18 },   // screen-space span of each streak
    },

    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: /* glsl */ `
      precision highp float;

      uniform sampler2D tDiffuse;
      uniform float threshold;
      uniform float flareStrength;
      uniform float flareLength;

      varying vec2 vUv;

      // Extract pixels above the brightness threshold. Uses perceptual
      // luminance so red / cyan / white spotlights all contribute.
      vec3 brightOnly(vec4 c) {
        float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        float over = max(0.0, lum - threshold);
        return c.rgb * over;
      }

      void main() {
        vec3 base = texture2D(tDiffuse, vUv).rgb;

        // Separate horizontal + vertical blurs of the bright channel.
        // 24 taps each direction with linear falloff. Wider than a
        // gaussian would give — we want sharp spikes radiating, not
        // a soft bloom. Star length controlled by flareLength.
        vec3 hStreak = vec3(0.0);
        vec3 vStreak = vec3(0.0);
        const int TAPS = 24;
        for (int i = 1; i <= TAPS; i++) {
          float fi = float(i) / float(TAPS);
          float d  = fi * flareLength;
          float w  = (1.0 - fi);
          w = w * w;     // quadratic falloff → sharper spikes

          hStreak += brightOnly(texture2D(tDiffuse, vUv + vec2(d, 0.0))) * w;
          hStreak += brightOnly(texture2D(tDiffuse, vUv - vec2(d, 0.0))) * w;
          vStreak += brightOnly(texture2D(tDiffuse, vUv + vec2(0.0, d))) * w;
          vStreak += brightOnly(texture2D(tDiffuse, vUv - vec2(0.0, d))) * w;
        }
        // Normalize so the sum is weight-relative (TAPS, quadratic).
        float norm = 1.0 / float(TAPS);
        hStreak *= norm;
        vStreak *= norm;

        vec3 flare = (hStreak + vStreak) * flareStrength;

        // Slight tint shift toward cool white — movie flares are usually
        // neutral / slightly cool, not tinted to the source colour.
        flare = mix(flare, vec3(dot(flare, vec3(0.333))) * vec3(0.95, 0.98, 1.04),
                    0.35);

        gl_FragColor = vec4(base + flare, 1.0);
      }
    `,
  };

  function makeDiscoComposer(renderer, scene, camera) {
    if (!THREE.EffectComposer) {
      console.warn('[disco-pass] THREE.EffectComposer not loaded; returning null');
      return null;
    }
    const composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const flarePass = new THREE.ShaderPass(DiscoFlareShader);
    flarePass.renderToScreen = true;
    composer.addPass(flarePass);
    return { composer, flarePass };
  }

  window.DiscoFlareShader  = DiscoFlareShader;
  window.makeDiscoComposer = makeDiscoComposer;
})();
