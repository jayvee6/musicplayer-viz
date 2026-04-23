// StaticPerspectiveSeismicMesh — a 100×100 green-wireframe plane tilted back
// 60° with a static camera. Bass energy drives a radial sine wave that
// radiates outward from center, each peak clamped to Z ≥ 0 so the mesh
// reads like ripples on a floor. Decoupled per spec: pure geometry +
// energy in, no audio routing or FFT work inside.
//
// Renderer notes: this viz uses its OWN WebGLRenderer with alpha:true
// (transparent background per spec). The shared window.vizGL.renderer —
// used by Blob/Kaleidoscope/Rorschach — is hidden while seismic is active
// so its stale frame doesn't show through the transparency; seismic's
// teardownFn restores the shared canvas when the user switches away.
//
// Depends on:
//   window.Viz         (packet B1) — registry
//   window.AudioEngine             — frame.bass for the 'energy' input
//   THREE global                   — from CDN

(() => {
  if (typeof THREE === 'undefined' || !window.Viz) return;

  class StaticPerspectiveSeismicMesh {
    constructor(parent) {
      this.parent = parent;

      // Scene + camera — camera is static, looking at the origin from above.
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      this.camera.position.set(0, 20, 50);
      this.camera.lookAt(0, 0, 0);

      // Transparent-bg renderer (alpha:true) so nothing draws behind the
      // wireframe — viewport background shows through.
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      this.renderer.setSize(parent.clientWidth, parent.clientHeight);
      this.canvas = this.renderer.domElement;
      // Absolute fill inside webgl-container. z-index sits above the
      // shared canvas so it wins when both are attached (we also hide
      // the shared canvas, but belt + suspenders).
      Object.assign(this.canvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%', pointerEvents: 'none',
      });
      parent.appendChild(this.canvas);

      // The mesh — 128×128 subdivisions gives enough detail for smooth
      // wave propagation without pushing vertex count past what a typical
      // laptop iGPU handles comfortably.
      this.geometry = new THREE.PlaneGeometry(100, 100, 128, 128);
      const material = new THREE.MeshBasicMaterial({
        color: 0x00ff00, wireframe: true,
      });
      this.mesh = new THREE.Mesh(this.geometry, material);
      // -1.04 rad ≈ -59.6° ≈ the requested 60° backward tilt. Negative X
      // rotation pitches the far edge up, leaving the near edge down
      // toward the camera.
      this.mesh.rotation.x = -1.04;
      this.scene.add(this.mesh);

      // Snapshot the flat positions so distance-from-centre stays stable
      // across update() calls (we only mutate Z).
      const posArr = this.geometry.attributes.position.array;
      this.originalPositions = new Float32Array(posArr.length);
      this.originalPositions.set(posArr);

      // Window resize — scale renderer + camera aspect to the current
      // container size. Bound once so removeEventListener works on dispose.
      this._onResize = () => {
        const w = parent.clientWidth, h = parent.clientHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      };
      window.addEventListener('resize', this._onResize);
    }

    // energy: normalized 0..1 (bass bin amplitude). Higher energy → taller
    // peaks. Sine-wave phase walks with Date.now so the ripple radiates
    // outward continuously, and the decay (1 + distance * 0.1) keeps the
    // centre hotter than the edges — like a seismic shockwave.
    update(energy) {
      const orig = this.originalPositions;
      const pos  = this.geometry.attributes.position.array;
      const time = Date.now() * 0.005;
      const amp  = energy * 15;
      for (let i = 0; i < orig.length; i += 3) {
        const x = orig[i], y = orig[i + 1];
        const distance = Math.sqrt(x * x + y * y);
        const waveAmplitude =
          (Math.sin((distance * 0.5) - time) * amp) / (1 + distance * 0.1);
        pos[i]     = x;
        pos[i + 1] = y;
        pos[i + 2] = Math.max(waveAmplitude, 0);
      }
      this.geometry.attributes.position.needsUpdate = true;
      this.renderer.render(this.scene, this.camera);
    }

    show()    { this.canvas.style.display = 'block'; }
    hide()    { this.canvas.style.display = 'none';  }
    dispose() {
      window.removeEventListener('resize', this._onResize);
      this.canvas.remove();
      this.geometry.dispose();
      this.mesh.material.dispose();
      this.renderer.dispose();
    }
  }

  let mesh = null;

  function sharedCanvas() {
    return window.vizGL && window.vizGL.renderer && window.vizGL.renderer.domElement;
  }

  function init() {
    const container = document.getElementById('webgl-container');
    if (!container) return;
    if (!mesh) mesh = new StaticPerspectiveSeismicMesh(container);
    mesh.show();
    const s = sharedCanvas(); if (s) s.style.display = 'none';
  }

  function teardown() {
    if (mesh) mesh.hide();
    const s = sharedCanvas(); if (s) s.style.display = 'block';
  }

  function render(_t, frame) {
    if (!mesh) init();
    if (!mesh) return;
    // Normalize bass to [0,1] — AudioEngine already AGC-clamps, but guard
    // with a max just in case a transient spikes above 1.
    const energy = Math.min(1, Math.max(0, (frame && frame.bass) || 0));
    mesh.update(energy);
  }

  window.Viz.register({
    id:         'seismic',
    label:      'Seismic',
    kind:       'webgl',
    initFn:     init,
    renderFn:   render,
    teardownFn: teardown,
  });
})();
