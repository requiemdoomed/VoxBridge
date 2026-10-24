// Tests for static/translate.js, the translator the browser uses.
// The online services are faked with the same request/reply format.
//   node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const GREETING = JSON.parse(readFileSync(new URL("tests/greetings.json", root), "utf8"));
const LANGS = Object.keys(GREETING);
const FROM_SERVICE = { "zh-CN": "zh" };
const langOf = q => LANGS.find(code => GREETING[code] === q) ?? null;

function load({ googleOk = true, myMemoryReply = null } = {}) {
  const calls = [];
  const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
  const fetch = async url => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    calls.push({ host: u.host, p });
    if (u.host === "translate.googleapis.com") {
      if (!googleOk) throw new TypeError("Failed to fetch");
      const tl = FROM_SERVICE[p.tl] ?? p.tl;
      const detected = langOf(p.q) ?? "en";
      if (p.sl !== "auto") assert.equal(FROM_SERVICE[p.sl] ?? p.sl, detected, `wrong source ${p.sl}`);
      const out = langOf(p.q) ? GREETING[tl] : `[${tl}]${p.q}`;
      const half = Math.floor(out.length / 2);
      return reply([[[out.slice(0, half), "a"], [out.slice(half), "b"]], null, detected === "zh" ? "zh-CN" : detected]);
    }
    if (myMemoryReply) return reply(myMemoryReply);
    assert.ok(new TextEncoder().encode(p.q).length <= 450, "MyMemory byte limit");
    const tgt = FROM_SERVICE[p.langpair.split("|")[1]] ?? p.langpair.split("|")[1];
    return reply({ responseStatus: 200, responseData: { translatedText: langOf(p.q) ? GREETING[tgt] : `[${tgt}]${p.q}` } });
  };
  const ctx = vm.createContext({ fetch, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, log: console.log } });
  vm.runInContext(readFileSync(new URL("static/translate.js", root), "utf8"), ctx);
  return { ctx, calls };
}

test("every one of the 380 language pairs (Google)", async () => {
  const { ctx } = load();
  for (const src of LANGS) for (const tgt of LANGS) {
    if (src === tgt) continue;
    const r = await ctx.translateText(GREETING[src], src, tgt, false);
    assert.equal(r.translation, GREETING[tgt], `${src}->${tgt}`);
    assert.deepEqual([r.source, r.target, r.engine], [src, tgt, "google"]);
  }
});

test("every pair through the MyMemory fallback", async () => {
  const { ctx } = load({ googleOk: false });
  for (const src of LANGS) for (const tgt of LANGS) {
    if (src === tgt) continue;
    const r = await ctx.translateText(GREETING[src], src, tgt, false);
    assert.equal(r.translation, GREETING[tgt], `${src}->${tgt}`);
    assert.equal(r.engine, "mymemory");
  }
});

test("detects any language, whichever side it was typed on", async () => {
  const { ctx } = load();
  for (const actual of LANGS) {
    const tgt = actual === "ja" ? "ko" : "ja";
    const r = await ctx.translateText(GREETING[actual], "en", tgt, true);
    assert.equal(r.source, actual);
    assert.equal(r.translation, GREETING[tgt]);
  }
});

test("a reply in the listener's language goes back to the speaker", async () => {
  const { ctx } = load();
  const r = await ctx.translateText(GREETING.es, "en", "es", true);
  assert.deepEqual([r.source, r.target, r.translation], ["es", "en", GREETING.en]);
});

test("fallback still flips direction for unmistakable scripts", async () => {
  const { ctx } = load({ googleOk: false });
  const r = await ctx.translateText(GREETING.ja, "en", "ja", true);
  assert.deepEqual([r.source, r.target, r.translation], ["ja", "en", GREETING.en]);
});

test("Chinese is sent as zh-CN", async () => {
  const { ctx, calls } = load();
  await ctx.translateText(GREETING.en, "en", "zh", false);
  assert.equal(calls.at(-1).p.tl, "zh-CN");
});

test("long text is split, never cut", async () => {
  const { ctx, calls } = load();
  const text = Array.from({ length: 150 }, (_, i) => `This is sentence number ${i}.`).join(" ");
  const r = await ctx.translateText(text, "en", "de", false);
  assert.ok(calls.length > 1);
  assert.equal(calls.map(c => c.p.q).join(" "), text);
  assert.ok(r.translation.endsWith("sentence number 149."));
});

test("text without spaces splits safely", () => {
  const { ctx } = load();
  const pieces = ctx.splitText("字".repeat(1000), 300);
  assert.equal(pieces.join(""), "字".repeat(1000));
  assert.ok(pieces.every(p => p.length <= 300));
});

test("HTML entities are decoded", async () => {
  const { ctx } = load({ googleOk: false, myMemoryReply:
    { responseStatus: 200, responseData: { translatedText: "I&#39;m &quot;fine&quot; &amp; you&#x3F;" } } });
  assert.equal((await ctx.translateText("x", "en", "es", false)).translation, `I'm "fine" & you?`);
});

test("a quota warning is reported, not shown as a translation", async () => {
  const { ctx } = load({ googleOk: false, myMemoryReply: { responseStatus: 200, quotaFinished: true,
    responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY." } } });
  await assert.rejects(ctx.translateText("hello", "en", "es", false), /Couldn't translate/);
});

test("script detection matches the Python version", () => {
  const { ctx } = load();
  const cases = [
    ["こんにちは", [], "ja"], ["東京", ["ja", "en"], "ja"], ["你好", ["en", "es"], "zh"],
    ["안녕하세요", [], "ko"], ["مرحبا", [], "ar"], ["নমস্কার", [], "bn"],
    ["तपाईं कस्तो हुनुहुन्छ", ["en", "hi"], "ne"], ["आप कैसे हैं", ["en", "ne"], "hi"],
    ["नमस्ते", ["en", "hi"], "hi"], ["नमस्ते", ["en", "es"], null],
    ["Як справи? Дякую", [], "uk"], ["Где вы живёте?", [], "ru"], ["Привет", ["uk", "en"], "uk"],
    ["Как дела? Спасибо", [], "ru"], ["Доброго ранку, як справи?", ["en", "ru"], "uk"], ["Hello there", ["en", "es"], null],
  ];
  for (const [text, prefer, want] of cases) assert.equal(ctx.scriptLanguage(text, prefer), want, text);
});

test("same language on both sides is passed through", async () => {
  const { ctx } = load();
  const r = await ctx.translateText("hello", "en", "en", false);
  assert.deepEqual([r.translation, r.engine], ["hello", "passthrough"]);
});
