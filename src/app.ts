// VoxBridge front end
// Author: Swayam Shakya
//
// Runs on its own in the browser (that's how the GitHub Pages build works):
// browser speech recognition, browser voices and an online translation
// service. When a main.py server is reachable it switches over to it for
// Whisper, MarianMT / NLLB and Coqui, talking to it over a WebSocket.

type Side = "a" | "b";

interface Language { code: string; name: string; locale: string; }
interface Health { stt: "whisper" | "browser"; tts: "coqui" | "browser"; translator: string; }

interface Line {
  id: string;
  side: Side;
  original: string;
  translation: string;
  source: string;
  target: string;
  engine?: string;
  state: "pending" | "done" | "failed";
  at: number;
}

interface ServerMsg {
  type: "pong" | "status" | "transcript" | "result" | "error";
  ref?: string;
  text?: string;
  source?: string;
  target?: string;
  original?: string;
  translation?: string;
  engine?: string;
  stage?: string;
  message?: string;
  ms?: number;
}

// Chrome / Safari ship the recogniser under a prefix and TS has no types for it
interface Recognizer {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
const RecognizerCtor: (new () => Recognizer) | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const STORE_KEY = "voxbridge.v1";
const SERVER_KEY = "voxbridge.server";

const BUILTIN_LANGUAGES: Language[] = [
  ["en", "English", "en-US"], ["es", "Spanish", "es-ES"], ["fr", "French", "fr-FR"],
  ["de", "German", "de-DE"], ["it", "Italian", "it-IT"], ["pt", "Portuguese", "pt-PT"],
  ["nl", "Dutch", "nl-NL"], ["ru", "Russian", "ru-RU"], ["uk", "Ukrainian", "uk-UA"],
  ["pl", "Polish", "pl-PL"], ["tr", "Turkish", "tr-TR"], ["ar", "Arabic", "ar-SA"],
  ["hi", "Hindi", "hi-IN"], ["ne", "Nepali", "ne-NP"], ["bn", "Bengali", "bn-IN"],
  ["zh", "Chinese", "zh-CN"], ["ja", "Japanese", "ja-JP"], ["ko", "Korean", "ko-KR"],
  ["vi", "Vietnamese", "vi-VN"], ["id", "Indonesian", "id-ID"],
].map(([code, name, locale]) => ({ code, name, locale }));

// ---------- server address ----------

let serverBase: string | null = null;  // null means browser-only mode

function savedServer(): string {
  const fromQuery = new URLSearchParams(location.search).get("server");
  if (fromQuery !== null) return fromQuery;
  try { return localStorage.getItem(SERVER_KEY) || ""; } catch { return ""; }
}

async function probe(base: string): Promise<Health | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const h = await r.json();
    return h && h.status === "ok" ? h : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findServer(): Promise<{ base: string; health: Health } | null> {
  const candidates: string[] = [];
  const saved = savedServer().trim().replace(/\/+$/, "");
  if (saved) candidates.push(saved);
  // served by main.py itself
  if (document.querySelector('meta[name="voxbridge-server"]')) {
    candidates.push(location.origin);
  }
  for (const base of candidates) {
    const health = await probe(base);
    if (health) return { base, health };
  }
  return null;
}

// ---------- tiny helpers ----------

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

function card(side: Side): HTMLElement {
  return $(`.speaker[data-side="${side}"]`);
}

function other(side: Side): Side {
  return side === "a" ? "b" : "a";
}

let toastTimer = 0;
function toast(text: string, ms = 3200): void {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), ms);
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- state ----------

const state = {
  languages: [] as Language[],
  health: { stt: "browser", tts: "browser", translator: "online" } as Health,
  lines: [] as Line[],
  serverVoices: [] as string[],
  recordingSide: null as Side | null,
};

function langName(code: string): string {
  return state.languages.find(l => l.code === code)?.name ?? code;
}

