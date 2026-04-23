(() => {
// System-audio capture for reactive visuals during DRM'd playback (Spotify SDK).
//
// Two paths, in order of preference:
//   1. Tab capture via getDisplayMedia({audio:true, video:true, preferCurrentTab:true}).
//      User picks "this tab" in Chrome's picker, shares audio, we get a MediaStream.
//      Dead-ends into an analyser — no echo because we don't route to destination.
//   2. Virtual audio device via getUserMedia({audio:{deviceId}}). If the user has
//      BlackHole / Loopback installed and routed, we pull that device directly.
//
// In both cases we pipe the stream into a dedicated "capture analyser" that
// updateAudioValues() reads from when capture is active.

let captureStream = null;
let captureSrcNode = null;
let captureAnalyser = null;
const statusSubs = [];

function emitStatus(status, detail) {
  statusSubs.forEach(cb => { try { cb({ status, detail }); } catch {} });
}

function ensureAnalyser() {
  const va = window.vizAudio;
  if (!va || !va.ctx) throw new Error('Audio context not initialized');
  if (!captureAnalyser) {
    captureAnalyser = va.ctx.createAnalyser();
    captureAnalyser.fftSize = va.analyser ? va.analyser.fftSize : 2048;
    captureAnalyser.smoothingTimeConstant = 0.8;
  }
  return captureAnalyser;
}

function attach(stream) {
  const va = window.vizAudio;
  if (va.ctx.state === 'suspended') va.ctx.resume();

  // Discard video tracks if any — we only care about audio.
  stream.getVideoTracks().forEach(t => t.stop());

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No audio in captured stream. In the picker, enable "Share tab audio".');
  }

  const analyser = ensureAnalyser();
  const src = va.ctx.createMediaStreamSource(stream);
  src.connect(analyser); // dead-end — no destination, so no echo

  captureStream = stream;
  captureSrcNode = src;
  va.setActiveAnalyser(analyser);

  // If user stops sharing from the browser UI, clean up.
  audioTracks[0].addEventListener('ended', () => stop());

  emitStatus('active', { kind: audioTracks[0].label || 'capture' });
}

async function startTabCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('Tab capture not supported in this browser. Try Chrome/Edge.');
  }
  // getDisplayMedia requires video:true in most browsers; we throw the video away.
  // preferCurrentTab + selfBrowserSurface nudge the picker toward this tab.
  const constraints = {
    audio: { suppressLocalAudioPlayback: false },
    video: true,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  };
  emitStatus('requesting');
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  attach(stream);
}

async function startDeviceCapture(deviceId) {
  if (!deviceId) throw new Error('No device selected');
  emitStatus('requesting');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
    },
  });
  attach(stream);
}

// Zero-config mic capture — for the common "point my Mac's mic at the
// speakers" DRM workaround. No device picker, no BlackHole, just the
// browser's default audio input.
async function startMicCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone capture not supported in this browser.');
  }
  emitStatus('requesting');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
    },
  });
  attach(stream);
}

// Lists audio input devices. Requires a prior mic permission grant to see labels;
// we do a throwaway getUserMedia first if labels are missing so the user sees
// useful names like "BlackHole 2ch" instead of generic ids.
async function listAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  const needsLabels = devices.some(d => d.kind === 'audioinput' && !d.label);
  if (needsLabels) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* permission denied — return unlabeled list */ }
  }
  return devices
    .filter(d => d.kind === 'audioinput')
    .map(d => ({ deviceId: d.deviceId, label: d.label || 'Audio input' }));
}

function stop() {
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
  if (captureSrcNode) {
    try { captureSrcNode.disconnect(); } catch {}
    captureSrcNode = null;
  }
  const va = window.vizAudio;
  if (va) va.setActiveAnalyser(va.analyser); // revert to primary analyser
  emitStatus('idle');
}

function isActive() { return !!captureStream; }
function onStatusChange(cb) { statusSubs.push(cb); }

window.AudioCapture = {
  startTabCapture,
  startDeviceCapture,
  startMicCapture,
  listAudioDevices,
  stop,
  isActive,
  onStatusChange,
};

})();
