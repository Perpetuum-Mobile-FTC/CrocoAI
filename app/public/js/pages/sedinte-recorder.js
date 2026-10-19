// Înregistrare live a ședinței (design-sedinte-v2.md §3). MediaRecorder cu timeslice 60 s; fiecare
// bucată e trimisă pe server (POST .../chunk?seq=N) dintr-o coadă în memorie, cu retry/backoff
// (coada + mașina de stări: ../recorder-queue.js, fără DOM, testată în node).
// Un singur recorder activ per tab (`live`); UI-ul se re-atașează dacă pagina e re-randată.
import { api } from "../api.js";
import { esc, toast, confirmDialog, busyOnClick, fmtDateTime } from "../ui.js";
import { RecorderQueue, TIMESLICE_MS } from "../recorder-queue.js";

const BITRATE = 32000;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

let live = null; // recorder activ în acest tab

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h, m, r].map((n) => String(n).padStart(2, "0")).join(":");
}

const RECENT_MS = 2 * 60 * 1000;

// Browser side of one live recording: microphone, MediaRecorder, level meter, wake lock, tab-close guard
// and the UI. Queue, retries, watchdog and the state machine live in RecorderQueue (recorder-queue.js).
class LiveRecorder {
  constructor(meetingId, rid, onFinished) {
    this.meetingId = meetingId; this.rid = rid; this.onFinished = onFinished;
    this.released = false; this.muteCount = 0; this.lastMute = null;
    this.elapsed = 0; this.tickStart = Date.now();
    this.box = null;
    const base = `/api/meetings/${meetingId}/recording/${rid}`;
    const self = this;
    this.q = new RecorderQueue({
      sendChunk: (seq, blob) => api.post(`${base}/chunk?seq=${seq}`, blob, { allow401: true }),
      sendStop: () => api.post(`${base}/stop`),
      capture: {
        stopRecorder: () => { if (self.recorder && self.recorder.state !== "inactive") self.recorder.stop(); },
        requestData: () => self.recorder.requestData(),
        release: () => self.release(),
        allowUnload: () => self.allowUnload(),
        get stopped() { return self.stopped; },
      },
      onChange: () => this.render(),
      timeslice: window.__CROCO_REC_TIMESLICE_MS || TIMESLICE_MS,
    });
  }

