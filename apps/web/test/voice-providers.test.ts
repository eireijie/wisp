import { afterEach, describe, expect, it, vi } from "vitest";
import { createListener, createSpeaker, speechChunks, type ListenCallbacks } from "../src/voice/providers.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const callbacks = (): ListenCallbacks => ({ partial: vi.fn(), final: vi.fn(), level: vi.fn(), activity: vi.fn(), error: vi.fn() });
class Recognition {
  static instances: Recognition[] = [];
  static autoStart = true;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => { if (Recognition.autoStart) this.onstart?.(); });
  abort = vi.fn(() => this.onend?.());
  constructor() { Recognition.instances.push(this); }
  result(text: string) { this.onresult?.({ results: [{ 0: { transcript: text }, isFinal: false }] }); }
}
function browser() {
  vi.useFakeTimers(); Recognition.instances = []; Recognition.autoStart = true;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const capture = vi.fn(async () => stream);
  const close = vi.fn(async () => {});
  vi.stubGlobal("window", { SpeechRecognition: Recognition });
  vi.stubGlobal("navigator", { language: "en-US", mediaDevices: { getUserMedia: capture } });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = close;
    createAnalyser = () => ({ fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(0) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  return { track, stream, capture, close };
}

describe("device listening", () => {
  it("waits for recognition to go live and cancels a blocked recognition attempt", async () => {
    const { track } = browser(); Recognition.autoStart = false;
    const cb = callbacks(), listener = createListener("device", cb), ready = vi.fn();
    const starting = listener.start().then(ready);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ready).not.toHaveBeenCalled();
    const blocked = Recognition.instances[0];
    listener.stop(); await starting;
    expect(blocked.abort).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    const retry = listener.start().then(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1);
    Recognition.instances[1].onstart?.(); await retry;
    expect(ready).toHaveBeenCalledTimes(2);
    listener.stop();
  });
  it("settles a denied recognition start with the existing error copy", async () => {
    browser(); Recognition.autoStart = false;
    const cb = callbacks(), listener = createListener("device", cb);
    const starting = listener.start();
    await vi.advanceTimersByTimeAsync(0);
    Recognition.instances[0].onerror?.({ error: "not-allowed" });
    await starting;
    expect(cb.error).toHaveBeenCalledWith(expect.stringContaining("access was denied"));
  });
  it("requests permission only at start and releases a mic that arrives after hang-up", async () => {
    const { capture, track, stream } = browser();
    let allow!: (s: typeof stream) => void;
    capture.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
    const listener = createListener("device", callbacks());
    expect(capture).not.toHaveBeenCalled();
    const starting = listener.start(); listener.stop(); allow(stream); await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Recognition.instances).toHaveLength(0);
  });
  it("commits after short silence, restarts, and does not duplicate a cumulative result", async () => {
    browser(); const cb = callbacks(), listener = createListener("device", cb);
    await listener.start();
    const first = Recognition.instances[0];
    first.result("Hello");
    await vi.advanceTimersByTimeAsync(200);
    first.result("Hello there");
    await vi.advanceTimersByTimeAsync(399);
    expect(cb.final).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cb.final).toHaveBeenCalledExactlyOnceWith("Hello there");
    first.result("Hello there again");
    await vi.advanceTimersByTimeAsync(150);
    expect(Recognition.instances).toHaveLength(2);
    Recognition.instances[1].result("Another turn");
    await vi.advanceTimersByTimeAsync(400);
    expect(cb.final).toHaveBeenCalledTimes(2);
    listener.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards partial speech on mute and makes permission failures terminal", async () => {
    const { track } = browser(); const cb = callbacks(), listener = createListener("device", cb);
    await listener.start();
    Recognition.instances[0].result("Unfinished");
    listener.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cb.final).not.toHaveBeenCalled(); expect(track.stop).toHaveBeenCalled();
    await listener.start();
    Recognition.instances[1].onerror?.({ error: "not-allowed" });
    expect(cb.error).toHaveBeenCalledWith(expect.stringContaining("denied"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(Recognition.instances).toHaveLength(2);
  });
  it("explains missing recognition without requesting the microphone", async () => {
    const { capture } = browser(); vi.stubGlobal("window", {});
    await expect(createListener("device", callbacks()).start()).rejects.toThrow("doesn't offer speech recognition");
    expect(capture).not.toHaveBeenCalled();
  });
});