function locale(code: string): string {
  return state.languages.find(l => l.code === code)?.locale ?? code;
}

function chosenLang(side: Side): string {
  return $<HTMLSelectElement>(".lang", card(side)).value;
}

function speakerName(side: Side): string {
  return $<HTMLInputElement>(".who", card(side)).value.trim() || side.toUpperCase();
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      lines: state.lines.filter(l => l.state === "done").slice(-200),
      a: chosenLang("a"),
      b: chosenLang("b"),
      nameA: speakerName("a"),
      nameB: speakerName("b"),
      speed: $<HTMLInputElement>("#speed").value,
      voiceA: $<HTMLSelectElement>(".voice", card("a")).value,
      voiceB: $<HTMLSelectElement>(".voice", card("b")).value,
    }));
  } catch { /* private mode or storage full: not worth bothering the user */ }
}

function load(): any {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

// ---------- socket ----------

class Link {
  private ws: WebSocket | null = null;
  private retry = 0;
  private pingTimer = 0;
  onMessage: (m: ServerMsg) => void = () => {};

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!serverBase) return;
    const ws = new WebSocket(serverBase.replace(/^http/, "ws") + "/ws");
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      setConn(true);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25000);
    };
    ws.onmessage = ev => {
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.warn("bad message from server", err);
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws || !serverBase) return;  // replaced or switched off
      setConn(false);
      const wait = Math.min(1000 * 2 ** this.retry++, 10000);
      setTimeout(() => this.connect(), wait);
    };
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  send(payload: object): boolean {
    if (!this.ready) return false;
    this.ws!.send(JSON.stringify(payload));
    return true;
  }
}

const link = new Link();

function setConn(on: boolean | "local"): void {
  const chip = $("#chip-conn");
  if (on === "local") {
    chip.className = "chip on";
    chip.innerHTML = "<i></i>in-browser";
    chip.title = "Running without a model server";
    return;
  }
  chip.className = "chip " + (on ? "on" : "off");
  chip.innerHTML = `<i></i>${on ? "server live" : "reconnecting…"}`;
  chip.title = serverBase || "";
}

// ---------- conversation log ----------

function render(): void {
  const list = $("#log");
  list.innerHTML = "";
  for (const line of state.lines) list.appendChild(renderLine(line));
  $("#empty").style.display = state.lines.length ? "none" : "";
}

function renderLine(line: Line): HTMLElement {
  const li = document.createElement("li");
  li.className = `line ${line.side} ${line.state}`;
  li.dataset.id = line.id;

  const badge = document.createElement("span");
  badge.className = `badge ${line.side}`;
  badge.textContent = line.side.toUpperCase();
  badge.title = speakerName(line.side);

  const said = cell(line.original, langName(line.source), line.original ? line.source : "");
  said.classList.add("said");

  let shown = line.translation;
  if (line.state === "pending") shown = "translating…";
  const tr = cell(shown, langName(line.target), line.state === "done" ? line.target : "");
  tr.classList.add("translated");

  const time = document.createElement("span");
  time.textContent = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  tr.querySelector(".meta")!.appendChild(time);

  li.append(badge, said, tr);
  return li;
}

function cell(text: string, label: string, playLang: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "cell";
  const p = document.createElement("p");
  p.textContent = text;
  const meta = document.createElement("div");
  meta.className = "meta";
  const tag = document.createElement("span");
  tag.textContent = label;
  meta.appendChild(tag);
  if (playLang && text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "play";
    btn.textContent = "▶ play";
    btn.addEventListener("click", () => speak(text, playLang));
    meta.appendChild(btn);
  }
  div.append(p, meta);
  return div;
}

function upsert(line: Line): void {
  const i = state.lines.findIndex(l => l.id === line.id);
  if (i === -1) state.lines.push(line);
  else state.lines[i] = line;

  const list = $("#log");
  const old = list.querySelector(`[data-id="${line.id}"]`);
  const fresh = renderLine(line);
  if (old) old.replaceWith(fresh);
  else list.appendChild(fresh);
  $("#empty").style.display = "none";
  fresh.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (line.state !== "pending") save();
}