  async init(mime) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.recorder = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: BITRATE });
    this.recorder.ondataavailable = (e) => this.q.onData(e.data);
    this.stopped = new Promise((resolve) => this.recorder.addEventListener("stop", resolve, { once: true })); // after the final dataavailable
    this.stopped.then(() => this.q.onRecorderStopped());
    this.recorder.onerror = (e) => this.q.interrupt(`Eroare la înregistrare: ${(e.error && e.error.message) || "necunoscută"}.`);
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => this.q.interrupt("Microfonul s-a oprit (deconectat sau acces retras).");
      track.onmute = () => { this.muteCount++; this.lastMute = new Date(); this.q.warn = "Microfonul nu transmite sunet în acest moment."; this.render(); };
      track.onunmute = () => { this.q.warn = null; this.render(); };
    }
    this.recorder.start(window.__CROCO_REC_TIMESLICE_MS || TIMESLICE_MS);
    this.setupLevel();
    this.requestWakeLock();
    this.onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", this.onBeforeUnload);
    this.onVisible = () => { if (document.visibilityState === "visible" && this.q.state === "recording") this.requestWakeLock(); };
    document.addEventListener("visibilitychange", this.onVisible);
    this.q.lastData = Date.now();
    this.timer = setInterval(() => this.tick(), 250);
  }

  setupLevel() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.audioCtx.createMediaStreamSource(this.stream).connect(this.analyser);
      this.levelData = new Uint8Array(this.analyser.fftSize);
    } catch { this.analyser = null; }
  }
  level() {
    if (!this.analyser || this.q.state !== "recording") return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let peak = 0;
    for (const v of this.levelData) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(100, Math.round((peak / 128) * 140));
  }
  async requestWakeLock() {
    try { if (navigator.wakeLock) this.wakeLock = await navigator.wakeLock.request("screen"); } catch { /* optional */ }
  }

  tick() {
    const now = Date.now();
    if (this.q.state === "recording") this.elapsed += now - this.tickStart;
    this.tickStart = now;
    this.q.watchdog(now);
    if (!this.box || !this.box.isConnected) return;
    const t = this.box.querySelector("[data-rec-timer]");
    if (t) t.textContent = fmtClock(this.elapsed);
    const sx = this.box.querySelector(".rec-controls .form-error");
    if (sx && this.q.stallSecs) sx.textContent = `fără sunet de ${Math.round((now - this.q.lastData) / 1000)}s`;
    const l = this.box.querySelector("[data-rec-level]");
    if (l) l.style.width = this.level() + "%";
  }

  get state() { return this.q.state; } // read by the browser smoke tests (window.__crocoRecorder)

  pause() { this.recorder.pause(); this.q.pause(); }
  resume() { this.recorder.resume(); this.tickStart = Date.now(); this.q.resume(); this.requestWakeLock(); }

  // Oprește / Finalizează / Reîncearcă (see RecorderQueue.finish).
  async finish() {
    if (!(await this.q.finish())) return;
    live = null;
    this.onFinished();
  }

  allowUnload() {
    window.removeEventListener("beforeunload", this.onBeforeUnload);
  }

  release() {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.stream) this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    if (this.wakeLock) this.wakeLock.release().catch(() => {});
  }

  attach(box) { this.box = box; this.render(); }
  render() {
    const box = this.box;
    if (!box || !box.isConnected) return;
    const q = this.q;
    const pending = q.queue.length;
    const st = q.state;
    const label = { recording: '<span class="rec-dot"></span>Se înregistrează', paused: "În pauză", finishing: "Se finalizează…",
      interrupted: "Înregistrare întreruptă", failed: "Înregistrare oprită", stopfailed: "Finalizare eșuată" }[st];
    box.innerHTML = `
      <div class="rec-controls">
        <span class="rec-timer" data-rec-timer>${fmtClock(this.elapsed)}</span>
        <span>${label}</span>${q.stallSecs ? ` <strong class="form-error">fără sunet de ${q.stallSecs}s</strong>` : ""}
        <div class="rec-level"><span data-rec-level></span></div>
      </div>
      <p class="muted small">Bucăți trimise: <strong>${q.sent}</strong>${pending ? ` · în așteptare: ${pending}${q.attempt ? " (reîncerc…)" : ""}` : ""}</p>
      ${q.error ? `<p class="form-error">${esc(q.error)}</p>` : ""}
      ${q.stallSecs && st === "recording" ? `<p class="form-error"><strong>Nu mai primesc sunet de la microfon — verifică laptopul/microfonul.</strong></p>` : ""}
      ${this.muteCount ? `<p class="muted small">Microfonul a fost ${this.muteCount === 1 ? "întrerupt o dată" : `întrerupt de ${this.muteCount} ori`} (ultima: ${esc(this.lastMute.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" }))}).</p>` : ""}
      ${q.warn && st !== "failed" ? `<p class="muted small">${esc(q.warn)}</p>` : ""}
      <div class="rec-controls">
        ${st === "recording" ? `<button class="btn btn-small" data-act="pause">Pauză</button>` : ""}
        ${st === "paused" ? `<button class="btn btn-small" data-act="resume">Reia</button>` : ""}
        ${st === "recording" || st === "paused" ? `<button class="btn btn-small btn-danger" data-act="stop">Oprește</button>` : ""}
        ${st === "interrupted" ? `<button class="btn btn-small" data-act="stop">Finalizează înregistrarea</button>` : ""}
        ${st === "stopfailed" ? `<button class="btn btn-small" data-act="stop">Reîncearcă finalizarea</button>` : ""}
        ${st === "failed" ? `<button class="btn btn-small" data-act="close">Închide</button>` : ""}
      </div>`;
    box.querySelector('[data-act="pause"]')?.addEventListener("click", () => this.pause());
    box.querySelector('[data-act="resume"]')?.addEventListener("click", () => this.resume());
    box.querySelector('[data-act="close"]')?.addEventListener("click", () => { live = null; this.onFinished(); });
    const stopBtn = box.querySelector('[data-act="stop"]');
    if (stopBtn) busyOnClick(stopBtn, async () => {
      try { await this.finish(); toast("Înregistrare trimisă, se transcrie…", "success"); }
      catch (e) { toast(e.message, "error"); }
    });
  }
}

// `onChange` re-renders the whole meeting after the audio state changed (finished / abandoned).
export async function renderRecordingBox(box, meeting, { onChange }) {
  if (live && live.meetingId === meeting.id) { live.attach(box); return; }
  const approved = meeting.status === "approved";
  if (approved) { box.innerHTML = ""; return; }

  let unfinished = null;
  try {
    const st = await api.get(`/api/meetings/${meeting.id}/recording`);
    if (st.recording_id) unfinished = st;
  } catch { /* no live-recording UI if the status can't be read */ }

  if (unfinished) {
    const lastMs = Date.parse(unfinished.last_chunk_at || unfinished.started_at);
    const recent = Number.isFinite(lastMs) && Date.now() - lastMs < RECENT_MS;
    box.innerHTML = `
      <p><strong>Înregistrare neterminată</strong> (începută ${esc(fmtDateTime(unfinished.started_at))}, ${unfinished.chunks} bucăți primite).</p>
      ${recent ? `<p class="form-error">Pare să se înregistreze acum pe alt dispozitiv (ultima bucată a ajuns acum mai puțin de 2 minute).</p>` : ""}
      <div class="rec-controls">
        <button class="btn btn-small" data-act="finalize">Finalizează înregistrarea</button>
        <button class="btn btn-small btn-ghost" data-act="abandon">Renunță</button>
      </div>`;
    busyOnClick(box.querySelector('[data-act="finalize"]'), async () => {
      const q = recent ? "Pare că se înregistrează acum pe alt dispozitiv - finalizarea o va opri. Continui?" : "Finalizezi această înregistrare și pornești transcrierea?";
      if (!(await confirmDialog(q, { danger: recent }))) return;
      try { await api.post(`/api/meetings/${meeting.id}/recording/${unfinished.recording_id}/stop`); toast("Înregistrare finalizată, se transcrie…", "success"); onChange(); }
      catch (e) { toast(e.message, "error"); }
    });
    busyOnClick(box.querySelector('[data-act="abandon"]'), async () => {
      const q = recent ? "Pare că se înregistrează acum pe alt dispozitiv - renunțarea șterge tot ce s-a trimis. Continui?" : "Renunți la această înregistrare? Bucățile primite se șterg.";
      if (!(await confirmDialog(q, { danger: true }))) return;
      try { await api.post(`/api/meetings/${meeting.id}/recording/${unfinished.recording_id}/abandon`); onChange(); }
      catch (e) { toast(e.message, "error"); }
    });
    return;
  }

  const mime = pickMime();
  if (mime === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    box.innerHTML = `<p class="muted small">Browserul nu permite înregistrarea live - folosește „Încarcă fișier”.</p>`;
    return;
  }
  box.innerHTML = `<button class="btn btn-small" id="rec-start">Pornește înregistrarea</button>
    <span class="muted small">Microfon, bucăți de ~1 minut trimise automat.</span>`;
  busyOnClick(box.querySelector("#rec-start"), async () => {
    if (live) { toast("O altă înregistrare e în curs în acest tab - oprește-o mai întâi.", "error"); return; }
    const hasAudio = ["processing", "done"].includes(meeting.audio_status);
    if (hasAudio && !(await confirmDialog("Ședința are deja audio. Îl înlocuiești cu o înregistrare nouă?", { danger: true }))) return;
    try {
      const { recording_id } = await api.post(`/api/meetings/${meeting.id}/recording/start`, { mime, replace: hasAudio });
      const rec = new LiveRecorder(meeting.id, recording_id, onChange);
      try { await rec.init(mime); }
      catch (e) {
        await api.post(`/api/meetings/${meeting.id}/recording/${recording_id}/abandon`).catch(() => {});
        throw new Error(e.name === "NotAllowedError" ? "Accesul la microfon a fost refuzat." : `Microfon indisponibil: ${e.message}`);
      }
      live = rec;
      if (window.__CROCO_REC_TIMESLICE_MS) window.__crocoRecorder = rec; // test flag only
      rec.attach(box);
    } catch (e) { toast(e.message, "error"); }
  });
}
