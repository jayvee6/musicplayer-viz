// AudioEngine — iOS-parity mel-scale spectrum + adaptive AGC + noise gate +
// onset-based beat/BPM detection. Exposed as window.AudioEngine.
//
// Read path: every frame, tick(t) pulls a Float32 dB spectrum from whichever
// AnalyserNode is currently active (primary, capture, or mic), converts to
// linear magnitudes, projects onto 32 mel bins, applies perceptual gain,
// per-bin adaptive noise gate, and exponential-peak AGC. The result feeds
// OnsetBPMDetector for beatPulse + bpm, and gets composited with mood
// metadata from window.TrackMeta into an AudioFrame exposed via
// currentFrame(). Viz renderFns read this frame each tick.
//
// Ported from:
//   Packages/Core/Sources/Core/AudioAnalysis/FFTCore.swift          (mel + AGC + gate)
//   Packages/Core/Sources/Core/AudioAnalysis/OnsetBPMDetector.swift (beat + BPM)
//
// Design choice: we read from the existing AnalyserNode rather than spin up
// an AudioWorklet. The analyser's internal smoothing (0.8) slightly softens
// our adaptive-gate reaction vs. iOS's raw path, but avoids the worklet
// message-passing + module-loading complexity and keeps the legacy viz
// reading the same Uint8Array we always have.