// ---------- translation requests ----------

function request(side: Side, text: string, audio?: string): void {
  const id = uid();
  const detect = $<HTMLInputElement>("#auto-detect").checked;
  const source = detect ? "auto" : chosenLang(side);
  const target = chosenLang(other(side));

  upsert({
    id, side, original: audio ? "…" : text, translation: "",
    source: source === "auto" ? chosenLang(side) : source,
    target, state: "pending", at: Date.now(),
  });

  const payload = audio
    ? { type: "audio", ref: id, data: audio, source: detect ? null : source, target, alt_target: chosenLang(side) }
    : { type: "text", ref: id, text, source, target, alt_target: chosenLang(side) };

  if (!serverBase) {
    translateText(text, chosenLang(side), target, detect)
      .then(res => handle({ type: "result", ref: id, original: text, ...res }))
      .catch(err => fail(id, String(err.message || err)));
    return;
  }

  if (link.send(payload)) return;

  // socket is down; text can still go over plain HTTP
  if (audio) {
    fail(id, "Not connected to the server");
    return;
  }
  fetch(`${serverBase}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source, target, alt_target: chosenLang(side) }),
  })
    .then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || r.statusText);
      handle({ type: "result", ref: id, ...body });
    })
    .catch(err => fail(id, String(err.message || err)));
}

function fail(id: string, why: string): void {
  const line = state.lines.find(l => l.id === id);
  if (!line) return;
  if (line.original === "…") line.original = "";
  upsert({ ...line, state: "failed", translation: why });
  setBusy(line.side, false);
  toast(why);
}

function handle(msg: ServerMsg): void {
  if (msg.type === "pong" || !msg.ref) {
    if (msg.type === "error") toast(msg.message || "Something went wrong");
    return;
  }
  const line = state.lines.find(l => l.id === msg.ref);
  if (!line) return;

  switch (msg.type) {
    case "status":
      setHint(line.side, msg.stage === "transcribing" ? "Listening back…" : "Translating…");
      break;
    case "transcript":
      upsert({ ...line, original: msg.text || "", source: msg.source || line.source });
      break;
    case "result": {
      const done: Line = {
        ...line,
        original: msg.original ?? line.original,
        translation: msg.translation || "",
        source: msg.source || line.source,
        target: msg.target || line.target,
        engine: msg.engine,
        state: "done",
      };
      upsert(done);
      setBusy(line.side, false);
      if ($<HTMLInputElement>("#auto-speak").checked && done.translation) {
        speak(done.translation, done.target);
      }
      break;
    }
    case "error":
      fail(line.id, msg.message || "Something went wrong");
      break;
  }
}

link.onMessage = handle;

// ---------- speech output ----------

const player = new VoicePlayer();

function speed(): number {
  return parseFloat($<HTMLInputElement>("#speed").value) || 1;
}

// the voice menu under each person is used whenever their language is spoken
function sideForLang(lang: string): Side {
  return chosenLang("b") === lang ? "b" : "a";
}

async function speak(text: string, lang: string): Promise<void> {
  const choice = $<HTMLSelectElement>(".voice", card(sideForLang(lang))).value;
  try {
    await player.speak(text, lang, choice, speed(), state.health.tts === "coqui");
  } catch {
    toast(`Couldn't play a ${langName(lang)} voice. Check your connection and try again.`);
  }
}

function stopSpeaking(): void {
  player.stop();
}

