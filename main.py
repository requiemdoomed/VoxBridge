"""VoxBridge server.

Serves the page in static/ and does the heavy lifting behind it:
transcription, translation and (optionally) neural voices.

    python main.py            # then open http://localhost:8000

Author: Swayam Shakya
"""

import base64
import binascii
import logging
import os
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app import languages, speech, translator

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")
log = logging.getLogger("voxbridge")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
MAX_TEXT = 1000
MAX_AUDIO = 10 * 1024 * 1024  # 10 MB of recorded audio is plenty for one turn

app = FastAPI(title="VoxBridge", version="1.0.0")
# let the page call this server even when it's hosted elsewhere (e.g. GitHub Pages)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("VOXBRIDGE_ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class TranslateIn(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT)
    source: str = "auto"
    target: str = "en"
    alt_target: str | None = None


class SpeakIn(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT)
    lang: str = "en"
    voice: str | None = None
    speed: float = 1.0


def do_translate(text, source, target, speaker=None):
    """source='auto' asks for the language to be detected; `speaker` is the
    language the speaker picked (also where replies in the listener's own
    language get translated to)."""
    text = (text or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError("nothing to translate")
    if not languages.is_supported(target):
        raise ValueError(f"unknown target language '{target}'")
    if speaker and not languages.is_supported(speaker):
        speaker = None

    detect = source == "auto" or not languages.is_supported(source)
    if detect:
        source = speaker or ("en" if target != "en" else "es")

    started = time.perf_counter()
    result = translator.translate(text, source, target, detect=detect, speaker=speaker)
    return {
        "original": text,
        **result,
        "ms": round((time.perf_counter() - started) * 1000),
    }


# ---------- pages & REST ----------

@app.get("/", response_class=HTMLResponse)
def index():
    # the same index.html also runs on static hosting; this tag tells the
    # page that the model server is right here
    with open(os.path.join(BASE_DIR, "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    return page.replace("<head>", '<head>\n  <meta name="voxbridge-server" content="same-origin">', 1)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "stt": "whisper" if speech.HAS_WHISPER else "browser",
        "tts": "coqui" if speech.HAS_COQUI else "browser",
        "translator": translator.engine_name(),
    }


@app.get("/api/languages")
def get_languages():
    return languages.as_list()


@app.get("/api/voices")
def get_voices():
    return {"voices": speech.list_voices()}


@app.post("/api/translate")
async def translate_text(body: TranslateIn):
    try:
        return await run_in_threadpool(do_translate, body.text, body.source,
                                     body.target, body.alt_target)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except translator.TranslationError as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/speak")
async def speak(body: SpeakIn):
    if not speech.HAS_COQUI:
        raise HTTPException(501, "Coqui TTS not installed; the browser voice is used instead")
    if not body.text.strip():
        raise HTTPException(400, "nothing to say")
    try:
        wav = await run_in_threadpool(speech.synthesize, body.text, body.lang, body.voice, body.speed)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        log.exception("tts failed")
        raise HTTPException(500, f"voice synthesis failed: {exc}")
    return Response(wav, media_type="audio/wav")


# ---------- live conversation socket ----------

@app.websocket("/ws")
async def conversation(ws: WebSocket):
    await ws.accept()
    log.info("client connected")
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            ref = msg.get("ref")
            try:
                if kind == "ping":
                    await ws.send_json({"type": "pong"})
                    continue

                if kind == "audio":
                    try:
                        audio = base64.b64decode(msg.get("data", ""), validate=True)
                    except (binascii.Error, ValueError):
                        raise ValueError("audio payload is not valid base64")
                    if len(audio) > MAX_AUDIO:
                        raise ValueError("recording is too long")
                    await ws.send_json({"type": "status", "ref": ref, "stage": "transcribing"})
                    text, detected = await run_in_threadpool(
                        speech.transcribe, audio, msg.get("source")
                    )
                    if not text:
                        raise ValueError("couldn't hear any speech, try again")
                    await ws.send_json({"type": "transcript", "ref": ref,
                                        "text": text, "source": detected})
                    source = detected
                elif kind == "text":
                    text = msg.get("text", "")
                    source = msg.get("source", "auto")
                else:
                    raise ValueError(f"unknown message type '{kind}'")

                await ws.send_json({"type": "status", "ref": ref, "stage": "translating"})
                result = await run_in_threadpool(do_translate, text, source,
                                            msg.get("target", "en"), msg.get("alt_target"))
                await ws.send_json({"type": "result", "ref": ref, **result})

            except (ValueError, RuntimeError, translator.TranslationError) as exc:
                await ws.send_json({"type": "error", "ref": ref, "message": str(exc)})
    except WebSocketDisconnect:
        log.info("client left")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    print(f"\n  VoxBridge is running ->  http://localhost:{port}\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
