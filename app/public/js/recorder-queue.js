// Upload queue + state machine of the live meeting recorder (design-sedinte-v2.md §3), without DOM or
// MediaRecorder: pages/sedinte-recorder.js wires the browser parts in, test/f2-recorder-queue.test.js
// drives it with fakes. Chunks are sent one at a time, in seq order (POST .../chunk?seq=N).
//
// States: recording | paused | finishing | interrupted (mic lost / recorder error: Finalizează) |
// failed (server refused chunks: nothing more to send) | stopfailed (final /stop failed: retry).

export const TIMESLICE_MS = 60000;
export const STOP_TIMEOUT_MS = 5000; // a hung recorder must not block /stop
export const FLUSH_POLL_MS = 500;
export const MSG_OTHER_DEVICE = "Înregistrarea a fost oprită de pe alt dispozitiv — pornește una nouă. Audio-ul deja trimis a fost păstrat.";
export const MSG_SESSION_EXPIRED = "Sesiune expirată - autentifică-te într-un alt tab; bucățile rămân în memorie.";
export const MSG_RECORDER_STOPPED = "Înregistrarea s-a oprit neașteptat (microfon pierdut).";
export const MSG_NO_SOUND = "Nu mai primesc sunet de la microfon — înregistrarea a fost întreruptă. Finalizează ce s-a înregistrat până acum.";

// Retry delay after the n-th consecutive failure: 2 s, 4 s, ... capped at 30 s.
export function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RecorderQueue {
  // sendChunk(seq, blob) / sendStop(): promises; errors carry { status, data, message } (api.js).
  // capture: { stopRecorder() (no-op when inactive), requestData(), release(), allowUnload(), stopped: Promise|null }.
  constructor({ sendChunk, sendStop, capture, onChange = () => {}, timeslice = TIMESLICE_MS, now = () => Date.now(), sleep = realSleep,
    stopTimeoutMs = STOP_TIMEOUT_MS, flushPollMs = FLUSH_POLL_MS }) {
    Object.assign(this, { sendChunk, sendStop, capture, onChange, timeslice, now, sleep, stopTimeoutMs, flushPollMs });
    this.queue = []; this.nextSeq = 0; this.sent = 0; this.attempt = 0; this.pumping = false;
    this.state = "recording"; this.error = null; this.warn = null;
    this.lastData = now(); this.probeAt = null; this.stallSecs = 0;
  }

  // MediaRecorder dataavailable.
  onData(blob) {
    if (blob && blob.size) { this.lastData = this.now(); this.probeAt = null; this.stallSecs = 0; }
    if (!blob || !blob.size || this.state === "failed") return;
    this.queue.push({ seq: this.nextSeq++, blob });
    this.pump();
    this.onChange();
  }

  // The recorder stopped by itself (all tracks ended) while we think we're recording = interruption.
  onRecorderStopped() {
    if (this.state === "recording" || this.state === "paused") this.interrupt(MSG_RECORDER_STOPPED);
  }

  // Sends queued chunks one at a time, in order. Network errors / 5xx / 429 / 401 are retried with
  // backoff (a 401 does not redirect: the queue stays in memory while the user logs in elsewhere);
  // a 409 whose expected_seq is past this chunk means the server already has it (skip); any other 4xx
  // means the server will never accept this recording -> fatal.
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.state !== "failed") {
        const head = this.queue[0];
        try {
          await this.sendChunk(head.seq, head.blob);
          this.queue.shift(); this.sent++; this.attempt = 0; this.warn = this.warn === MSG_SESSION_EXPIRED ? null : this.warn;
        } catch (e) {
          const st = e.status;
          if (st === 409 && e.data && e.data.expected_seq > head.seq) { this.queue.shift(); this.attempt = 0; continue; }
          if (st === 401) this.warn = MSG_SESSION_EXPIRED;
          else if (st >= 400 && st < 500 && st !== 429) { this.fail(/nu mai e activă/i.test(e.message) ? MSG_OTHER_DEVICE : e.message); break; }
          this.attempt++;
          this.onChange();
          await this.sleep(backoffMs(this.attempt));
        }
        this.onChange();
      }
    } finally { this.pumping = false; this.onChange(); }
  }

  // Server refused the recording for good: stop capturing, free the mic, drop what can't be sent.
  fail(msg) {
    this.state = "failed"; this.error = msg; this.queue = [];
    try { this.capture.stopRecorder(); } catch { /* ignore */ }
    this.capture.release();
    this.capture.allowUnload(); // the server refuses this recording: nothing is left to protect
    this.onChange();
  }

  // Mic lost / recorder error: flush what exists, then let the user finalize.
  interrupt(msg) {
    if (this.state === "interrupted" || this.state === "failed" || this.state === "finishing") return;
    this.state = "interrupted"; this.error = msg;
    try { this.capture.stopRecorder(); } catch { /* ignore */ }
    this.capture.release();
    this.pump();
    this.onChange();
  }

  pause() { this.state = "paused"; this.onChange(); }
  resume() { this.lastData = this.now(); this.stallSecs = 0; this.probeAt = null; this.state = "recording"; this.onChange(); }

  // No dataavailable for timeslice + 15 s while recording = the mic stopped delivering audio.
  // Probe once with requestData(); still nothing after another timeslice -> interrupted (finalize offered).
  watchdog(now = this.now()) {
    if (this.state !== "recording") return;
    const silent = now - this.lastData;
    if (silent <= this.timeslice + 15000) return;
    this.stallSecs = Math.round(silent / 1000);
    if (!this.probeAt) {
      this.probeAt = now;
      try { this.capture.requestData(); } catch { /* recorder already dead */ }
      this.onChange();
    } else if (now - this.probeAt > this.timeslice) {
      this.interrupt(MSG_NO_SOUND);
    }
  }

  // Oprește / Finalizează / Reîncearcă: stop capturing, flush the queue, POST /stop. Safe to repeat.
  // Resolves true when /stop succeeded, false if the recording had already failed; rejects -> "stopfailed".
  async finish() {
    if (this.state === "failed") return false;
    this.state = "finishing"; this.onChange();
    try {
      this.capture.stopRecorder(); // flushes the last chunk first
      // also covers a stop() already issued by interrupt()
      if (this.capture.stopped) await Promise.race([this.capture.stopped, this.sleep(this.stopTimeoutMs)]);
      this.capture.release();
      while (this.queue.length && this.state !== "failed") { this.pump(); await this.sleep(this.flushPollMs); }
      if (this.state === "failed") throw new Error(this.error);
      await this.sendStop();
    } catch (e) {
      if (this.state !== "failed") { this.state = "stopfailed"; this.error = `Finalizarea a eșuat: ${e.message}`; }
      this.onChange();
      throw e;
    }
    this.capture.allowUnload(); // tab-close guard stays until the queue is empty AND /stop succeeded
    return true;
  }
}