function fillVoices(side: Side): void {
  const select = $<HTMLSelectElement>(".voice", card(side));
  const previous = select.value || savedVoices[side] || "auto";
  select.innerHTML = "";
  const options = voiceOptions(chosenLang(side), state.serverVoices, state.health.tts === "coqui" && !!serverBase);
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const opt of options) {
    const el = new Option(opt.label, opt.id);
    if (!opt.group) {
      select.appendChild(el);
      continue;
    }
    if (!groups.has(opt.group)) {
      const g = document.createElement("optgroup");
      g.label = opt.group;
      groups.set(opt.group, g);
      select.appendChild(g);
    }
    groups.get(opt.group)!.appendChild(el);
  }
  select.value = options.some(o => o.id === previous) ? previous : "auto";
  select.title = `Voice used when ${langName(chosenLang(side))} is read aloud`;
}

const savedVoices: Record<Side, string> = { a: "", b: "" };

// short preview played when someone picks a voice
const SAMPLE_LINE: Record<string, string> = {
  en: "Hello, this is my voice.", es: "Hola, esta es mi voz.", fr: "Bonjour, voici ma voix.",
  de: "Hallo, das ist meine Stimme.", it: "Ciao, questa è la mia voce.", pt: "Olá, esta é a minha voz.",
  nl: "Hallo, dit is mijn stem.", ru: "Здравствуйте, это мой голос.", uk: "Привіт, це мій голос.",
  pl: "Cześć, to jest mój głos.", tr: "Merhaba, bu benim sesim.", ar: "مرحبًا، هذا صوتي.",
  hi: "नमस्ते, यह मेरी आवाज़ है।", ne: "नमस्ते, यो मेरो आवाज हो।", bn: "নমস্কার, এটা আমার কণ্ঠস্বর।",
  zh: "你好，这是我的声音。", ja: "こんにちは、これは私の声です。", ko: "안녕하세요, 제 목소리입니다.",
  vi: "Xin chào, đây là giọng của tôi.", id: "Halo, ini suara saya.",
};

// ---------- microphone ----------

class Meter {
  private ctx: AudioContext | null = null;
  private raf = 0;

  start(stream: MediaStream, canvas: HTMLCanvasElement): void {
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    this.ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const g = canvas.getContext("2d")!;
    const color = getComputedStyle(canvas.parentElement!).backgroundColor;

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const level = Math.min(peak / 64, 1);
      const { width: w, height: h } = canvas;
      g.clearRect(0, 0, w, h);
      g.beginPath();
      g.arc(w / 2, h / 2, w * 0.38 + level * w * 0.12, 0, Math.PI * 2);
      g.lineWidth = 3;
      g.strokeStyle = color;
      g.globalAlpha = 0.35 + level * 0.65;
      g.stroke();
      this.raf = requestAnimationFrame(draw);
    };
    draw();
  }

  stop(canvas: HTMLCanvasElement): void {
    cancelAnimationFrame(this.raf);
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

const meter = new Meter();
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let recognizer: Recognizer | null = null;

function setHint(side: Side, text: string): void {
  $(".hint", card(side)).textContent = text;
}

function setBusy(side: Side, busy: boolean): void {
  const mic = $<HTMLButtonElement>(".mic", card(side));
  mic.classList.toggle("busy", busy);
  if (!busy) setHint(side, "Tap to talk, tap again to finish");
}

async function toggleMic(side: Side): Promise<void> {
  if (state.recordingSide === side) {
    stopMic();
    return;
  }
  if (state.recordingSide) stopMic();
  stopSpeaking();

  const useServer = state.health.stt === "whisper";
  if (!useServer && !RecognizerCtor) {
    toast("Voice input needs Chrome, Edge or Safari here. Typing still works.");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Microphone access was blocked");
    return;
  }

  const mic = $<HTMLButtonElement>(".mic", card(side));
  state.recordingSide = side;
  mic.classList.add("live");
  setHint(side, `Listening in ${langName(chosenLang(side))}…`);
  meter.start(stream, $<HTMLCanvasElement>(".meter", mic));

  if (useServer) startRecorder(side, stream);
  else startRecognizer(side);
}

function startRecorder(side: Side, s: MediaStream): void {
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(s);
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    if (blob.size < 1500) {
      setBusy(side, false);
      toast("That was too short to hear anything");
      return;
    }
    setBusy(side, true);
    request(side, "", await blobToBase64(blob));
  };
  recorder.start();
}

