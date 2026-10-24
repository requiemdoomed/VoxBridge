// Tests for static/voices.js: every language must always have a voice.
//   node --test tests/voices.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const LANGS = Object.keys(JSON.parse(readFileSync(new URL("tests/greetings.json", root), "utf8")));

function load(deviceVoices = []) {
  const window = { speechSynthesis: { getVoices: () => deviceVoices } };
  const ctx = vm.createContext({ window, speechSynthesis: window.speechSynthesis, URLSearchParams, TextEncoder, console });
  vm.runInContext(readFileSync(new URL("static/translate.js", root), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("static/voices.js", root), "utf8"), ctx);
  return ctx;
}

test("every language has at least one natural online voice", () => {
  const ctx = load();
  for (const lang of LANGS) {
    const online = ctx.voiceOptions(lang, [], false).filter(o => o.id.startsWith("online:"));
    assert.ok(online.length >= 1, `${lang} has no voice`);
  }
});

test("Auto always ends up with a voice that speaks the language", () => {
  const ctx = load();
  for (const lang of LANGS) {
    const plan = ctx.voicePlan("auto", lang, false);
    assert.ok(plan.length >= 1, lang);
    const tl = plan[0].split(":")[1];
    assert.equal(tl.split("-")[0], lang, `${lang} would be read by ${plan[0]}`);
  }
});

test("Nepali, Bengali, Ukrainian, Vietnamese and Indonesian are never sent to Coqui", () => {
  const ctx = load();
  for (const lang of ["ne", "bn", "uk", "vi", "id"]) {
    assert.ok(!ctx.voicePlan("auto", lang, true).some(v => v.startsWith("server:")), lang);
    assert.ok(!ctx.voiceOptions(lang, ["Ana"], true).some(o => o.id.startsWith("server:")), lang);
  }
  assert.ok(ctx.voiceOptions("en", ["Ana"], true).some(o => o.id === "server:Ana"));
});

test("regional accents are offered", () => {
  const ctx = load();
  const labels = lang => ctx.voiceOptions(lang, [], false).map(o => o.label);
  assert.ok(labels("en").includes("British English") && labels("en").includes("Indian English"));
  assert.ok(labels("es").includes("Mexico"));
  assert.ok(labels("pt").includes("Brazil"));
  assert.ok(labels("fr").includes("Canada"));
  assert.ok(labels("zh").includes("Mandarin (Taiwan)"));
});

test("installed voices are listed only for their own language, best first", () => {
  const ctx = load([
    { name: "Compact Voice", lang: "en-US", voiceURI: "c", localService: true, default: false },
    { name: "Jenny Online (Natural)", lang: "en-GB", voiceURI: "n", localService: false, default: false },
    { name: "Hindi Voice", lang: "hi_IN", voiceURI: "h", localService: true, default: false },
  ]);
  const en = ctx.voiceOptions("en", [], false).filter(o => o.id.startsWith("device:"));
  assert.deepEqual(Array.from(en, o => o.id), ["device:n", "device:c"]);
  assert.equal(ctx.voiceOptions("ne", [], false).filter(o => o.id.startsWith("device:")).length, 0);
  assert.equal(ctx.voiceOptions("hi", [], false).filter(o => o.id.startsWith("device:")).length, 1);
  assert.equal(ctx.voicePlan("auto", "en", false)[0], "device:n");      // natural voice first
  assert.equal(ctx.voicePlan("auto", "hi", false)[0], "online:hi:co.in"); // compact voice loses to online
});

test("a chosen voice still has backups", () => {
  const ctx = load();
  const plan = ctx.voicePlan("online:en:co.uk", "en", false);
  assert.equal(plan[0], "online:en:co.uk");
  assert.ok(plan.length >= 2);
});
