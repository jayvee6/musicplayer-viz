// Disco Ball — the moon's dressier cousin. Same sphere (R=0.65, same
// camera, same rotation accumulator) so switching from Lunar to Disco
// feels like the moon just lit up to party. Faceted mirror surface
// with per-tile randomized colours, beat-driven facet flashes, and
// radial light beams around the ball.
//
// Shares window.vizSharedRotY with Lunar so both visualizers advance
// the rotation angle continuously — no visual jump when switching.
//
// Depends on:
//   window.Viz         (B1) — registry
//   window.AudioEngine      — bass, treble, beatPulse, isBeatNow
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

  const FS = `
    precision highp float;

    varying vec2 vUv;

    uniform float u_time;
    uniform float u_rotY;
    uniform float u_bass;
    uniform float u_treble;
    uniform float u_beatPulse;
    uniform vec2  u_resolution;

    const float PI = 3.14159265359;

    // Cheap 3D hash for facet randomness.
    float dh(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    vec3 dhsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
                       0.0, 1.0);
      float c = (1.0 - abs(2.0 * l - 1.0)) * s;
      return vec3(l) + c * (rgb - 0.5);
    }

    vec3 lrotY(vec3 p, float a) {
      float c = cos(a), s = sin(a);
      return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
    }

    void main() {
      float asp = u_resolution.x / u_resolution.y;
      vec2 uv = (vUv - 0.5) * vec2(asp, 1.0);

      // Same camera parameters as Lunar so the two spheres overlap 1:1
      // when the user flips between modes — no size or position shift.
      vec3 ro = vec3(0.0, 0.0, 2.5);
      vec3 rd = normalize(vec3(uv, -1.65));
      float R = 0.65 + u_bass * 0.04;

      // Analytic ray-sphere intersection — no raymarch needed for a
      // pure sphere. Much cheaper than the moon's SDF loop.
      float b    = dot(ro, rd);
      float disc = b * b - (dot(ro, ro) - R * R);

      vec3 col = vec3(0.0);

      if (disc < 0.0) {
        // ── Background — share Lunar's starfield, add subtle radial beams ──
        // Rotate the ray direction with the shared spin so stars move
        // naturally between viz switches, same as Lunar.
        vec3 rdScene = lrotY(rd, -u_rotY);

        // Starfield — cell-hashed points rendered as soft discs with a
        // sin-driven twinkle. Stable per frame (not per-pixel random),
        // so no TV-static look. Beat-driven brightness kick shared across
        // the whole sky.
        vec3 cell = floor(rdScene * 120.0);
        float rnd = dh(cell);
        if (rnd > 0.988) {
          vec2 sub = fract(rdScene.xy * 120.0) - 0.5;
          float star = smoothstep(0.30, 0.0, length(sub));
          float tw   = 0.65 + 0.35 * sin(u_time * 2.8 + rnd * 37.0);
          col += vec3(0.92, 0.95, 1.0) * star * tw * (1.0 + u_beatPulse * 1.4);
        }

        // Strong blue radial beams — angle offset by u_rotY so the beam
        // pattern rotates in lock-step with the sphere. Creates the feel
        // of the ball throwing its mirrored light shafts out into the
        // room, sweeping as it spins. Shared atmosphere tint so ball
        // reflection and beams match.
        vec3 atmosphere = vec3(0.25, 0.45, 0.95);
        vec2 cv = vUv - 0.5;
        cv.x *= asp;
        float ang = atan(cv.y, cv.x) + u_rotY;
        float rr  = length(cv);
        float beamCell = floor(ang * 96.0 / (2.0 * 3.14159265));
        float beamH    = dh(vec3(beamCell, 0.0, 0.0));
        float flick    = 0.55 + 0.45 * sin(u_time * (1.5 + beamH * 3.0) + beamH * 20.0);
        float beam     = smoothstep(0.78, 1.0, beamH) * flick;
        beam *= exp(-max(0.0, rr - 0.32) * 2.2);
        beam *= 1.0 + u_beatPulse * 1.6;
        vec3 beamCol = mix(atmosphere,
                           atmosphere * 0.4 + vec3(0.4, 0.5, 0.6),
                           fract(beamH * 2.7));
        col += beamCol * beam * 1.1;

        // Soft atmospheric haze behind the beams — same tint, very low
        // intensity, falling off from centre.
        col += atmosphere * 0.08 * exp(-rr * 2.0);

        col += atmosphere * 0.01;  // barely-there ambient tint
      } else {
        // ── Ball: chrome mirror facets (Daft Punk RAM cover vibes) ───
        float t = -b - sqrt(disc);
        vec3 worldHit = ro + rd * t;
        vec3 lp = lrotY(worldHit, -u_rotY);
        vec3 n = normalize(lp);

        // Spherical (latitude/longitude) tile grid — real disco balls
        // have rectangular tiles arranged in rows of latitude, not
        // Cartesian-snapped voxels.
        float lat = asin(clamp(n.y, -1.0, 1.0));
        float lon = atan(n.z, n.x);
        // Denser tile grid — club-scale disco balls have many more tiles
        // than the big outdoor sun-lit kind. Matches the reference photo.
        float latRes = 40.0;
        float lonRes = 90.0;
        float tLatIdx = floor(lat * latRes / PI + 0.5);
        float tLonIdx = floor(lon * lonRes / (2.0 * PI) + 0.5);
        float tLat = (tLatIdx + 0.5) * PI / latRes;
        float tLon = (tLonIdx + 0.5) * (2.0 * PI / lonRes);
        vec3 nSnap = vec3(cos(tLat) * cos(tLon),
                          sin(tLat),
                          cos(tLat) * sin(tLon));
        float tileHash = dh(vec3(tLatIdx, tLonIdx, 0.0));

        // Atmosphere — single tint that colours both the ball's env
        // reflection and the beams emanating from it. The ball reflects
        // the same blue wash its beams are casting into the room, so
        // the whole scene reads as one cohesive club environment.
        vec3 atmosphere = vec3(0.25, 0.45, 0.95);
        vec3 refl   = reflect(rd, nSnap);
        vec3 upCol  = atmosphere * 0.60;   // overhead stage wash
        vec3 downCol = atmosphere * 0.07;  // dark dance floor
        vec3 envCol = mix(downCol, upCol,
                          smoothstep(-0.35, 0.35, refl.y));

        col = envCol * (0.55 + 0.50 * tileHash);

        // Multiple narrow stage-light spots rotating in/around the club.
        // Narrow exponents (160) so only a few specific tiles catch each
        // light — matches the pinpoint coloured reflections in the photo.
        vec3 L1 = normalize(vec3(sin(u_time * 0.40),         0.20, cos(u_time * 0.40)));
        vec3 L2 = normalize(vec3(sin(u_time * 0.55 + 2.10), -0.10, cos(u_time * 0.55 + 2.10)));
        vec3 L3 = normalize(vec3(sin(u_time * 0.30 + 4.20),  0.45, cos(u_time * 0.30 + 4.20)));
        float s1 = pow(max(0.0, dot(nSnap, L1)), 160.0);
        float s2 = pow(max(0.0, dot(nSnap, L2)), 160.0);
        float s3 = pow(max(0.0, dot(nSnap, L3)), 160.0);
        col += vec3(1.0, 0.95, 0.90) * s1 * 4.5;   // white key light
        col += vec3(1.0, 0.25, 0.35) * s2 * 3.5;   // red spot
        col += vec3(0.30, 0.80, 1.00) * s3 * 3.5;  // cyan spot

        // Tile gap — dark grout between tiles. Compute distance from
        // the sample direction to the centre of its cell and darken
        // when near the edge.
        float latFrac = abs(fract(lat * latRes / PI + 0.5) - 0.5) * 2.0;
        float lonFrac = abs(fract(lon * lonRes / (2.0 * PI) + 0.5) - 0.5) * 2.0;
        float edge = min(latFrac, lonFrac);
        float tileMask = smoothstep(0.02, 0.18, edge);
        col *= mix(0.25, 1.0, tileMask);

        // Beat-driven facet flash — coloured on beats (party!) but
        // otherwise the ball stays silver. Different random tiles
        // catch each beat for evolving sparkle.
        float flashRoll = fract(tileHash + floor(u_time * 4.0) * 0.137);
        float flashProb = 0.95 - u_beatPulse * 0.45;
        float flash = step(flashProb, flashRoll);
        vec3  partyCol = dhsl2rgb(fract(u_time * 0.25 + tileHash * 0.7), 0.85, 0.60);
        col += partyCol * flash * u_beatPulse * 2.5;

        // Treble shimmer — fine sparkle across random tiles.
        float shimmer = step(0.98, fract(tileHash * 19.7 + u_time * 3.0));
        col += vec3(shimmer) * u_treble * 0.45;

        // Rim glow — soft halo at the silhouette.
        float rim = pow(1.0 - max(0.0, dot(n, normalize(ro - worldHit))), 2.5);
        col += vec3(0.6, 0.8, 1.0) * rim * 0.25;

        // Bass pumps overall brightness subtly.
        col *= 1.0 + u_bass * 0.20;
      }

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `;

  let scene = null;
  let mat   = null;
  let lastT = 0;

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    const gl = window.vizGL;
    if (!gl) { console.warn('[disco-ball] window.vizGL not ready'); return; }

    scene = new THREE.Scene();
    mat = new THREE.ShaderMaterial({
      uniforms: {
        u_time:       { value: 0 },
        u_rotY:       { value: 0 },
        u_bass:       { value: 0 },
        u_treble:     { value: 0 },
        u_beatPulse:  { value: 0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      },
      vertexShader:   VS,
      fragmentShader: FS,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;

    const dt = lastT === 0 ? (1 / 60) : Math.min(0.1, Math.max(0.001, t - lastT));
    lastT = t;

    const f = frame || {};

    // Shared rotation with Lunar — both viz advance the same global so
    // flipping between them keeps the sphere spinning continuously, no
    // jump on switch. Same formula Lunar uses.
    window.vizSharedRotY = (window.vizSharedRotY || 0)
      + dt * (0.08 + (f.bass || 0) * 0.30);

    const u = mat.uniforms;
    u.u_time.value       = t;
    u.u_rotY.value       = window.vizSharedRotY;
    u.u_bass.value       = f.bass      || 0;
    u.u_treble.value     = f.treble    || 0;
    u.u_beatPulse.value  = f.beatPulse || 0;
    u.u_resolution.value.set(window.innerWidth, window.innerHeight);

    window.vizGL.renderer.render(scene, window.vizGL.camera);
  }

  window.Viz.register({
    id:       'disco-ball',
    label:    'Disco',
    kind:     'webgl',
    initFn:   init,
    renderFn: render,
  });
})();