it("voice previews never open the mic and cancellation settles playback", async () => {
  const { capture } = browser();
  const synthesis = { getVoices: () => [], speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal("window", { speechSynthesis: synthesis });
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  const speaker = createSpeaker("device", {}, "pip");
  const level = vi.fn(), speaking = speaker.speak("Hello", level);
  speaker.cancel(); await speaking;
  expect(synthesis.speak).toHaveBeenCalledOnce();
  expect(synthesis.cancel).toHaveBeenCalledOnce();
  expect(level).toHaveBeenLastCalledWith(0);
  expect(capture).not.toHaveBeenCalled();
});

it("records cloud turns with leading audio, discards silence, and aborts transcription on mute", async () => {
  const { track } = browser();
  let frame: (() => void) | undefined, loud = false, clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frame = fn; return 1; });
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = async () => {};
    createAnalyser = () => ({ fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(loud ? 0.08 : 0) });
    createMediaStreamSource = () => ({ connect() {} });
  });
  const recordings: Recorder[] = [];
  class Recorder {
    static isTypeSupported = (type: string) => type === "audio/mp4";
    state = "inactive";
    ondataavailable?: (e: { data: Blob }) => void;
    onstop?: () => void;
    constructor() { recordings.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  let requestSignal: AbortSignal | undefined;
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  vi.stubGlobal("fetch", fetcher);
  const cb = callbacks(), listener = createListener("openai", cb);
  await listener.start();
  expect(recordings).toHaveLength(1); // record before speech, so the opening syllable survives VAD
  await vi.advanceTimersByTimeAsync(1500);
  expect(fetcher).not.toHaveBeenCalled();
  loud = true; clock = 10; frame?.(); clock = 140; frame?.();
  expect(cb.activity).toHaveBeenCalledWith(true);
  loud = false; clock = 900; frame?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ kind: "listen", mime: "audio/mp4" });
  listener.stop();
  expect(requestSignal?.aborted).toBe(true);
  expect(track.stop).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(cb.final).not.toHaveBeenCalled();
  expect(cb.error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
});

describe("speech chunks", () => {
  it("splits a reply into sentences and folds short ones into the next", () => {
    expect(speechChunks("Sure. I moved the meeting to Friday at ten. Want me to tell Sam?")).toEqual(["Sure. I moved the meeting to Friday at ten.", "Want me to tell Sam?"]);
    expect(speechChunks("No punctuation here")).toEqual(["No punctuation here"]);
    expect(speechChunks("Version 2.5 shipped today, and it's faster.")).toEqual(["Version 2.5 shipped today, and it's faster."]);
  });
});

it("plays an AI voice sentence by sentence, fetching the next while one plays", async () => {
  const sources: { onended?: () => void }[] = [];
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("AudioContext", class {
    state = "running"; destination = {};
    resume = async () => {};
    close = async () => {};
    decodeAudioData = async () => ({});
    createAnalyser = () => ({ fftSize: 512, connect() {}, getFloatTimeDomainData: (d: Float32Array) => d.fill(0) });
    createBufferSource = () => { const s = { buffer: null, playbackRate: { value: 1 }, connect() {}, stop() {}, start() {}, onended: undefined as (() => void) | undefined }; sources.push(s); return s; };
  });
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(new Uint8Array([1])));
  vi.stubGlobal("fetch", fetcher);
  const text = (n: number) => JSON.parse(fetcher.mock.calls[n][1].body as string).text;
  const speaking = createSpeaker("openai", {}, "chunk-test").speak("The meeting moved to Friday at ten. I told Sam and updated the invite.", vi.fn());
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  // the second sentence is already on its way while the first plays
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect([text(0), text(1)]).toEqual(["The meeting moved to Friday at ten.", "I told Sam and updated the invite."]);
  sources[0].onended!();
  await vi.waitFor(() => expect(sources).toHaveLength(2));
  sources[1].onended!();
  await speaking;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
