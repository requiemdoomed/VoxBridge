// VoxBridge: text-to-speech.
// Author: Swayam Shakya
//
// Three kinds of voice, offered per language:
//   online   natural voices streamed from Google's speech endpoint; covers
//            every language VoxBridge supports, with regional accents
//   device   voices installed in the browser / operating system
//   server   Coqui TTS speakers, when main.py runs with Coqui installed
//
// "Auto" picks the best one that actually speaks the language, and if a
// voice fails to play the next one is tried, so a line is never silent.

interface VoiceOption {
  id: string;        // "auto" | "online:<tl>:<host>" | "device:<voiceURI>" | "server:<speaker>"
  label: string;
  group: "Natural (online)" | "On this device" | "Server (Coqui)" | "";
}

// [label, language code for the service, Google host that gives the accent]
const ONLINE_VOICES: Record<string, [string, string, string][]> = {
  en: [["US English", "en", "com"], ["British English", "en", "co.uk"], ["Australian English", "en", "com.au"],
       ["Indian English", "en", "co.in"], ["Canadian English", "en", "ca"]],
  es: [["Spain", "es", "es"], ["Mexico", "es", "com.mx"], ["United States", "es", "us"]],
  fr: [["France", "fr", "fr"], ["Canada", "fr", "ca"]],
  pt: [["Portugal", "pt", "pt"], ["Brazil", "pt", "com.br"]],
  zh: [["Mandarin (Mainland)", "zh-CN", "com"], ["Mandarin (Taiwan)", "zh-TW", "com"]],
  de: [["Standard", "de", "de"]],
  it: [["Standard", "it", "it"]],
  nl: [["Standard", "nl", "nl"]],
  ru: [["Standard", "ru", "ru"]],
  uk: [["Standard", "uk", "com.ua"]],
  pl: [["Standard", "pl", "pl"]],
  tr: [["Standard", "tr", "com.tr"]],
  ar: [["Standard", "ar", "com"]],
  hi: [["Standard", "hi", "co.in"]],
  ne: [["Standard", "ne", "com"]],
  bn: [["Standard", "bn", "com"]],
  ja: [["Standard", "ja", "co.jp"]],
  ko: [["Standard", "ko", "co.kr"]],
  vi: [["Standard", "vi", "com.vn"]],
  id: [["Standard", "id", "co.id"]],
};

// Languages the default Coqui model (XTTS v2) can speak
const COQUI_LANGS = new Set(["en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl", "ar", "zh", "ja", "ko", "hi"]);

function deviceVoices(lang: string): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices().filter(v => {
    const code = v.lang.toLowerCase().replace("_", "-").split("-")[0];
    // some systems label Filipino/Hebrew etc. oddly; only an exact match counts
    return code === lang || (lang === "id" && code === "in");
  });
}

// Neural/cloud voices sound far better than the old compact ones
function voiceQuality(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let score = 0;
  if (/natural|neural|online|premium|enhanced/.test(n)) score += 3;
  if (n.startsWith("google")) score += 2;
  if (!v.localService) score += 1;
  if (v.default) score += 0.5;
  return score;
}

function voiceOptions(lang: string, serverVoices: string[], serverHasCoqui: boolean): VoiceOption[] {
  const options: VoiceOption[] = [{ id: "auto", label: "Auto (best available)", group: "" }];
  for (const [label, tl, host] of ONLINE_VOICES[lang] || []) {
    options.push({ id: `online:${tl}:${host}`, label, group: "Natural (online)" });
  }
  for (const v of deviceVoices(lang).sort((a, b) => voiceQuality(b) - voiceQuality(a))) {
    options.push({ id: `device:${v.voiceURI}`, label: v.name, group: "On this device" });
  }
  if (serverHasCoqui && COQUI_LANGS.has(lang)) {
    for (const s of serverVoices) options.push({ id: `server:${s}`, label: s, group: "Server (Coqui)" });
  }
  return options;
}