function startRecognizer(side: Side): void {
  let heard = "";
  const r = new RecognizerCtor!();
  r.lang = locale(chosenLang(side));
  r.interimResults = true;
  r.continuous = true;
  r.onresult = e => {
    let finalText = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    heard = (finalText + " " + interim).trim();
    if (heard) setHint(side, `“${heard.slice(-60)}”`);
  };
  r.onerror = e => {
    if (e.error !== "no-speech" && e.error !== "aborted") toast(`Speech input error: ${e.error}`);
  };
  r.onend = () => {
    if (state.recordingSide === side) stopMic();
    if (heard) {
      setBusy(side, true);
      request(side, heard);
    } else {
      setBusy(side, false);
    }
    heard = "";
  };
  recognizer = r;
  r.start();
}

function stopMic(): void {
  const side = state.recordingSide;
  if (!side) return;
  state.recordingSide = null;
  const mic = $<HTMLButtonElement>(".mic", card(side));
  mic.classList.remove("live");
  meter.stop($<HTMLCanvasElement>(".meter", mic));

  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  if (recognizer) {
    const r = recognizer;
    recognizer = null;
    r.stop();
  }
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
}

// ---------- wiring ----------

function fillLanguages(saved: any): void {
  for (const side of ["a", "b"] as Side[]) {
    const select = $<HTMLSelectElement>(".lang", card(side));
    for (const l of state.languages) select.appendChild(new Option(l.name, l.code));
    const fallback = side === "a" ? "en" : "es";
    const wanted = saved[side];
    select.value = state.languages.some(l => l.code === wanted) ? wanted : fallback;
    select.addEventListener("change", () => {
      fillVoices(side);
      save();
    });
  }
}

function bindSide(side: Side): void {
  const root = card(side);
  $(".mic", root).addEventListener("click", () => toggleMic(side));

  const form = $<HTMLFormElement>(".type-box", root);
  const box = $<HTMLTextAreaElement>("textarea", form);
  form.addEventListener("submit", e => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    request(side, text);
  });
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  $(".voice", root).addEventListener("change", () => {
    save();
    const lang = chosenLang(side);
    speak(SAMPLE_LINE[lang] ?? "Hello", lang);  // let them hear the voice they picked
  });
  $(".who", root).addEventListener("change", () => {
    save();
    render();
  });
}

