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
  const entryById = new Map(); // id → entry (O(1) lookup for controlValue)
  const inited  = new Set();   // ids that have had initFn run
  let activeId  = null;        // currently displayed viz id (null until setMode)

  function register(def) {
    if (!def || typeof def !== 'object')      throw new Error('Viz.register: def required');
    if (!def.id || typeof def.id !== 'string') throw new Error('Viz.register: id required');
    if (typeof def.renderFn !== 'function')   throw new Error('Viz.register: renderFn required');
    if (def.kind !== '2d' && def.kind !== 'webgl') throw new Error('Viz.register: kind must be "2d" or "webgl"');
    if (entries.some(e => e.id === def.id))   throw new Error(`Viz.register: duplicate id ${def.id}`);
    const entry = {
      id:         def.id,
      label:      def.label || def.id,
      kind:       def.kind,
      initFn:     def.initFn     || null,
      renderFn:   def.renderFn,
      teardownFn: def.teardownFn || null,
      controls:   Array.isArray(def.controls) ? def.controls : [],
      layout:     def.layout || null,   // 'vertical' for stacked controls
    };
    entries.push(entry);
    entryById.set(entry.id, entry);
    appendButton(entries.length - 1);
    appendControls(entry);
  }

  // Builds a <div class="viz-controls"> for any viz that declares `controls`.
  // Five control types are supported (type defaults to 'slider' for back-compat):
  //   - 'slider': <input type="range">     — min, max, step, default (numeric)
  //   - 'number': <input type="number">    — typed-in value with min, max, step
  //   - 'text':   <input type="text">      — default (string), optional width
  //   - 'button': <button>                  — onClick callback
  //   - 'toggle': <input type="checkbox">  — default (bool), returns boolean
  // An optional `layout: 'vertical'` on the viz def stacks children vertically
  // instead of the default horizontal inline flow.
  function appendControls(entry) {
    if (!entry.controls.length) return;
    const row = document.getElementById('sliders-row');
    if (!row) return; // DOM not ready — syncButtons won't rebuild these; ensure load order
    let div = document.getElementById(`viz-ctl-${entry.id}`);
    if (!div) {
      div = document.createElement('div');
      div.id = `viz-ctl-${entry.id}`;
      div.className = 'viz-controls' + (entry.layout === 'vertical' ? ' viz-controls-vertical' : '');
      div.style.display = 'none';
      row.appendChild(div);
    }
    div.innerHTML = '';
    entry.controls.forEach(c => {
      const type = c.type || 'slider';
      // Cache the resolved type on the control so controlValue() doesn't
      // recompute it every frame. _input is populated below where the
      // element is created.
      c._type  = type;
      c._input = null;
      if (type === 'button') {
        const btn = document.createElement('button');
        btn.className   = 'speed-label viz-ctl-button';
        btn.id          = `viz-ctl-${entry.id}-${c.id}`;
        btn.textContent = c.label;
        if (typeof c.onClick === 'function') btn.addEventListener('click', c.onClick);
        div.appendChild(btn);
        return;
      }
      const label = document.createElement('label');
      label.className = 'speed-label';
      label.textContent = c.label;
      const input = document.createElement('input');
      input.id = `viz-ctl-${entry.id}-${c.id}`;
      c._input = input; // cache reference so render loop doesn't getElementById each frame
      if (type === 'text') {
        input.type = 'text';
        input.value = String(c.default ?? '');
        if (c.width) input.style.width = c.width;
        if (c.placeholder) input.placeholder = c.placeholder;
      } else if (type === 'number') {
        input.type = 'number';
        input.min  = String(c.min);
        input.max  = String(c.max);
        input.step = String(c.step ?? 0.01);
        input.value = String(c.default ?? c.min);
        if (c.width) input.style.width = c.width;
      } else if (type === 'toggle') {
        input.type = 'checkbox';
        input.checked = !!c.default;
      } else {
        input.type = 'range';
        input.min  = String(c.min);
        input.max  = String(c.max);
        input.step = String(c.step ?? 1);
        input.value = String(c.default ?? c.min);
      }
      label.appendChild(input);
      // Optional live value readout — useful for dialing in numeric
      // settings. Renders as a small monospaced span next to the input
      // and updates on every drag.
      if (c.showValue && (type === 'slider' || type === 'text')) {
        const readout = document.createElement('span');
        readout.className = 'viz-ctl-readout';
        readout.textContent = input.value;
        input.addEventListener('input', () => { readout.textContent = input.value; });
        label.appendChild(readout);
      }
      div.appendChild(label);
    });
  }

  // Returns the current value of a registered control.
  //   sliders → float
  //   text    → string
  //   toggle  → boolean
  //   buttons → null (buttons use onClick)
  // Falls back to the declared default if the input isn't in the DOM yet.
  //
  // Perf: hot-path fast-track when the control has its `_input` cached by
  // appendControls. Render loops call this 1-3× per frame per viz, so the
  // previous getElementById + entries.find() + controls.find() combo was
  // ~30-100µs/frame of DOM + linear scan. Cached path is ~2 field reads.
  function controlValue(vizId, controlId) {
    const entry = entryById.get(vizId);
    if (!entry) return 0;
    // Scan at most entry.controls.length items (typically 1-3) — keeping
    // a nested map per viz isn't worth the complexity at n=3.
    let ctl = null;
    for (let i = 0; i < entry.controls.length; i++) {
      if (entry.controls[i].id === controlId) { ctl = entry.controls[i]; break; }
    }
    if (!ctl) return 0;
    const type  = ctl._type || ctl.type || 'slider';
    if (type === 'button') return null;
    // _input is cached at creation. Fall back to getElementById only for
    // the first frame between register() and the DOM flush, then assign.
    let input = ctl._input;
    if (!input) {
      input = document.getElementById(`viz-ctl-${vizId}-${controlId}`);
      if (input) ctl._input = input;
    }
    if (type === 'toggle') {
      return input ? input.checked : !!ctl.default;
    }
    if (type === 'text') {
      return input ? input.value : (ctl.default ?? '');
    }
    // slider + number: parse numeric value, fall back to declared default.
    if (input) {
      const v = parseFloat(input.value);
      return isNaN(v) ? (ctl.default ?? 0) : v;
    }
    return ctl.default ?? ctl.min ?? 0;
  }

  function appendButton(index) {
    const row = document.getElementById('mode-buttons');
    if (!row) return; // DOM not ready — app.js bootstrap will sync on load
    const e   = entries[index];
    // Dots replace the old long-label buttons. The viz name lives in the
    // tooltip (title attr for hover) and is revealed big via the
    // #viz-title-overlay fade on every mode switch.
    const btn = document.createElement('button');
    btn.className       = 'mode-btn' + (index === 0 ? ' active' : '');
    btn.dataset.mode    = String(index);
    btn.title           = e.label;
    btn.setAttribute('aria-label', e.label);
    btn.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
    btn.addEventListener('click', () => {
      const fn = typeof window.setMode === 'function' ? window.setMode : setMode;
      fn(index);
    });
    row.appendChild(btn);
  }

  // Title overlay fade — called on every successful mode transition.
  // Repeated switches restart the fade cleanly without piling up timers.
  let titleFadeTimer = null;
  function flashTitle(label) {
    const el = document.getElementById('viz-title-overlay');
    if (!el || !label) return;
    el.textContent = label;
    el.classList.add('visible');
    if (titleFadeTimer) clearTimeout(titleFadeTimer);
    titleFadeTimer = setTimeout(() => {
      el.classList.remove('visible');
      titleFadeTimer = null;
    }, 1100);
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

    // Active-button styling + aria-pressed sync + mode-index cache.
    const row = document.getElementById('mode-buttons');
    if (row) {
      Array.from(row.children).forEach((b, i) => {
        const isActive = i === index;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    // Per-viz control group visibility — only the active viz's div is shown.
    entries.forEach(e => {
      const ctrl = document.getElementById(`viz-ctl-${e.id}`);
      if (ctrl) ctrl.style.display = (e.id === next.id && e.controls.length) ? 'flex' : 'none';
    });

    const isNewActive = activeId !== next.id;
    activeId = next.id;
    window.Viz._currentIndex = index; // read by legacy code that did mode === N checks

    // Reveal the viz name briefly on every switch — gives a visual confirmation
    // beyond the tiny dot toggle. Skip if we re-selected the already-active
    // mode so idle mouse flutters don't trigger a flash.
    if (isNewActive) flashTitle(next.label || next.id);
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
