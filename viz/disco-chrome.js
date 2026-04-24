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

  let scene     = null;
  let camera    = null;
  let ball      = null;
  let coolLight = null;
  let warmLight = null;
  let sky       = null;    // nebula skybox mesh (inside-out sphere at r=250)
  let skyMat    = null;    // ShaderMaterial for sky — u_time feeds fbm phase
  let stars     = null;    // 3500-star BufferGeometry Points field (Phase 2)
  let cubeRT    = null;    // WebGLCubeRenderTarget for live reflections (Phase 3)
  let cubeCam   = null;    // CubeCamera that renders the scene into cubeRT
  let frameCounter = 0;    // throttles cubeCam.update() via the Refresh control
  let composer  = null;
  let bloomPass = null;
  let lastT     = 0;
  let startT    = null;

  // Token from window.vizGL.pushRendererState — snapshot of the renderer
  // keys we mutated so teardown can restore them.
  let rendererToken = null;

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
    rendererToken = window.vizGL.pushRendererState({
      toneMapping:             THREE.ACESFilmicToneMapping,
      toneMappingExposure:     1.0,
      outputEncoding:          THREE.sRGBEncoding,
      physicallyCorrectLights: true,
      pixelRatio:              Math.min(window.devicePixelRatio, 2),
    });

    scene = new THREE.Scene();
    // scene.background stays black as a fallback for any tiny gaps; the
    // nebula sphere below covers the entire visible frustum regardless.
    scene.background = new THREE.Color(0x000000);

    // Camera — identical values to the prototype.
    camera = new THREE.PerspectiveCamera(
      45, window.innerWidth / window.innerHeight, 0.1, 500
    );
    camera.position.set(0, 8, 45);
    camera.lookAt(0, 0, 0);

    // Nebula skybox — verbatim port from
    //   /StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/chrome-orb.html:45–120
    //
    // An inside-out sphere (BackSide + depthWrite:false) at r=250 gives
    // every reflection direction SOMETHING warm to pick up — dim indigo
    // floors, magenta ceilings, animated fbm nebula clouds, horizon hot
    // pocket. toneMapped:false bypasses ACES so the shader's linear
    // colour values are the final pixel values.
    //
    // Phase 1 of chrome-orb realign (Packet F). Phases 2+ add 3500-star
    // Points field, CubeCamera live reflection, 4 orbiting coloured
    // lights. Each ships as its own branch + PR.
    skyMat = new THREE.ShaderMaterial({
      uniforms: { u_time: { value: 0 } },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform float u_time;
        varying vec3 vDir;

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float noise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f*f*(3.0 - 2.0*f);
          return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                         mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                         mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float fbm(vec3 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) {
            v += a * noise3(p);
            p = p * 2.0 + vec3(3.1, 1.7, 2.3);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);

          // Base vertical gradient — indigo/purple bottom → warm magenta top.
          float y01 = d.y * 0.5 + 0.5;
          vec3 bottom = vec3(0.015, 0.010, 0.040);
          vec3 mid    = vec3(0.050, 0.025, 0.090);
          vec3 top    = vec3(0.090, 0.030, 0.120);
          vec3 col = mix(bottom, mid, smoothstep(0.0, 0.55, y01));
          col      = mix(col, top, smoothstep(0.50, 1.0, y01));

          // Procedural nebula clouds — fbm twice, two tinted layers.
          float n1 = fbm(d * 1.8 + vec3(u_time * 0.005, 0.0, 0.0));
          float n2 = fbm(d * 3.4 + vec3(0.0, u_time * 0.004, 0.0));
          vec3 nebulaA = vec3(0.55, 0.18, 0.95) * pow(n1, 2.0) * 0.85;   // magenta
          vec3 nebulaB = vec3(0.18, 0.48, 0.95) * pow(n2, 2.0) * 0.55;   // blue
          col += nebulaA + nebulaB;

          // Hot orange/pink pocket near the horizon for interest.
          float pocket = smoothstep(0.35, 0.55, n1) * smoothstep(0.3, 0.7, y01) * 0.3;
          col += vec3(1.0, 0.5, 0.3) * pocket;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side:       THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    sky = new THREE.Mesh(new THREE.SphereGeometry(250, 48, 32), skyMat);
    scene.add(sky);

    // Starfield — verbatim port from
    //   /StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/chrome-orb.html:122-147
    //
    // 3500 points distributed uniformly on a spherical shell (r=100..160)
    // between the orb (r=15) and the nebula (r=250). Star temperature
    // (cool vs warm) is randomised; RGB tints per vertex. sizeAttenuation
    // + toneMapped:false keeps them bright and parallaxing in depth.
    //
    // Phase 2 of chrome-orb realign (Packet F).
    const STAR_COUNT = 3500;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(STAR_COUNT * 3);
    const starCol = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const phi = Math.random() * Math.PI * 2;
      const ct  = Math.random() * 2 - 1;
      const st  = Math.sqrt(1 - ct * ct);
      const r   = 100 + Math.random() * 60;
      starPos[i * 3 + 0] = r * st * Math.cos(phi);
      starPos[i * 3 + 1] = r * ct;
      starPos[i * 3 + 2] = r * st * Math.sin(phi);
      const temp = Math.random();
      const brightness = 0.6 + Math.random() * 0.7;
      starCol[i * 3 + 0] = (0.85 + temp * 0.35) * brightness;
      starCol[i * 3 + 1] = (0.90 + Math.random() * 0.15) * brightness;
      starCol[i * 3 + 2] = (0.95 + (1 - temp) * 0.25) * brightness;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color',    new THREE.BufferAttribute(starCol, 3));
    stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      size:            0.5,
      vertexColors:    true,
      sizeAttenuation: true,
      toneMapped:      false,
      transparent:     true,
      opacity:         1.0,
    }));
    scene.add(stars);

    // CubeCamera for live reflections — verbatim port from
    //   /StudioJoeMusic/.claude/skills/studiojoe-viz/showcase/chrome-orb.html:174-184
    //
    // 512² cube render target with mipmaps + sRGB so the nebula and
    // starfield register crisply in tile reflections. The orb reads as a
    // true mirror in space — not a shiny ball with a baked texture.
    //
    // Replaces the Phase 1/2-era baked canvas env map. Refresh rate is
    // user-tunable via the Refresh control (1..4 frames); default 1 =
    // every frame. Bump to 2-4 on mobile if GPU becomes the bottleneck.
    //
    // Phase 3 of chrome-orb realign (Packet F).
    cubeRT = new THREE.WebGLCubeRenderTarget(512, {
      format:          THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter:       THREE.LinearMipmapLinearFilter,
      encoding:        THREE.sRGBEncoding,
    });
    cubeCam = new THREE.CubeCamera(0.1, 300, cubeRT);
    cubeCam.position.set(0, 0, 0);   // orb sits at origin
    scene.add(cubeCam);

    // Geometry + material — orb is 1280-tri faceted MeshStandardMaterial.
    // envMap is the live cubeRT texture (Phase 3); intensity 1.15 matches
    // showcase tuning (was 1.2 with the baked env).
    const geo = new THREE.IcosahedronGeometry(15, 3);
    const mat = new THREE.MeshStandardMaterial({
      color:           0xffffff,
      metalness:       1.0,
      roughness:       0.1,
      flatShading:     true,
      envMap:          cubeRT.texture,
      envMapIntensity: 1.15,
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

    // Initial cube refresh — populates cubeRT before the first composer
    // render so the orb doesn't flash black on frame 1. Ball is hidden
    // during capture so it doesn't self-reflect.
    ball.visible = false;
    cubeCam.update(renderer, scene);
    ball.visible = true;
    frameCounter = 0;
  }

  function teardown() {
    if (!window.vizGL) return;
    window.vizGL.popRendererState(rendererToken);
    rendererToken = null;
    // Release GPU resources (playbook: TeardownFn should dispose scene
    // materials/geometries/textures on mode-out, not just hide the canvas).
    // This is the heaviest viz: 6×512² env cube + 1280-tri disco ball +
    // bloom MRT chain. Render's `if (!scene) init()` rebuilds cleanly.
    if (ball) {
      if (ball.geometry) ball.geometry.dispose();
      if (ball.material) ball.material.dispose();
    }
    if (sky) {
      if (sky.geometry) sky.geometry.dispose();
      if (sky.material) sky.material.dispose();
    }
    if (stars) {
      if (stars.geometry) stars.geometry.dispose();
      if (stars.material) stars.material.dispose();
    }
    // cubeRT holds the 6-face GPU texture + mipmaps — biggest GPU surface
    // this viz allocates. Must dispose to avoid leaking across mode switches.
    if (cubeRT && typeof cubeRT.dispose === 'function') cubeRT.dispose();
    if (composer && typeof composer.dispose === 'function') composer.dispose();
    ball         = null;
    coolLight    = null;
    warmLight    = null;
    sky          = null;
    skyMat       = null;
    stars        = null;
    cubeRT       = null;
    cubeCam      = null;
    scene        = null;
    composer     = null;
    bloomPass    = null;
    startT       = null;
    lastT        = 0;
    frameCounter = 0;
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

    // Nebula skybox — u_time drives fbm phase so clouds drift slowly.
    // Uses elapsed-since-init rather than wall clock so re-entering the
    // viz doesn't jolt the animation with whatever time passed while it
    // was inactive.
    skyMat.uniforms.u_time.value = elapsed;

    // Starfield parallax — absolute rotation driven by elapsed (Phase 2).
    // Matches showcase exactly: y-axis spins slowly, x-axis gently wobbles.
    stars.rotation.y = elapsed * 0.004;
    stars.rotation.x = Math.sin(elapsed * 0.02) * 0.05;

    // CubeCamera refresh (Phase 3). Hide orb so it doesn't self-reflect,
    // fire the 6-face render, show orb again. User-controlled refresh
    // rate: 1 = every frame (best quality), 2-4 = every Nth frame for
    // mobile perf. Updates AFTER sky + stars advance so the capture
    // reflects the current-frame scene state.
    const refreshRate = Math.max(1, Math.min(4,
      Math.floor(window.Viz.controlValue('disco-chrome', 'refresh'))
    ));
    frameCounter = (frameCounter + 1) >>> 0;
    if (frameCounter % refreshRate === 0) {
      ball.visible = false;
      cubeCam.update(window.vizGL.renderer, scene);
      ball.visible = true;
    }

    // Aspect + composer size sync. Bloom runs at half-res (playbook:
    // postprocess at half-res, ~3-5ms saved on mobile) — must be applied
    // AFTER composer.setSize since that internally resizes every pass.
    const w = window.innerWidth, h = window.innerHeight;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    composer.setSize(w, h);
    bloomPass.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));

    composer.render(dt);
  }

  window.Viz.register({
    id:         'disco-chrome',
    label:      'Chrome',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
    controls: [
      // Refresh rate for the CubeCamera cube-render. 1 = every frame
      // (best quality); bump to 2-4 on mobile if GPU is the bottleneck.
      { id: 'refresh', label: 'Refresh', min: 1, max: 4, step: 1, default: 1 },
    ],
  });
})();
