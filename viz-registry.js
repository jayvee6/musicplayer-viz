// Visualizer registry — lets new visualizers self-register without touching
// app.js's mode switch. Introduced by packet B1 so Wave 2/3 packets can ship
// as standalone files that call window.Viz.register({...}).
//
// Contract:
//   window.Viz.register({
//     id:        string           // unique stable id, e.g. 'kaleidoscope'
//     label:     string           // button text
//     kind:      '2d' | 'webgl'   // toggles canvas-2d vs webgl-container
//     initFn?:   () => void       // lazy — first activation
//     renderFn:  (t, frame) => void
//     teardownFn?: () => void     // optional cleanup on mode switch out
//   })
//
// B1 registers the 8 legacy viz through this API so every caller, old and new,
// goes through the same path. No backwards-compat branches.

(() => {
  const entries = [];          // registration order = mode index
  const inited  = new Set();   // ids that have had initFn run
  let activeId  = null;        // currently displayed viz id (null until setMode)

  function register(def) {
    if (!def || typeof def !== 'object')      throw new Error('Viz.register: def required');
    if (!def.id || typeof def.id !== 'string') throw new Error('Viz.register: id required');
    if (typeof def.renderFn !== 'function')   throw new Error('Viz.register: renderFn required');
    if (def.kind !== '2d' && def.kind !== 'webgl') throw new Error('Viz.register: kind must be "2d" or "webgl"');
    if (entries.some(e => e.id === def.id))   throw new Error(`Viz.register: duplicate id ${def.id}`);
    entries.push({
      id:         def.id,
      label:      def.label || def.id,
      kind:       def.kind,
      initFn:     def.initFn     || null,
      renderFn:   def.renderFn,
      teardownFn: def.teardownFn || null,
      controls:   Array.isArray(def.controls) ? def.controls : [],
    });
    appendButton(entries.length - 1);
    appendControls(entries[entries.length - 1]);
  }

  // Builds a <div class="viz-controls"> of <label class="speed-label"><input
  // type="range">…</label> sliders for any viz that declares `controls`. The
  // div sits in #sliders-row alongside the legacy vortex/waves/fluid control
  // groups and is shown only when the viz is active.
  function appendControls(entry) {
    if (!entry.controls.length) return;
    const row = document.getElementById('sliders-row');
    if (!row) return; // DOM not ready — syncButtons won't rebuild these; ensure load order
    let div = document.getElementById(`viz-ctl-${entry.id}`);
    if (!div) {
      div = document.createElement('div');
      div.id = `viz-ctl-${entry.id}`;
      div.className = 'viz-controls';
      div.style.display = 'none';
      row.appendChild(div);
    }
    div.innerHTML = '';
    entry.controls.forEach(c => {
      const label = document.createElement('label');
      label.className = 'speed-label';
      label.textContent = c.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.id   = `viz-ctl-${entry.id}-${c.id}`;
      input.min  = String(c.min);
      input.max  = String(c.max);
      input.step = String(c.step ?? 1);
      input.value = String(c.default ?? c.min);
      label.appendChild(input);
      div.appendChild(label);
    });
  }

  // Returns the current numeric value of a registered control, or the default
  // if the slider isn't in the DOM yet. viz files call this each frame.
  function controlValue(vizId, controlId) {
    const input = document.getElementById(`viz-ctl-${vizId}-${controlId}`);
    if (input) return parseFloat(input.value);
    const entry = entries.find(e => e.id === vizId);
    const ctl   = entry && entry.controls.find(c => c.id === controlId);
    return ctl ? (ctl.default ?? ctl.min) : 0;
  }

  function appendButton(index) {
    const row = document.getElementById('mode-buttons');
    if (!row) return; // DOM not ready — app.js bootstrap will sync on load
    const e   = entries[index];
    const btn = document.createElement('button');
    btn.className       = 'mode-btn' + (index === 0 ? ' active' : '');
    btn.dataset.mode    = String(index);
    btn.textContent     = e.label;
    // Prefer app.js's setMode wrapper (which also toggles legacy control divs)
    // when present; otherwise call the registry directly.
    btn.addEventListener('click', () => {
      const fn = typeof window.setMode === 'function' ? window.setMode : setMode;
      fn(index);
    });
    row.appendChild(btn);
  }

  // Ensure every registered viz has a button — used as a bootstrap reconciliation
  // so ordering is deterministic even if some registrations happened pre-DOM.
  function syncButtons() {
    const row = document.getElementById('mode-buttons');
    if (!row) return;
    // Wipe any static buttons that index.html might still have and re-render.
    row.innerHTML = '';
    entries.forEach((_, i) => appendButton(i));
    if (activeId != null) {
      const idx = entries.findIndex(e => e.id === activeId);
      if (idx >= 0) row.children[idx]?.classList.add('active');
    }
  }

  function setMode(arg) {
    const index = typeof arg === 'number' ? arg : entries.findIndex(e => e.id === arg);
    if (index < 0 || index >= entries.length) return;
    const next = entries[index];
    const prev = entries.find(e => e.id === activeId) || null;

    // Canvas visibility — one of the two surfaces is always hidden.
    const canvas2d = document.getElementById('canvas-2d');
    const webgl    = document.getElementById('webgl-container');
    if (canvas2d) canvas2d.style.display = next.kind === '2d'    ? 'block' : 'none';
    if (webgl)    webgl.style.display    = next.kind === 'webgl' ? 'block' : 'none';

    // Lifecycle: teardown the outgoing viz, init the incoming one on first use.
    if (prev && prev !== next && prev.teardownFn) {
      try { prev.teardownFn(); } catch (e) { console.error(`[Viz] ${prev.id} teardown:`, e); }
    }
    if (next.initFn && !inited.has(next.id)) {
      try { next.initFn(); inited.add(next.id); }
      catch (e) { console.error(`[Viz] ${next.id} init:`, e); }
    }

    // Active-button styling + mode-index cache for legacy checks.
    const row = document.getElementById('mode-buttons');
    if (row) {
      Array.from(row.children).forEach((b, i) => b.classList.toggle('active', i === index));
    }

    // Per-viz control group visibility — only the active viz's div is shown.
    entries.forEach(e => {
      const ctrl = document.getElementById(`viz-ctl-${e.id}`);
      if (ctrl) ctrl.style.display = (e.id === next.id && e.controls.length) ? 'flex' : 'none';
    });

    activeId = next.id;
    window.Viz._currentIndex = index; // read by legacy code that did mode === N checks
  }

  function renderCurrent(t, frame) {
    if (activeId == null) return;
    const e = entries.find(x => x.id === activeId);
    if (!e) return;
    try { e.renderFn(t, frame); }
    catch (err) { console.error(`[Viz] ${e.id} render:`, err); }
  }

  window.Viz = {
    register,
    setMode,
    renderCurrent,
    syncButtons,
    controlValue,
    get entries() { return entries.slice(); },   // defensive copy
    get activeId() { return activeId; },
    get currentIndex() {
      return entries.findIndex(e => e.id === activeId);
    },
    _currentIndex: -1,
  };
})();