/** The voices to try, best first, for the chosen option. */
function voicePlan(choice: string, lang: string, serverHasCoqui: boolean): string[] {
  const onlineDefault = (ONLINE_VOICES[lang] || [])[0];
  const online = onlineDefault ? `online:${onlineDefault[1]}:${onlineDefault[2]}` : null;
  const devices = deviceVoices(lang).sort((a, b) => voiceQuality(b) - voiceQuality(a));
  const bestDevice = devices.length ? `device:${devices[0].voiceURI}` : null;
  const server = serverHasCoqui && COQUI_LANGS.has(lang) ? "server:" : null;

  let plan: (string | null)[];
  if (choice === "auto" || !choice) {
    // a good neural device voice is instant and works offline; otherwise online
    const deviceIsGood = devices.length > 0 && voiceQuality(devices[0]) >= 3;
    plan = deviceIsGood ? [bestDevice, server, online] : [server, online, bestDevice];
  } else {
    plan = [choice, online, bestDevice];
  }
  return [...new Set(plan.filter((p): p is string => !!p))];
}

class VoicePlayer {
  private audio: HTMLAudioElement | null = null;
  private token = 0;
  serverBase: string | null = null;

  stop(): void {
    this.token++;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  /** Speak `text`; resolves with the voice id that was used. */
  async speak(text: string, lang: string, choice: string, rate: number, serverHasCoqui: boolean): Promise<string> {
    this.stop();
    const token = this.token;
    const plan = voicePlan(choice, lang, serverHasCoqui && !!this.serverBase);
    let lastError: unknown = new Error("No voice available for this language");

    for (const voice of plan) {
      if (token !== this.token) return voice;  // stopped or replaced meanwhile
      try {
        if (voice.startsWith("online:")) {
          const [, tl, host] = voice.split(":");
          await this.playOnline(text, tl, host, rate, token);
        } else if (voice.startsWith("device:")) {
          await this.playDevice(text, lang, voice.slice(7), rate, token);
        } else {
          await this.playServer(text, lang, voice.slice(7), rate, token);
        }
        return voice;
      } catch (err) {
        if (token !== this.token) return voice;
        lastError = err;
        console.warn(`voice ${voice} failed, trying the next one`, err);
      }
    }
    throw lastError;
  }

  // Google's endpoint takes about 200 characters per request
  private async playOnline(text: string, tl: string, host: string, rate: number, token: number): Promise<void> {
    const chunks = splitText(text, 180);
    for (let i = 0; i < chunks.length; i++) {
      if (token !== this.token) return;
      const params = new URLSearchParams({
        ie: "UTF-8", client: "tw-ob", tl, q: chunks[i],
        total: String(chunks.length), idx: String(i), textlen: String(chunks[i].length),
      });
      await this.playUrl(`https://translate.google.${host}/translate_tts?${params}`, rate, token);
    }
  }

  private playUrl(url: string, rate: number, token: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      this.audio = audio;
      audio.preload = "auto";
      (audio as any).preservesPitch = true;
      // loading a source resets playbackRate to defaultPlaybackRate, so set both
      const applyRate = () => {
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;
      };
      audio.onloadedmetadata = applyRate;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("audio could not be loaded"));
      // stopping clears src, which must not count as a failure
      audio.onabort = () => (token !== this.token ? resolve() : undefined);
      audio.src = url;
      applyRate();
      audio.play().then(applyRate).catch(err => {
        if (token !== this.token) resolve();
        else reject(err);
      });
    });
  }

  private playDevice(text: string, lang: string, uri: string, rate: number, token: number): Promise<void> {
    const voice = speechSynthesis.getVoices().find(v => v.voiceURI === uri);
    if (!voice) return Promise.reject(new Error("device voice not found"));
    // long utterances get cut off in Chrome, so speak sentence by sentence
    const chunks = splitText(text, 200);
    return new Promise((resolve, reject) => {
      let index = 0;
      const next = () => {
        if (token !== this.token || index >= chunks.length) return resolve();
        const u = new SpeechSynthesisUtterance(chunks[index++]);
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = rate;
        u.onend = next;
        u.onerror = e => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new Error(e.error)));
        speechSynthesis.speak(u);
      };
      next();
    });
  }

  private async playServer(text: string, lang: string, speaker: string, rate: number, token: number): Promise<void> {
    if (!this.serverBase) throw new Error("no server");
    const r = await fetch(`${this.serverBase}/api/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang, voice: speaker || null, speed: rate }),
    });
    if (!r.ok) throw new Error(`server voice: HTTP ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    try {
      await this.playUrl(url, 1, token);  // speed was applied by the server
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
