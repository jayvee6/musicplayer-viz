// Lunar — raymarched cratered moon with a slow orbiting sun, multi-scale
// bump mapping, and a starfield + nebula background. Port of
// Packages/Core/Sources/Core/Rendering/Shaders/Lunar.metal from the iOS
// StudioJoeMusic app.
//
// Built up in steps:
//   Step 1 (this commit): scaffold — JS plumbing, uniforms, CPU rotY
//                        accumulator, register() call, placeholder shader
//                        that renders a simple disc so the mode button
//                        confirms the viz is wired before we drop in the
//                        200-line raymarch.
//   Step 2: hash / value-noise / 5-octave FBM helpers.
//   Step 3: bumpHeight + bumpGrad + microCraterDarken.
//   Step 4: craterBowl + moonSDF + moonNormal + raymarch + lighting + main.
//
// Depends on:
//   window.Viz         (B1) — registry
//   window.AudioEngine      — frame.bass, frame.treble, frame.valence, frame.energy
//   window.vizGL            — shared Three.js renderer + ortho camera
//   THREE global            — CDN

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  // Ported 1:1 from Lunar.metal. Metal → GLSL: float3 → vec3, saturate →
  // clamp(0,1), static → plain fn, atan2 → atan. 80-iteration raymarch,
  // analytic moon SDF with 8 named crater bowls, multi-scale FBM bump.
  const FS = `
    precision highp float;

    varying vec2 vUv;

    uniform float     u_time;
    uniform float     u_rotY;
    uniform float     u_bass;
    uniform float     u_treble;
    uniform vec2      u_resolution;
    uniform float     u_valence;
    uniform float     u_energy;
    uniform sampler2D u_moonTex;
    uniform sampler2D u_dispTex;     // NASA LDEM heightmap — real lunar elevation
    uniform float     u_texLoaded;   // 1.0 once the colour image is in
    uniform float     u_dispLoaded;  // 1.0 once the displacement map is in
    uniform float     u_bumpAmt;     // user slider; scales the tangent bump
    uniform float     u_beatPulse;   // raw beatPulse; pulses the starfield on detected beats
    uniform float     u_sunPhase;    // radians — CPU-accumulated sun orbit angle
    uniform float     u_ambient;     // 0..~0.3 — brightness of the shadowed side

    // ── Classic Perlin 3D (Gustavson / Ashima) ────────────────────────
    // Gradient noise — smoother and more organic than value noise, no
    // lumpy bubble artifacts. Returns [-1, 1]; we normalize to [0, 1]
    // at call sites that expect positive values.
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289((x * 34.0 + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

    float cnoise(vec3 P) {
      vec3 Pi0 = floor(P);
      vec3 Pi1 = Pi0 + vec3(1.0);
      Pi0 = mod289v3(Pi0);
      Pi1 = mod289v3(Pi1);
      vec3 Pf0 = fract(P);
      vec3 Pf1 = Pf0 - vec3(1.0);
      vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
      vec4 iy = vec4(Pi0.yy, Pi1.yy);
      vec4 iz0 = vec4(Pi0.z);
      vec4 iz1 = vec4(Pi1.z);
      vec4 ixy  = permute(permute(ix) + iy);
      vec4 ixy0 = permute(ixy + iz0);
      vec4 ixy1 = permute(ixy + iz1);
      vec4 gx0 = ixy0 * (1.0 / 7.0);
      vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
      gx0 = fract(gx0);
      vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
      vec4 sz0 = step(gz0, vec4(0.0));
      gx0 -= sz0 * (step(0.0, gx0) - 0.5);
      gy0 -= sz0 * (step(0.0, gy0) - 0.5);
      vec4 gx1 = ixy1 * (1.0 / 7.0);
      vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
      gx1 = fract(gx1);
      vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
      vec4 sz1 = step(gz1, vec4(0.0));
      gx1 -= sz1 * (step(0.0, gx1) - 0.5);
      gy1 -= sz1 * (step(0.0, gy1) - 0.5);
      vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
      vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
      vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
      vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
      vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
      vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
      vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
      vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
      vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010),
                                      dot(g100, g100), dot(g110, g110)));
      g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
      vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011),
                                      dot(g101, g101), dot(g111, g111)));
      g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
      float n000 = dot(g000, Pf0);
      float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
      float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
      float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
      float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
      float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
      float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
      float n111 = dot(g111, Pf1);
      vec3 fade_xyz = fade(Pf0);
      vec4 n_z = mix(vec4(n000, n100, n010, n110),
                     vec4(n001, n101, n011, n111), fade_xyz.z);
      vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
      float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
      return 2.2 * n_xyz;
    }

    // Remap Perlin output from [-1,1] into [0,1] for call sites that expect
    // a non-negative noise value (matches the old ln3 interface).
    float ln3(vec3 p) { return cnoise(p) * 0.5 + 0.5; }

    // Keep the old micro-crater hash — the lh1 function is a simple PRNG
    // used for independent cell-by-cell decisions and doesn't need gradient
    // noise properties.
    float lh1(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float lfbm(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * ln3(p);
        p = p * 2.01 + vec3(1.7, 9.2, 3.3);
        a *= 0.5;
      }
      return v;
    }

    // ── Bump map (shading only — never fed into SDF) ──────────────────
    // Pure NASA LDEM displacement. Colour-luminance fallback removed so
    // real elevation is the only driver — no double-bumping from the
    // colour map on top. During the ~200ms it takes the PNG to load the
    // surface reads as flat; acceptable for that brief window.
    float bumpHeight(vec3 p) {
      vec3 nPos = normalize(p);
      vec2 uv = vec2(
        atan(nPos.z, nPos.x) / (2.0 * 3.14159265) + 0.5,
        asin(clamp(nPos.y, -1.0, 1.0)) / 3.14159265 + 0.5
      );
      return texture2D(u_dispTex, uv).r;
    }

    vec3 bumpGrad(vec3 p) {
      // Wider epsilon than the iOS version — the LDEM heightmap has much
      // sharper texel-scale transitions (real elevation data, not smooth
      // procedural noise), so a tight epsilon picks up single-pixel
      // spikes and gives craters hard black rings. Sampling ~3 texels
      // apart averages those spikes into readable relief.
      float e = 0.006;
      vec2 k = vec2(e, 0.0);
      float inv2e = 1.0 / (2.0 * e);
      return vec3(
        bumpHeight(p + k.xyy) - bumpHeight(p - k.xyy),
        bumpHeight(p + k.yxy) - bumpHeight(p - k.yxy),
        bumpHeight(p + k.yyx) - bumpHeight(p - k.yyx)) * inv2e;
    }

    // Micro-crater albedo darkening — 27-cell neighborhood hash sample.
    float microCraterDarken(vec3 p, float cellScale) {
      vec3 pS   = p * cellScale;
      vec3 cell = floor(pS);
      vec3 frac = fract(pS);
      float dark = 0.0;
      for (int dz = -1; dz <= 1; dz++) {
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            vec3 offset = vec3(float(dx), float(dy), float(dz));
            vec3 ncell  = cell + offset;
            float r1    = lh1(ncell);
            if (r1 < 0.70) continue;
            float r2    = lh1(ncell + 77.3);
            vec3 center = offset + vec3(r2, fract(r1 * 43.0), fract(r2 * 91.0)) * 0.7 + 0.15;
            float cR    = 0.12 + r2 * 0.25;
            float d     = length(frac - center) / cR;
            if (d >= 1.0) continue;
            float bowl = 1.0 - d * d;
            dark += bowl * (0.15 + r2 * 0.20);
          }
        }
      }
      return dark;
    }

    // ── Moon SDF ──────────────────────────────────────────────────────
    float craterBowl(vec3 p, vec3 c, float r) {
      float d = clamp(length(p - c) / r, 0.0, 1.0);
      float w = 1.0 - d * d;
      return -w * w * r * 0.08;
    }

    float moonSDF(vec3 p, float bass) {
      float R = 0.65 + bass * 0.04;
      float sdf = length(p) - R;
      sdf += craterBowl(p, normalize(vec3( 0.30,  0.55,  0.78)) * R, 0.22);
      sdf += craterBowl(p, normalize(vec3(-0.55,  0.20,  0.81)) * R, 0.15);
      sdf += craterBowl(p, normalize(vec3( 0.12, -0.60,  0.79)) * R, 0.17);
      sdf += craterBowl(p, normalize(vec3( 0.82,  0.10,  0.56)) * R, 0.12);
      sdf += craterBowl(p, normalize(vec3(-0.40, -0.30,  0.86)) * R, 0.11);
      sdf += craterBowl(p, normalize(vec3(-0.10,  0.83,  0.55)) * R, 0.14);
      sdf += craterBowl(p, normalize(vec3( 0.40, -0.55, -0.74)) * R, 0.19);
      sdf += craterBowl(p, normalize(vec3(-0.70,  0.25, -0.67)) * R, 0.13);
      // Note: removed the per-step lfbm silhouette-roughness term that the
      // iOS version carried. It ran 5 Perlin noises inside every one of
      // 80 raymarch steps plus 6 gradient samples — ~34K ops/pixel —
      // purely to roughen the silhouette. The LDEM bump already provides
      // all visible relief, so the SDF can stay analytic.
      return sdf;
    }

    // Analytic sphere normal — crater bowls are shallow enough (~0.08*r
    // depth) that their contribution to the normal is negligible for
    // lighting, and the LDEM bump in bumpGrad provides all the visible
    // surface relief. Replaces 6 moonSDF gradient samples with a single
    // normalize — saves ~50 craterBowl calls per hit pixel.
    vec3 moonNormal(vec3 p, float bass) {
      return normalize(p);
    }

    // ── Rotations ─────────────────────────────────────────────────────
    vec3 lrotY(vec3 p, float a) {
      float c = cos(a), s = sin(a);
      return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
    }
    vec3 lrotX(vec3 p, float a) {
      float c = cos(a), s = sin(a);
      return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z);
    }

    // ── Starfield ─────────────────────────────────────────────────────
    // Each hashed star is a soft disc with Perlin-noise-driven ambient
    // twinkle + a sharp beat-driven brightness kick. Perlin gives organic
    // breathing; beatPulse (raw, per-frame exponential from the onset
    // detector) multiplies brightness on top so every detected beat
    // flashes the whole sky.
    float starField(vec3 dir, float time, float treble, float beat) {
      vec3 d = normalize(dir);
      float s = 0.0;
      float beatKick = 1.0 + beat * 1.4;

      {
        vec3 cell = floor(d * 100.0);
        float r = lh1(cell);
        if (r > 0.989) {
          vec2 sub = fract(d.xy * 100.0) - 0.5;
          float dd = length(sub);
          float star = smoothstep(0.30, 0.0, dd);
          float n = cnoise(vec3(r * 12.3, r * 7.7, time * (0.6 + treble * 0.8)));
          float twinkle = (0.65 + 0.35 * n) * beatKick;
          s += star * twinkle;
        }
      }
      {
        vec3 cell = floor(d * 160.0);
        float r = lh1(cell + vec3(7.3, 2.1, 9.8));
        if (r > 0.996) {
          vec2 sub = fract(d.xy * 160.0) - 0.5;
          float dd = length(sub);
          float star = smoothstep(0.28, 0.0, dd);
          float n = cnoise(vec3(r * 9.1, r * 14.4, time * 0.9));
          s += star * (0.35 + 0.25 * n) * beatKick;
        }
      }
      return min(s, 1.0);
    }

    // ── Main ──────────────────────────────────────────────────────────
    void main() {
      float asp = u_resolution.x / u_resolution.y;
      vec2 uv = (vUv - 0.5) * vec2(asp, 1.0);

      vec3 ro = vec3(0.0, 0.0, 2.5);
      // Ray direction z tuned so the R=0.65 moon fills ~90% of the
      // landscape viewport height. Was -1.4 (~77%); tightening to -1.65
      // narrows the effective FOV and blows the moon up in frame.
      vec3 rd = normalize(vec3(uv, -1.65));

      float tilt   = 0.18;
      float boundR = 0.75;

      float b2   = dot(ro, rd);
      float disc = b2 * b2 - (dot(ro, ro) - boundR * boundR);

      vec3 col = vec3(0.0);
      bool showBg = false;

      if (disc < 0.0) {
        showBg = true;
      } else {
        float tStart = max(0.001, -b2 - sqrt(disc) - 0.05);
        float tEnd   = -b2 + sqrt(disc) + 0.05;
        float t      = tStart;
        bool  hit    = false;
        vec3  hitLocal = vec3(0.0);

        // Sphere-tracing on an analytic SDF converges fast — 50 iters is
        // plenty for an essentially-spherical surface with shallow crater
        // perturbations. Step multiplier 0.95 (up from 0.88) since the
        // SDF is much closer to exact once the per-step lfbm is gone.
        for (int i = 0; i < 50; i++) {
          vec3 wp = ro + rd * t;
          vec3 lp = lrotX(lrotY(wp, -u_rotY), -tilt);
          float d = moonSDF(lp, u_bass);
          if (d < 0.001) { hit = true; hitLocal = lp; break; }
          if (t > tEnd + 0.1) break;
          t += max(d * 0.95, 0.001);
        }

        if (hit) {
          vec3 nGeom = moonNormal(hitLocal, u_bass);

          // Tangent-plane bump perturbation (doesn't rotate silhouette).
          // Weight driven by the user's Bump slider.
          vec3 bg       = bumpGrad(hitLocal);
          vec3 tangGrad = bg - dot(bg, nGeom) * nGeom;
          vec3 n = normalize(nGeom - tangGrad * u_bumpAmt);

          float microDark = microCraterDarken(hitLocal, 26.0);

          // Real LROC lunar texture — carries the full albedo (maria /
          // highland variation, crater bright rays, subtle colour drift).
          // No extra tint on top — the texture is already colour-graded.
          vec3 nPos = normalize(hitLocal);
          vec2 texUV = vec2(
            atan(nPos.z, nPos.x) / (2.0 * 3.14159265) + 0.5,
            asin(clamp(nPos.y, -1.0, 1.0)) / 3.14159265 + 0.5
          );
          vec3 lroc = texture2D(u_moonTex, texUV).rgb;

          // Procedural greyscale fallback — shown only while u_texLoaded=0.
          float mariaV = lfbm(hitLocal * 1.9 + 3.1);
          float mariaM = smoothstep(0.38, 0.62, mariaV);
          vec3 fallback = vec3(mix(0.22, 0.82, mariaM));

          vec3 surf = mix(fallback, lroc, u_texLoaded);
          surf *= (1.0 - microDark * 0.18);

          // Sun orbits continuously — CPU accumulates u_sunPhase at a
          // base rate with a bass kick, giving a real lunar-cycle feel
          // where phases sweep across the surface. Slight fixed elevation
          // keeps the terminator from being a boring vertical line.
          float sunElev = 0.18;
          float ce      = cos(sunElev);
          vec3  sunWorld = vec3(sin(u_sunPhase) * ce,
                                sin(sunElev),
                                cos(u_sunPhase) * ce) * 6.0;
          vec3  sunLocal = lrotX(lrotY(sunWorld, -u_rotY), -tilt);

          vec3 toSun = sunLocal - hitLocal;
          float sunDist = length(toSun);
          vec3 L = toSun / sunDist;
          float sunAtten = clamp(36.0 / (sunDist * sunDist), 0.75, 1.15);

          float NdL = max(0.0, dot(n, L));
          // Softened terminator — widened from (0, 0.14) to (-0.1, 0.30)
          // so the shadow line rolls off organically instead of cutting
          // hard against crater bump normals that are wildly off the
          // geometric normal.
          float lit = smoothstep(-0.10, 0.30, NdL) * NdL;

          // Beat reactivity — the sun briefly flashes warmer and brighter
          // on each detected beat. beatPulse is a raw exp(-8*t) envelope
          // so this reads as a sharp pulse, not a slow drift.
          vec3  sunColor = vec3(1.00, 0.96, 0.88) * (1.0 + u_beatPulse * 0.35);
          vec3  skyFill  = vec3(0.32, 0.40, 0.55);

          col  = surf * sunColor * lit * sunAtten;
          col += surf * skyFill * 0.035 * max(0.25, 0.5 + 0.5 * nGeom.y);
          col += surf * u_ambient;          // user-controlled shadow-side fill
          col *= (1.0 + u_energy * 0.20);

          // Limb darkening — softened so the edge isn't overly shadowed
          // once the real texture supplies its own limb-tone variation.
          vec3 V = normalize(lrotX(lrotY(-rd, -u_rotY), -tilt));
          float NdV = max(0.0, dot(nGeom, V));
          col *= (0.65 + 0.35 * NdV);
        } else {
          showBg = true;
        }
      }

      if (showBg) {
        // Rotate the sample direction by the moon's rotY so the starfield
        // and nebula counter-rotate along with the scene — feels like you
        // are stationed in a 3D space where the moon and stars share a
        // rotating frame of reference, rather than the stars being painted
        // onto a skybox pinned to the camera.
        vec3 rdScene = lrotY(rd, -u_rotY);
        float s = starField(rdScene, u_time, u_treble, u_beatPulse);
        col = vec3(s) * vec3(0.92, 0.95, 1.0);
        float neb = lfbm(vec3(rdScene.xy * 0.9 + vec2(u_time * 0.012, 0.3), 0.5));
        vec3 nc = mix(vec3(0.0, 0.01, 0.04), vec3(0.02, 0.0, 0.05), u_valence);
        col += nc * neb * 0.35;
      }

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `;

  let scene     = null;
  let mat       = null;
  let rotY      = 0;
  let sunPhase  = 0;   // radians; CPU-accumulated sun orbit angle
  let lastT     = 0;
  let tex2K     = null;  // 2K LROC mosaic (~460 KB)
  let tex4K     = null;  // 4K LROC mosaic (~3 MB)
  let composer  = null;  // EffectComposer with retro film pass
  let retroPass = null;  // reference for updating `time` each frame

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    const gl = window.vizGL;
    if (!gl) { console.warn('[lunar] window.vizGL not ready'); return; }

    scene = new THREE.Scene();

    // LROC (Lunar Reconnaissance Orbiter Camera) colour mosaic.
    // Equirectangular — standard spherical projection so the shader can
    // UV via atan(z,x) + asin(y) straight off the hit point. Two res
    // variants shipped so the user can A/B detail vs. download cost:
    // 2K (460 KB) default, 4K (3 MB) on demand via the toggle.
    const loader = new THREE.TextureLoader();
    const prepTex = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      return t;
    };
    tex2K = prepTex(loader.load('textures/lroc_color_2k.jpg', () => {
      if (mat) mat.uniforms.u_texLoaded.value = 1.0;
    }));
    // 4K lazy-loaded — only fetched once the user flips the toggle so
    // the 2K variant isn't held up waiting on the larger download.
    tex4K = null;

    // NASA LDEM displacement map — real lunar elevation data. Drives
    // the tangent-plane bump so crater rims and maria basins show
    // genuine relief instead of an approximation of luminance.
    const dispTex = prepTex(loader.load('textures/ldem_2k.png', () => {
      if (mat) mat.uniforms.u_dispLoaded.value = 1.0;
    }));

    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_time:       { value: 0 },
        u_rotY:       { value: 0 },
        u_bass:       { value: 0 },
        u_treble:     { value: 0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        u_valence:    { value: 0.5 },
        u_energy:     { value: 0.5 },
        u_moonTex:    { value: tex2K },
        u_dispTex:    { value: dispTex },
        u_texLoaded:  { value: 0.0 },
        u_dispLoaded: { value: 0.0 },
        u_bumpAmt:    { value: 0.005 },
        u_sunPhase:   { value: 0 },
        u_ambient:    { value: 0.03 },
        u_beatPulse:  { value: 0 },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    // Retro film pass — wraps the shared renderer in an EffectComposer
    // whose second pass applies chromatic aberration, scanlines, grain,
    // vignette, and teal/orange colour grading. When Lunar is active
    // the render loop calls composer.render() instead of renderer.render()
    // so every pixel goes through the retro filter.
    if (typeof window.makeRetroComposer === 'function') {
      const built = window.makeRetroComposer(
        window.vizGL.renderer, scene, window.vizGL.camera
      );
      if (built) { composer = built.composer; retroPass = built.retroPass; }
    }
  }

  // Release GPU scene + shader material on mode-out so switching away
  // doesn't retain the full lunar pipeline (~10 passes incl. composer MRTs).
  // We deliberately keep tex2K/tex4K loaded — re-downloading the LROC
  // mosaics on re-entry would stall the first few frames on mobile.
  // Render's `if (!scene) init()` rebuilds the scene + material.
  function teardown() {
    if (scene) {
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    if (mat) mat.dispose();
    // composer.dispose() in r128 frees internal render targets; retroPass
    // references the composer's internal state so it goes with it.
    if (composer && typeof composer.dispose === 'function') composer.dispose();
    mat       = null;
    composer  = null;
    retroPass = null;
    scene     = null;
  }

  function use4K(flag) {
    if (!mat) return;
    if (flag) {
      if (!tex4K) {
        const loader = new THREE.TextureLoader();
        tex4K = loader.load('textures/lroc_color_4k.jpg', () => {
          if (mat && window.Viz.controlValue('lunar', 'hires')) {
            mat.uniforms.u_moonTex.value = tex4K;
          }
        });
        tex4K.wrapS = tex4K.wrapT = THREE.RepeatWrapping;
        tex4K.minFilter = THREE.LinearMipmapLinearFilter;
        tex4K.magFilter = THREE.LinearFilter;
      } else {
        mat.uniforms.u_moonTex.value = tex4K;
      }
    } else {
      mat.uniforms.u_moonTex.value = tex2K;
    }
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const dt = lastT === 0 ? (1 / 60) : Math.min(0.1, Math.max(0.001, t - lastT));
    lastT = t;

    const f = frame || {};
    // Shared rotation accumulator with Disco Ball — same formula, same
    // global so switching between "moon" and "disco" keeps the sphere
    // spinning continuously with no visual jump.
    window.vizSharedRotY = (window.vizSharedRotY || 0)
      + dt * (0.08 + (f.bass || 0) * 0.30);
    rotY = window.vizSharedRotY;

    // Sun orbit — auto-advances so phases cycle across the moon's face
    // like real-world lunar phases. Base rate ~0.04 rad/s = full cycle
    // every ~2.6 minutes. Bass nudges it forward.
    sunPhase += dt * (0.04 + (f.bass || 0) * 0.05);

    const u = mat.uniforms;
    u.u_time.value = t;
    u.u_rotY.value = rotY;
    u.u_bass.value   = f.bass   || 0;
    u.u_treble.value = f.treble || 0;
    u.u_resolution.value.set(window.innerWidth, window.innerHeight);
    u.u_valence.value = f.valence ?? 0.5;
    u.u_energy.value  = f.energy  ?? 0.5;
    // Tuned defaults — no user controls. Values settled via earlier
    // interactive tuning; hard-coded here so the moon looks right out
    // of the box without fiddling.
    u.u_bumpAmt.value   = 0.005;
    u.u_sunPhase.value  = sunPhase;
    u.u_ambient.value   = 0.03;
    u.u_beatPulse.value = f.beatPulse || 0;

    const retro = window.Viz.controlValue('lunar', 'retro');
    if (retro && composer && retroPass) {
      // Keep the composer's internal render targets in sync with window
      // size — cheap per-frame (Three.js no-ops when already at target size).
      composer.setSize(window.innerWidth, window.innerHeight);
      retroPass.uniforms.time.value = t;
      composer.render(dt);
    } else {
      // Either the toggle is off or the postprocessing modules failed
      // to load — render straight to the canvas.
      window.vizGL.renderer.render(scene, window.vizGL.camera);
    }
  }

  window.Viz.register({
    id:       'lunar',
    label:    'Lunar',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
    teardownFn: teardown,
    controls: [
      // One knob only — flip the retro film pass (chromatic aberration,
      // scanlines, grain, vignette, teal/orange grade) on or off.
      { id: 'retro', label: 'Retro', type: 'toggle', default: true },
    ],
  });
})();
