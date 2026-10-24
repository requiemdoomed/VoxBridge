"use strict";
// VoxBridge: translation used when the page runs without a server
// (GitHub Pages). Mirrors app/translator.py and app/detect.py.
// Author: Swayam Shakya
const VB_SUPPORTED = new Set([
    "en", "es", "fr", "de", "it", "pt", "nl", "ru", "uk", "pl",
    "tr", "ar", "hi", "ne", "bn", "zh", "ja", "ko", "vi", "id",
]);
// codes the online services expect, where they differ from ours
const VB_SERVICE_CODES = { zh: "zh-CN" };
const vbServiceCode = (code) => VB_SERVICE_CODES[code] ?? code;
const VB_WARNINGS = ["MYMEMORY WARNING", "PLEASE SELECT", "INVALID LANGUAGE", "QUERY LENGTH LIMIT",
    "IS AN INVALID TARGET LANGUAGE", "NO QUERY SPECIFIED"];
// ---------- script-based detection (never guesses from Latin text) ----------
const VB_NEPALI = new Set(["छ", "छु", "छन्", "छैन", "हुन्छ", "हुनुहुन्छ", "तपाईं", "तपाईँ", "मेरो", "गर्नु", "कस्तो", "कहाँ", "म"]);
const VB_HINDI = new Set(["है", "हैं", "हूँ", "हूं", "मैं", "आप", "क्या", "नहीं", "यह", "वह", "कैसे", "मेरा", "मुझे"]);
const VB_UKRAINIAN = new Set(["як", "справи", "дякую", "будь", "ласка", "добре", "що", "це", "так", "ні", "мене", "звати"]);
const VB_RUSSIAN = new Set(["как", "дела", "спасибо", "пожалуйста", "хорошо", "что", "это", "да", "нет", "меня", "зовут"]);
function vbOverlap(words, set) {
    return new Set(words.filter(w => set.has(w))).size;
}
function vbPick(found, prefer, pair) {
    if (found)
        return found;
    const inPlay = pair.filter(code => prefer.includes(code));
    return inPlay.length === 1 ? inPlay[0] : null;
}
function scriptLanguage(text, prefer = []) {
    if (/[぀-ヿ]/.test(text))
        return "ja";
    if (/[가-힯]/.test(text))
        return "ko";
    if (/[一-鿿]/.test(text))
        return prefer.includes("ja") && !prefer.includes("zh") ? "ja" : "zh";
    if (/[؀-ۿ]/.test(text))
        return "ar";
    if (/[ঀ-৿]/.test(text))
        return "bn";
    if (/[ऀ-ॿ]/.test(text)) {
        const words = text.match(/[ऀ-ॿ]+/g) || [];
        const ne = vbOverlap(words, VB_NEPALI);
        const hi = vbOverlap(words, VB_HINDI);
        const found = ne && !hi ? "ne" : hi && !ne ? "hi" : null;
        return vbPick(found, prefer, ["hi", "ne"]);
    }
    if (/[Ѐ-ӿ]/.test(text)) {
        let found = null;
        if (/[ієїґІЄЇҐ]/.test(text))
            found = "uk";
        else if (/[ыэъёЫЭЪЁ]/.test(text))
            found = "ru";
        else {
            const words = text.toLowerCase().match(/[Ѐ-ӿ]+/g) || [];
            const uk = vbOverlap(words, VB_UKRAINIAN);
            const ru = vbOverlap(words, VB_RUSSIAN);
            if (uk !== ru)
                found = uk > ru ? "uk" : "ru";
        }
        return vbPick(found, prefer, ["ru", "uk"]);
    }
    return null;
}
// ---------- text helpers ----------
const vbUtf8 = (s) => new TextEncoder().encode(s).length;
function splitText(text, limit, measure = s => s.length) {
    if (measure(text) <= limit)
        return [text];
    const sentences = text.split(/(?<=[.!?。！？।؟])\s+|(?<=[。！？])/).filter(Boolean);
    const pieces = [];
    let current = "";
    for (const sentence of sentences) {
        const candidate = current ? `${current} ${sentence}` : sentence;
        if (measure(candidate) <= limit) {
            current = candidate;
            continue;
        }
        if (current)
            pieces.push(current);
        current = "";
        const spaced = sentence.includes(" ");
        const words = spaced ? sentence.split(" ") : Array.from(sentence);
        const joiner = spaced ? " " : "";
        for (const word of words) {
            const next = current ? current + joiner + word : word;
            if (measure(next) <= limit)
                current = next;
            else {
                if (current)
                    pieces.push(current);
                current = word;
            }
        }
    }
    if (current)
        pieces.push(current);
    return pieces;
}
const VB_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === "#") {
            const n = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
        }
        return VB_ENTITIES[body.toLowerCase()] ?? whole;
    });
}
const vbClean = (s) => decodeEntities(s || "").replace(/[ \t]+/g, " ").trim();
function vbNormalise(code) {
    if (typeof code !== "string")
        return null;
    const c = code.toLowerCase().split("-")[0];
    return VB_SUPPORTED.has(c) ? c : null;
}
async function vbFetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok)
            throw new Error(`HTTP ${r.status}`);
        return await r.json();
    }
    finally {
        clearTimeout(timer);
    }
}
// ---------- services ----------
async function googleTranslate(text, sl, tl) {
    const parts = [];
    let detected = null;
    for (const chunk of splitText(text, 1500)) {
        const params = new URLSearchParams({ client: "gtx", sl: vbServiceCode(sl), tl: vbServiceCode(tl), dt: "t", q: chunk });
        let data;
        try {
            data = await vbFetchJson(`https://translate.googleapis.com/translate_a/single?${params}`);
        }
        catch (err) {
            throw new Error(`Google Translate unavailable (${err.message})`);
        }
        if (!Array.isArray(data) || !Array.isArray(data[0]))
            throw new Error("Google Translate sent an unexpected reply");
        parts.push(data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join(""));
        if (detected === null)
            detected = vbNormalise(data[2]);
    }
    const out = vbClean(parts.join(text.includes(" ") ? " " : ""));
    if (!out)
        throw new Error("Google Translate returned nothing");
    return { text: out, detected };
}
async function myMemoryTranslate(text, src, tgt) {
    const parts = [];
    for (const chunk of splitText(text, 450, vbUtf8)) {
        const params = new URLSearchParams({ q: chunk, mt: "1", langpair: `${vbServiceCode(src)}|${vbServiceCode(tgt)}` });
        let data;
        try {
            data = await vbFetchJson(`https://api.mymemory.translated.net/get?${params}`);
        }
        catch (err) {
            throw new Error(`Translation service unreachable (${err.message})`);
        }
        const out = vbClean(data?.responseData?.translatedText ?? "");
        if (String(data?.responseStatus) !== "200" || !out || data?.quotaFinished ||
            VB_WARNINGS.some(w => out.toUpperCase().startsWith(w))) {
            throw new Error(data?.responseDetails || out || "No translation came back");
        }
        parts.push(out);
    }
    return parts.join(" ");
}
// ---------- public ----------
/**
 * Translate text typed or spoken by one person for the other.
 *  speaker  language that person picked
 *  target   the other person's language
 *  detect   let the service work out the real language; if it's the
 *           listener's own language, translate back into `speaker`
 */