function exportTranscript(): void {
  const done = state.lines.filter(l => l.state === "done");
  if (!done.length) {
    toast("Nothing to save yet");
    return;
  }
  const text = done.map(l => {
    const when = new Date(l.at).toLocaleString();
    return `[${when}] ${speakerName(l.side)} (${langName(l.source)})\n  ${l.original}\n  → (${langName(l.target)}) ${l.translation}\n`;
  }).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `voxbridge-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showEngines(): void {
  const h = state.health;
  $("#chip-stt").textContent = `STT: ${h.stt === "whisper" ? "Whisper" : "browser"}`;
  $("#chip-tts").textContent = `TTS: ${h.tts === "coqui" ? "Coqui" : "browser"}`;
  const mt: Record<string, string> = { "marian+nllb": "MarianMT / NLLB", marian: "MarianMT", nllb: "NLLB", online: "online" };
  $("#chip-mt").textContent = `MT: ${mt[h.translator] ?? h.translator}`;

  const canListen = h.stt === "whisper" || !!RecognizerCtor;
  for (const side of ["a", "b"] as Side[]) {
    const mic = $<HTMLButtonElement>(".mic", card(side));
    mic.disabled = !canListen || !navigator.mediaDevices;
    if (mic.disabled) setHint(side, "Voice input isn't available in this browser");
  }
  const detect = $<HTMLInputElement>("#auto-detect");
  detect.parentElement!.title = h.stt === "whisper"
    ? "Whisper works out which language is being spoken"
    : "Detection runs on the recognised text; the mic still listens in the selected language";
}

async function boot(): Promise<void> {
  const saved = load();

  state.languages = BUILTIN_LANGUAGES;
  await connectServer(false);

  fillLanguages(saved);
  if (saved.nameA) $<HTMLInputElement>(".who", card("a")).value = saved.nameA;
  if (saved.nameB) $<HTMLInputElement>(".who", card("b")).value = saved.nameB;
  if (saved.speed) $<HTMLInputElement>("#speed").value = saved.speed;
  savedVoices.a = saved.voiceA || "";
  savedVoices.b = saved.voiceB || "";
  $("#speed-out").textContent = `${speed().toFixed(2)}×`;
  state.lines = Array.isArray(saved.lines) ? saved.lines : [];

  bindSide("a");
  bindSide("b");
  showEngines();
  (["a", "b"] as Side[]).forEach(fillVoices);
  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = () => (["a", "b"] as Side[]).forEach(fillVoices);
  }

  $("#speed").addEventListener("input", () => {
    $("#speed-out").textContent = `${speed().toFixed(2)}×`;
    save();
  });
  $("#swap").addEventListener("click", () => {
    const a = $<HTMLSelectElement>(".lang", card("a"));
    const b = $<HTMLSelectElement>(".lang", card("b"));
    [a.value, b.value] = [b.value, a.value];
    const va = $<HTMLSelectElement>(".voice", card("a"));
    const vb = $<HTMLSelectElement>(".voice", card("b"));
    [savedVoices.a, savedVoices.b] = [vb.value, va.value];
    va.value = vb.value = "";
    (["a", "b"] as Side[]).forEach(fillVoices);
    save();
  });
  $("#clear").addEventListener("click", () => {
    if (state.lines.length && !confirm("Clear the whole conversation?")) return;
    state.lines = [];
    stopSpeaking();
    render();
    save();
  });
  $("#export").addEventListener("click", exportTranscript);

  bindServerDialog();
  render();
}

async function connectServer(announce: boolean): Promise<void> {
  link.close();
  const found = await findServer();
  if (found) {
    serverBase = found.base;
    player.serverBase = serverBase;
    state.health = found.health;
    try {
      const langs = await fetch(`${serverBase}/api/languages`).then(r => r.json());
      if (Array.isArray(langs) && langs.length) state.languages = langs;
    } catch { /* keep the built-in list */ }
    state.serverVoices = [];
    if (state.health.tts === "coqui") {
      state.serverVoices = (await fetch(`${serverBase}/api/voices`).then(r => r.json())
        .catch(() => ({ voices: [] }))).voices || [];
    }
    setConn(false);
    link.connect();
    if (announce) toast(`Connected to ${serverBase}`);
  } else {
    serverBase = null;
    player.serverBase = null;
    state.health = { stt: "browser", tts: "browser", translator: "online" };
    state.serverVoices = [];
    setConn("local");
    if (announce && savedServer()) toast("Couldn't reach that server, staying in browser mode", 5000);
  }
}

function bindServerDialog(): void {
  const dialog = $<HTMLDialogElement>("#server-dialog");
  const input = $<HTMLInputElement>("#server-url");
  $("#open-server").addEventListener("click", () => {
    input.value = savedServer();
    dialog.showModal();
  });
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "save") return;
    const value = input.value.trim().replace(/\/+$/, "");
    try {
      if (value) localStorage.setItem(SERVER_KEY, value);
      else localStorage.removeItem(SERVER_KEY);
    } catch { /* ignore */ }
    if (new URLSearchParams(location.search).has("server")) {
      history.replaceState(null, "", location.pathname);
    }
    await connectServer(true);
    showEngines();
    (["a", "b"] as Side[]).forEach(fillVoices);
    if (!value) toast("Running in the browser");
  });
}

boot();
