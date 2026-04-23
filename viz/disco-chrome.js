// Disco Chrome — registry wrapper around the standalone prototype.
// Identical camera, geometry, lights, material, env map, tone mapping,
// and bloom settings as prototypes/disco-chrome.html. Only additions:
//
//   - registers with window.Viz so it shows up as a mode button
//   - shares window.vizSharedRotY with Lunar + Disco so switching
//     between sphere viz keeps the rotation continuous
//   - applies subtle music reactivity to bloom strength on beats
//
// The visual parameters (radius 15 sphere, camera z=45, light intensity
// 400, bloom strength 2.0) are in their native prototype units — the
// PerspectiveCamera handles visual sizing independently from the
// R=0.65 convention used by the ortho-quad viz.

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;
  if (!THREE.EffectComposer || !THREE.UnrealBloomPass) {
    console.warn('[disco-chrome] EffectComposer/UnrealBloomPass not loaded');
    return;
  }

  // Deterministic PRNG for seeded canvas-face generation.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Exact copy of the prototype's env-face generator.
  function makeEnvFace(seed) {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, size);
    bg.addColorStop(0.0, '#04060f');
    bg.addColorStop(1.0, '#000000');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    const rng = mulberry32(seed * 9301 + 49297);
    for (let i = 0; i < 14; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 14 + rng() * 32;
      const hue = Math.floor(rng() * 360);
      const alpha = 0.85 + rng() * 0.15;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      grd.addColorStop(0.0, `hsla(${hue}, 100%, 85%, ${alpha})`);
      grd.addColorStop(0.3, `hsla(${hue}, 100%, 60%, ${alpha * 0.5})`);
      grd.addColorStop(1.0, `hsla(${hue}, 100%, 50%, 0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);

      const core = ctx.createRadialGradient(x, y, 0, x, y, r * 0.6);
      core.addColorStop(0.0, `hsla(${hue}, 60%, 98%, 1.0)`);
      core.addColorStop(1.0, `hsla(${hue}, 100%, 70%, 0)`);
      ctx.fillStyle = core;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }
    return cv;
  }

  let scene     = null;
  let camera    = null;
  let ball      = null;
  let coolLight = null;
  let warmLight = null;
  let composer  = null;
  let bloomPass = null;
  let lastT     = 0;
  let startT    = null;

  // Save renderer state so other viz see their expected pipeline.
  let prevToneMapping    = null;
  let prevOutputEncoding = null;
  let prevToneMappingExp = null;
  let prevPhysLights     = null;
  let prevPixelRatio     = null;

  function init() {
    if (!window.vizGL && typeof window.initThree === 'function') window.initThree();
    if (!window.vizGL) { console.warn('[disco-chrome] renderer not ready'); return; }
    const renderer = window.vizGL.renderer;

    // Preserve current state, then apply the prototype's pipeline.
    // CRITICAL: physicallyCorrectLights is OFF by default in r128 but ON
    // by default in r155+ which the prototype uses. Without this flag,
    // PointLight(intensity=400) at r128 produces completely different
    // brightness than at r160 → the whole viz looks wrong. Same for
    // pixel ratio — prototype caps at 2x, shared renderer was at 1.5x.
    prevToneMapping     = renderer.toneMapping;
    prevOutputEncoding  = renderer.outputEncoding;
    prevToneMappingExp  = renderer.toneMappingExposure;
    prevPhysLights      = renderer.physicallyCorrectLights;
    prevPixelRatio      = renderer.getPixelRatio();
    renderer.toneMapping          = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure  = 1.0;
    renderer.outputEncoding       = THREE.sRGBEncoding;
    renderer.physicallyCorrectLights = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera — identical values to the prototype.
    camera = new THREE.PerspectiveCamera(
      45, window.innerWidth / window.innerHeight, 0.1, 500
    );
    camera.position.set(0, 8, 45);
    camera.lookAt(0, 0, 0);

    // Procedural cube env — 6 seeded faces, same as prototype. Mark the
    // texture as sRGB so colour values in the canvas match what the
    // material picks up after tone mapping.
    const envFaces = [1, 2, 3, 4, 5, 6].map(makeEnvFace);
    const envTex = new THREE.CubeTexture(envFaces);
    envTex.encoding = THREE.sRGBEncoding;
    envTex.needsUpdate = true;
    scene.environment = envTex;

    // Geometry + material — prototype exactly. IcosahedronGeometry(15, 3)
    // has 1280 flat triangles = faceted disco ball. MeshStandardMaterial
    // with metalness=1 and flatShading=true is the recipe.
    const geo = new THREE.IcosahedronGeometry(15, 3);
    const mat = new THREE.MeshStandardMaterial({
      color:           0xffffff,
      metalness:       1.0,
      roughness:       0.1,
      flatShading:     true,
      envMapIntensity: 1.2,
    });
    ball = new THREE.Mesh(geo, mat);
    scene.add(ball);

    // Two bright PointLights — prototype values exactly (intensity 400,
    // distance 120, decay 2). These push pixels past the bloom threshold.
    coolLight = new THREE.PointLight(0x44aaff, 400, 120, 2);
    warmLight = new THREE.PointLight(0xffaa44, 400, 120, 2);
    scene.add(coolLight);
    scene.add(warmLight);
    scene.add(new THREE.AmbientLight(0x112244, 0.3));

    // EffectComposer + UnrealBloomPass — prototype values (2.0, 0.5, 0.7).
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      2.0, 0.5, 0.7
    );
    bloomPass.renderToScreen = true;
    composer.addPass(bloomPass);
  }

  function teardown() {
    if (!window.vizGL) return;
    const renderer = window.vizGL.renderer;
    if (prevToneMapping     !== null) renderer.toneMapping        = prevToneMapping;
    if (prevOutputEncoding  !== null) renderer.outputEncoding     = prevOutputEncoding;
    if (prevToneMappingExp  !== null) renderer.toneMappingExposure = prevToneMappingExp;
    if (prevPhysLights      !== null) renderer.physicallyCorrectLights = prevPhysLights;
    if (prevPixelRatio      !== null) renderer.setPixelRatio(prevPixelRatio);
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;
    if (startT === null) startT = t;

    const dt = lastT === 0 ? (1 / 60) : Math.min(0.1, Math.max(0.001, t - lastT));
    lastT = t;
    const elapsed = t - startT;

    const f    = frame || {};
    const bass = f.bass      || 0;
    const beat = f.beatPulse || 0;

    // ── Music reactivity (additive on top of the verbatim prototype) ──
    //
    //   1. Shared rotation with Lunar + Disco via window.vizSharedRotY —
    //      bass-nudged so beats kick the spin forward and switching
    //      between sphere viz stays continuous.
    //   2. Lights pump subtly with bass + beat. Prototype's constant
    //      intensity 400 is preserved as the BASELINE; music scales it
    //      1.0× → ~1.6× at peak so bloom flares without blowing out.
    //   3. Bloom strength punches briefly on each beat.
    //
    // Everything else (camera, material, env, tone mapping) stays
    // identical to the prototype.

    window.vizSharedRotY = (window.vizSharedRotY || 0)
      + dt * (0.25 + bass * 0.35);
    ball.rotation.y = window.vizSharedRotY;
    ball.rotation.x = elapsed * 0.05;

    const r      = 28;
    const lBoost = 1.0 + bass * 0.45 + beat * 0.25;
    coolLight.intensity = 400 * lBoost;
    warmLight.intensity = 400 * lBoost;
    coolLight.position.set(
      Math.cos(elapsed * 0.6) * r,
      6 + Math.sin(elapsed * 0.4) * 4,
      Math.sin(elapsed * 0.6) * r
    );
    warmLight.position.set(
      Math.cos(elapsed * 0.8 + Math.PI) * r,
      -2 + Math.sin(elapsed * 0.5) * 3,
      Math.sin(elapsed * 0.8 + Math.PI) * r
    );

    bloomPass.strength = 2.0 + beat * 0.6;

    // Aspect + composer size sync.
    const w = window.innerWidth, h = window.innerHeight;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    composer.setSize(w, h);

    composer.render(dt);
  }

  window.Viz.register({
    id:         'disco-chrome',
    label:      'Chrome',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
  });
})();
