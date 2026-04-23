// CosmicWave — three tilted tori with FFT-modulated tube radius.
// Each torus is driven by a different frequency band (bass / mid / treble).
// The tube inflates and deflates with audio energy, creating a breathing
// cosmic-ring effect. All three share a slow Y-axis drift that beats faster
// when beatPulse fires.
//
// Render strategy: own WebGLRenderer with a perspective camera (same pattern
// as seismic-mesh.js). Hides the shared vizGL canvas while active; restores
// it on teardown so other WebGL viz pick up cleanly.
//
// Tube-radius modulation technique: capture base vertex positions + normals at
// init, then each frame shift each vertex by normal * deltaR. This avoids
// recreating geometry every frame while giving full tube-inflation control.
//
// Depends on:
//   window.Viz         — registry
//   window.AudioEngine — currentFrame() for bass/mid/treble/beatPulse/valence/energy
//   THREE global       — from CDN

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  // Torus geometry parameters — [bass, mid, treble]
  const MAJOR_R    = [10,   7,  8.5];   // ring radius
  const BASE_TUBE  = [1.4, 1.1,  1.2];  // resting tube radius
  const MAX_TUBE   = [3.2, 2.4,  2.8];  // tube radius at band energy = 1
  const HUE_OFFSET = [0, 0.33, 0.67];   // initial hue spread on color wheel

  // Pre-computed rotation tilts — each torus gets a different orientation.
  const TILTS = [
    { x: 0,                    z: 0 },               // A: flat horizontal
    { x: Math.PI * 0.70,       z: Math.PI / 6 },     // B: steep X tilt
    { x: Math.PI / 4,          z: Math.PI * 0.55 },  // C: diagonal
  ];

  class CosmicWaveScene {
    constructor(parent) {
      this.parent = parent;

      this.scene  = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
      this.camera.position.set(0, 8, 28);
      this.camera.lookAt(0, 0, 0);

      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      this.renderer.setSize(parent.clientWidth, parent.clientHeight);
      Object.assign(this.renderer.domElement.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%', pointerEvents: 'none',
      });
      parent.appendChild(this.renderer.domElement);

      // Build all three tori and snapshot their base geometry for modulation.
      this.tori        = [];
      this.basePos     = [];  // Float32Array snapshots of position attribute
      this.baseNormals = [];  // Float32Array snapshots of normal attribute

      for (let t = 0; t < 3; t++) {
        const geo = new THREE.TorusGeometry(
          MAJOR_R[t], BASE_TUBE[t],
          24,          // radial segments — enough for smooth tube cross-section
          72,          // tubular segments — smooth ring circumference
        );
        const mat  = new THREE.MeshBasicMaterial({
          color:     new THREE.Color().setHSL(HUE_OFFSET[t], 0.88, 0.52),
          wireframe: true,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = TILTS[t].x;
        mesh.rotation.z = TILTS[t].z;
        this.scene.add(mesh);

        // Snapshot flat geometry so we can shift tube radius each frame
        // without accumulating drift.
        const pos = geo.attributes.position.array;
        const nor = geo.attributes.normal.array;
        this.basePos.push(new Float32Array(pos));
        this.baseNormals.push(new Float32Array(nor));
        this.tori.push({ mesh, geo, mat });
      }

      this._onResize = () => {
        const w = parent.clientWidth, h = parent.clientHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      };
      window.addEventListener('resize', this._onResize);

      // Per-torus hue accumulators so they drift independently.
      this.hue  = [...HUE_OFFSET];
      this.spinY = 0;
    }

    update(frame, dt) {
      const f      = frame || {};
      const bass   = Math.min(1, f.bass      ?? 0);
      const mid    = Math.min(1, f.mid       ?? 0);
      const treble = Math.min(1, f.treble    ?? 0);
      const beat   = Math.min(1, f.beatPulse ?? 0);
      const energy = f.energy  ?? 0.5;
      const valence= f.valence ?? 0.5;
      const bands  = [bass, mid, treble];

      // Global slow Y drift with a beat-snap kick.
      this.spinY += dt * (0.12 + beat * 0.55);

      for (let t = 0; t < 3; t++) {
        const { mesh, geo, mat } = this.tori[t];
        const bPos = this.basePos[t];
        const bNor = this.baseNormals[t];
        const pos  = geo.attributes.position.array;

        // Tube radius driven by band energy. deltaR is the amount to shift
        // each vertex along its normal from the resting position.
        const r      = BASE_TUBE[t] + bands[t] * (MAX_TUBE[t] - BASE_TUBE[t]);
        const deltaR = r - BASE_TUBE[t];

        for (let i = 0; i < pos.length; i += 3) {
          pos[i]     = bPos[i]     + bNor[i]     * deltaR;
          pos[i + 1] = bPos[i + 1] + bNor[i + 1] * deltaR;
          pos[i + 2] = bPos[i + 2] + bNor[i + 2] * deltaR;
        }
        geo.attributes.position.needsUpdate = true;

        // Hue: slow per-torus drift + energy coloring + valence warm/cool shift.
        this.hue[t] += dt * (0.05 + energy * 0.07);
        const h   = ((this.hue[t] + (valence - 0.5) * 0.18) % 1 + 1) % 1;
        const lum = Math.min(0.85, 0.42 + bands[t] * 0.28 + beat * 0.14);
        mat.color.setHSL(h, 0.88, lum);

        // Each torus spins on Y at a slightly different rate for depth variety.
        const spinDir = t === 1 ? -1 : 1;
        mesh.rotation.y = TILTS[t].z * 0 + this.spinY * spinDir * (0.50 + t * 0.18);
      }

      this.renderer.render(this.scene, this.camera);
    }

    show() { this.renderer.domElement.style.display = 'block'; }
    hide() { this.renderer.domElement.style.display = 'none';  }

    dispose() {
      window.removeEventListener('resize', this._onResize);
      this.renderer.domElement.remove();
      for (const { geo, mat } of this.tori) { geo.dispose(); mat.dispose(); }
      this.renderer.dispose();
    }
  }

  let scene = null;
  let lastT = 0;

  function sharedCanvas() {
    return window.vizGL && window.vizGL.renderer && window.vizGL.renderer.domElement;
  }

  function init() {
    const container = document.getElementById('webgl-container');
    if (!container) return;
    if (!scene) scene = new CosmicWaveScene(container);
    scene.show();
    const s = sharedCanvas(); if (s) s.style.display = 'none';
  }

  function teardown() {
    if (scene) scene.hide();
    const s = sharedCanvas(); if (s) s.style.display = 'block';
    lastT = 0;
  }

  function render(t, frame) {
    if (!scene) init();
    if (!scene) return;
    const dt = lastT === 0 ? 0 : Math.min(0.1, t - lastT);
    lastT = t;
    scene.update(frame, dt);
  }

  window.Viz.register({
    id:         'cosmic-wave',
    label:      'CosmicWave',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
  });
})();