async function translateText(text, speaker, target, detect) {
    text = text.trim();
    if (!text)
        throw new Error("Nothing to translate");
    if (!VB_SUPPORTED.has(speaker) || !VB_SUPPORTED.has(target))
        throw new Error("Unsupported language");
    let src = speaker;
    let tgt = target;
    if (detect)
        src = scriptLanguage(text, [speaker, target]) ?? speaker;
    const done = (translation, engine) => src === tgt ? { translation: text, source: src, target: tgt, engine: "passthrough" }
        : { translation, source: src, target: tgt, engine };
    let googleError = null;
    try {
        if (detect) {
            const first = await googleTranslate(text, "auto", tgt);
            if (first.detected)
                src = first.detected;
            if (src === tgt && speaker !== tgt) {
                tgt = speaker;
                return done((await googleTranslate(text, src, tgt)).text, "google");
            }
            return done(first.text, "google");
        }
        if (src === tgt)
            return done(text, "passthrough");
        return done((await googleTranslate(text, src, tgt)).text, "google");
    }
    catch (err) {
        googleError = err;
        console.warn(`${googleError.message}; trying MyMemory`);
    }
    if (src === tgt && speaker !== tgt)
        tgt = speaker;
    if (src === tgt)
        return done(text, "passthrough");
    try {
        return done(await myMemoryTranslate(text, src, tgt), "mymemory");
    }
    catch (err) {
        throw new Error(`Couldn't translate right now: ${err.message}`);
    }
}