(() => {
  const FFT_SIZE    = 2048;
  const HALF_N      = FFT_SIZE / 2;
  const BIN_COUNT   = 32;
  const SAMPLE_RATE = 44100;

  // ── mel helpers ─────────────────────────────────────────────────────────
  const hzToMel = hz  => 2595 * Math.log10(1 + hz / 700);
  const melToHz = mel => 700 * (Math.pow(10, mel / 2595) - 1);

  function computeMelBoundaries() {
    const melMin = hzToMel(0);
    const melMax = hzToMel(SAMPLE_RATE / 2);
    const bounds = new Int32Array(BIN_COUNT + 1);
    for (let i = 0; i <= BIN_COUNT; i++) {
      const mel = melMin + (melMax - melMin) * i / BIN_COUNT;
      const hz  = melToHz(mel);
      bounds[i] = Math.min(HALF_N, Math.max(0, Math.floor(hz / SAMPLE_RATE * FFT_SIZE)));
    }
    // Guarantee strictly increasing so each bin averages ≥1 FFT bin.
    for (let i = 1; i <= BIN_COUNT; i++) {
      if (bounds[i] <= bounds[i - 1]) bounds[i] = Math.min(HALF_N, bounds[i - 1] + 1);
    }
    return bounds;
  }

  function computeBinGain() {
    // g[b] = 1.0 + (b/(BIN_COUNT-1))^1.3 * 2.5 — boosts treble from 1.0x → ~3.5x.
    const g = new Float32Array(BIN_COUNT);
    for (let b = 0; b < BIN_COUNT; b++) {
      const t = b / (BIN_COUNT - 1);
      g[b] = 1.0 + Math.pow(t, 1.3) * 2.5;
    }
    return g;
  }

  const MEL_BOUNDS = computeMelBoundaries();
  const BIN_GAIN   = computeBinGain();
  const BASS_END   = Math.max(1, Math.floor(BIN_COUNT / 10));               // 3
  const MID_END    = Math.max(BASS_END + 1, Math.floor(BIN_COUNT * 0.45));  // 14

  // ── Onset / BPM detector ────────────────────────────────────────────────
  class OnsetBPMDetector {
    constructor() {
      this.bassHistory = [];
      this.historyLen  = 32;
      this.onsets      = [];
      this.maxOnsets   = 16;
      this.lastBeatT   = 0;
      this.lastBpm     = 0;
      this.minGapSec   = 0.20;
      this.kSigma      = 1.3;
      this.silenceFloor = 0.15;
    }

    // t in seconds. Returns {bpm, beatPulse, isBeatNow}.
    ingest(bass, t) {
      this.bassHistory.push(bass);
      if (this.bassHistory.length > this.historyLen) this.bassHistory.shift();

      if (this.bassHistory.length < this.historyLen / 2) {
        return { bpm: this.lastBpm, beatPulse: this._decay(t), isBeatNow: false };
      }

      // Threshold = µ + kσ over window (exclude the current sample, like iOS).
      const w = this.bassHistory.slice(0, -1);
      let mu = 0;
      for (let i = 0; i < w.length; i++) mu += w[i];
      mu /= w.length;
      let varSum = 0;
      for (let i = 0; i < w.length; i++) { const d = w[i] - mu; varSum += d * d; }
      const sigma = Math.sqrt(varSum / w.length);

      const threshold = mu + this.kSigma * sigma;
      const rising    = bass > threshold;
      const debounced = (t - this.lastBeatT) > this.minGapSec;
      const detected  = rising && debounced && bass > this.silenceFloor;

      if (detected) {
        this.onsets.push(t);
        if (this.onsets.length > this.maxOnsets) this.onsets.shift();
        this.lastBeatT = t;
        this.lastBpm   = this._estimateBpm();
      }

      return { bpm: this.lastBpm, beatPulse: this._decay(t), isBeatNow: detected };
    }

    _decay(t) {
      if (this.lastBeatT <= 0) return 0;
      return Math.exp(-(t - this.lastBeatT) * 8.0);
    }

    _estimateBpm() {
      if (this.onsets.length < 4) return this.lastBpm;
      const intervals = [];
      for (let i = 1; i < this.onsets.length; i++) {
        const d = this.onsets[i] - this.onsets[i - 1];
        if (d > 0.2 && d < 2.0) intervals.push(d);
      }
      if (!intervals.length) return this.lastBpm;
      intervals.sort((a, b) => a - b);
      const median = intervals[intervals.length >> 1];
      const bpm    = 60 / median;
      // Smooth estimate so a single missed beat doesn't flip the tempo.
      return this.lastBpm > 0 ? this.lastBpm * 0.7 + bpm * 0.3 : bpm;
    }

    reset() {
      this.bassHistory.length = 0;
      this.onsets.length      = 0;
      this.lastBeatT = 0;
      this.lastBpm   = 0;
    }
  }

  // ── AudioEngine ─────────────────────────────────────────────────────────
  class AudioEngine {
    constructor() {
      // Per-frame scratch — allocated once.
      this.dbSpectrum  = new Float32Array(HALF_N);  // from analyser
      this.mags        = new Float32Array(BIN_COUNT);
      this.noiseFloor  = new Float32Array(BIN_COUNT).fill(0.01);
      this.peakFloor   = 0.0001;
      this.bassHistory = new Float32Array(16);      // for shader reads
      this.onset       = new OnsetBPMDetector();

      // Published frame. References to mags/bassHistory are stable across
      // frames so renderers can cache them without re-looking-up per frame.
      this.frame = {
        time:         0,
        bass:         0,
        mid:          0,
        treble:       0,
        beatPulse:    0,
        bpm:          0,
        isBeatNow:    false,
        bassHistory:  this.bassHistory,
        magnitudes:   this.mags,
        // Mood defaults neutral; overwritten each tick from window.TrackMeta.
        valence:      0.5,
        energy:       0.5,
        danceability: 0.5,
        tempoBPM:     120,
        width:        window.innerWidth,
        height:       window.innerHeight,
      };
    }

    // Called once per animation frame. `t` is seconds since loop start.
    tick(t) {
      const va = window.vizAudio;
      if (!va) return;
      const node = (typeof va.getActiveAnalyser === 'function')
        ? va.getActiveAnalyser()
        : va.analyser;
      if (!node) return;

      // dB magnitudes from analyser — ~[-140, 0] dB, -Infinity for silent bins.
      node.getFloatFrequencyData(this.dbSpectrum);

      this._project();

      // DRM fallback: when the analyser has no live signal (remote Spotify
      // playback without tab capture / mic) AND Spotify audio-analysis is
      // loaded for the current track, synthesize the 32-bin spectrum from
      // segment loudness + timbre. Synth values land in post-AGC range so
      // gate + agc are skipped — running them would renormalize and kill
      // the dynamics we deliberately encoded.
      const synth = va.getSynthSource && va.getSynthSource();
      const silent = synth && !this._hasSignal();
      if (silent && window.SpotifyAnalysis &&
          window.SpotifyAnalysis.fillMagnitudes(this.mags, synth.trackId, synth.posSec)) {
        this._publish(t);
        return;
      }

      this._gate();
      this._agc();
      this._publish(t);
    }

    // True if the mel-projected magnitudes carry meaningful energy. Threshold
    // deliberately loose — post-AGC idle floor can sit around 0.01 under real
    // FFT; anything below 0.004 means the analyser saw effectively nothing.
    _hasSignal() {
      const m = this.mags;
      for (let b = 0; b < m.length; b++) if (m[b] > 0.004) return true;
      return false;
    }

    // dB → linear magnitude, then mel-bin average, then sqrt (matches iOS).
    _project() {
      const db  = this.dbSpectrum;
      const out = this.mags;
      for (let b = 0; b < BIN_COUNT; b++) {
        const lo = MEL_BOUNDS[b];
        const hi = Math.max(lo + 1, MEL_BOUNDS[b + 1]);
        let sum = 0;
        for (let i = lo; i < hi; i++) {
          // -Infinity (dead-silent bin) → 0 via the Math.pow; guard explicitly
          // because Math.pow(10, -Infinity/20) is 0 but Math.max(NaN) is NaN.
          const v = db[i];
          sum += v === -Infinity || v !== v ? 0 : Math.pow(10, v * 0.05);
        }
        const avg = sum / (hi - lo);
        out[b] = Math.sqrt(avg > 0 ? avg : 0) * BIN_GAIN[b];  // perceptual boost
      }
    }

    // Per-bin adaptive noise gate — fast descent, slow relaxation, 1.8x over-sub.
    _gate() {
      const m  = this.mags;
      const nf = this.noiseFloor;
      for (let b = 0; b < BIN_COUNT; b++) {
        const v = m[b];
        if (v < nf[b]) nf[b] = v * 0.2 + nf[b] * 0.8;
        else           nf[b] *= 1.00005;
        const gated = v - nf[b] * 1.8;
        m[b] = gated > 0 ? gated : 0;
      }
    }

    // Exponential-peak AGC — 3 s half-life at 86 fps; instant rise to new peaks.
    _agc() {
      const m = this.mags;
      let max = 0;
      for (let b = 0; b < BIN_COUNT; b++) { if (m[b] > max) max = m[b]; }
      this.peakFloor = Math.max(max, this.peakFloor * 0.995);
      const inv = 1.0 / Math.max(this.peakFloor, 0.0001);
      for (let b = 0; b < BIN_COUNT; b++) m[b] *= inv;
    }

    _publish(t) {
      const m = this.mags;
      let bSum = 0, midSum = 0, tSum = 0;
      for (let b = 0;         b < BASS_END;   b++) bSum   += m[b];
      for (let b = BASS_END;  b < MID_END;    b++) midSum += m[b];
      for (let b = MID_END;   b < BIN_COUNT;  b++) tSum   += m[b];
      const bass   = bSum   / BASS_END;
      const mid    = midSum / (MID_END - BASS_END);
      const treble = tSum   / (BIN_COUNT - MID_END);

      // Roll 16-sample bass history (unshift + pop, but TypedArray = manual shift).
      const bh = this.bassHistory;
      for (let i = bh.length - 1; i > 0; i--) bh[i] = bh[i - 1];
      bh[0] = bass;

      const onset = this.onset.ingest(bass, t);

      const f = this.frame;
      f.time      = t;
      f.bass      = bass;
      f.mid       = mid;
      f.treble    = treble;
      f.beatPulse = onset.beatPulse;
      f.bpm       = onset.bpm;
      f.isBeatNow = onset.isBeatNow;
      f.width     = window.innerWidth;
      f.height    = window.innerHeight;

      // Mood overlay — optional. window.TrackMeta is populated by packet C1.
      const tm = window.TrackMeta && typeof window.TrackMeta.current === 'function'
        ? window.TrackMeta.current()
        : null;
      if (tm) {
        f.valence      = tm.valence      ?? 0.5;
        f.energy       = tm.energy       ?? 0.5;
        f.danceability = tm.danceability ?? 0.5;
        f.tempoBPM     = tm.tempoBPM     ?? (onset.bpm || 120);
      } else {
        f.tempoBPM = onset.bpm || 120;
      }
    }

    currentFrame() { return this.frame; }

    reset() { this.onset.reset(); this.peakFloor = 0.0001; this.noiseFloor.fill(0.01); }
  }

  window.AudioEngine = new AudioEngine();
})();
