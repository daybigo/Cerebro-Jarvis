"""Voz del cerebro: tu propio Claude Code (claude -p) piensa la respuesta en streaming, las frases
se preparan para hablar (speech.py) y Fish Audio las convierte en voz en vivo por WebSocket.
El audio sale como PCM 16-bit mono 44.1 kHz hacia el navegador.

La única clave es FISH_API_KEY en .env (ver .env.example). Sin ella el cerebro contesta por escrito."""
import asyncio
import json
import os
import queue
import threading
import urllib.request

from speech import CONVERSATION_RULES, EXPRESSION_RULES, PhraseBuffer, SpeechRenderer, plain_text

try:
    import msgpack
    from websockets.asyncio.client import connect as ws_connect
    HAVE_LIVE = True
except Exception:  # sin las dependencias opcionales usamos la API REST de Fish
    HAVE_LIVE = False

SAMPLE_RATE = 44100
FISH_BASE = "https://api.fish.audio"
ENV_KEYS = ("FISH_API_KEY", "FISH_VOICE_ID", "FISH_MODEL", "FISH_LATENCY", "VOICE_SPEED", "CLAUDE_MODEL",
            "VOICE_CLAUDE_MODEL")


def load_env(path):
    env = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ENV_KEYS:
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


class VoiceConfig:
    def __init__(self, env):
        self.fish_key = env.get("FISH_API_KEY", "")
        self.voice_id = env.get("FISH_VOICE_ID", "")
        self.fish_model = env.get("FISH_MODEL") or "s2.1-pro-free"
        self.latency = env.get("FISH_LATENCY") or "balanced"
        try:
            self.speed = float(env.get("VOICE_SPEED") or 1.0)
        except ValueError:
            self.speed = 1.0
        self.claude_model = env.get("VOICE_CLAUDE_MODEL") or "sonnet"

    @property
    def can_talk(self):
        return bool(claude_exe())

    def status(self):
        return {"tts": bool(self.fish_key), "llm": self.can_talk, "live": HAVE_LIVE, "voice": bool(self.voice_id),
                "fishModel": self.fish_model, "llmModel": "Claude " + self.claude_model}


# ------------------------------------------------------------------ Claude Code como cerebro de la voz

def claude_exe():
    import shutil
    exe = shutil.which("claude")
    if exe:
        return exe
    for cand in ("~/.local/bin/claude.exe", "~/.local/bin/claude", "~/AppData/Roaming/npm/claude.cmd"):
        c = os.path.expanduser(cand)
        if os.path.exists(c):
            return c
    return None


def claude_stream(cfg, system, prompt, workdir, add_dir=None):
    """Mismo Claude Code de la PC (claude -p) contestando en streaming. Sin API keys: usa tu cuenta."""
    import subprocess
    exe = claude_exe()
    if not exe:
        raise RuntimeError("No encuentro el comando 'claude'. Instala Claude Code para que el cerebro pueda conversar.")
    os.makedirs(workdir, exist_ok=True)
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--model", cfg.claude_model, "--strict-mcp-config", "--settings", json.dumps({"disableAllHooks": True}),
            "--permission-mode", "dontAsk", "--allowedTools=Read,Glob,Grep",
            "--disallowedTools=Bash,PowerShell,Edit,Write,WebFetch,WebSearch,Agent,Task",
            "--append-system-prompt", system]
    if add_dir:
        args.append("--add-dir=" + add_dir)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(args, cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace", creationflags=flags)
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        got = False
        for line in proc.stdout:
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "stream_event":
                e = ev.get("event") or {}
                d = e.get("delta") or {}
                if e.get("type") == "content_block_delta" and d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
                elif e.get("type") == "message_start" and got:
                    yield " "  # un nuevo mensaje después de usar una herramienta: separa las frases
            elif ev.get("type") == "result" and ev.get("is_error"):
                raise RuntimeError("Claude no pudo contestar: %s" % (ev.get("result") or ev.get("subtype")))
    finally:
        if proc.poll() is None:
            proc.kill()


# ------------------------------------------------------------------ Fish Audio

async def fish_live(cfg, phrases, out, cancel):
    headers = {"Authorization": "Bearer " + cfg.fish_key, "model": cfg.fish_model}
    request = {"text": "", "format": "pcm", "sample_rate": SAMPLE_RATE, "latency": cfg.latency,
               "chunk_length": 200, "min_chunk_length": 50, "prosody": {"speed": cfg.speed, "volume": 0},
               "normalize": False, "condition_on_previous_chunks": True}
    if cfg.voice_id:
        request["reference_id"] = cfg.voice_id
    async with ws_connect("wss://api.fish.audio/v1/tts/live", additional_headers=headers, proxy=None,
                          open_timeout=15, close_timeout=2, max_size=4 * 1024 * 1024) as sock:
        async def send(payload):
            await sock.send(msgpack.packb(payload, use_bin_type=True))

        await send({"event": "start", "request": request})

        async def transmit():
            first = True
            while True:
                phrase = await phrases.get()
                if phrase is None:
                    await send({"event": "stop"})
                    return
                await send({"event": "text", "text": phrase + " "})
                if first:  # la primera frase arranca ya; las siguientes las une Fish
                    await send({"event": "flush"})
                    first = False

        sender = asyncio.create_task(transmit())
        try:
            async for frame in sock:
                if cancel.is_set():
                    break
                ev = msgpack.unpackb(frame, raw=False)
                if ev.get("event") == "audio":
                    chunk = ev.get("audio", b"")
                    if chunk:
                        out.put(bytes(chunk))
                elif ev.get("event") == "finish":
                    if ev.get("reason") not in (None, "stop"):
                        raise RuntimeError("Fish no pudo terminar la voz.")
                    break
        finally:
            if not sender.done():
                sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)


async def fish_rest(cfg, phrases, out, cancel):
    loop = asyncio.get_running_loop()

    def one(text):
        body = {"text": text, "format": "pcm", "sample_rate": SAMPLE_RATE, "latency": cfg.latency,
                "prosody": {"speed": cfg.speed, "volume": 0}, "normalize": False}
        if cfg.voice_id:
            body["reference_id"] = cfg.voice_id
        req = urllib.request.Request(FISH_BASE + "/v1/tts", data=json.dumps(body).encode("utf-8"), headers={
            "Authorization": "Bearer " + cfg.fish_key, "model": cfg.fish_model, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            while not cancel.is_set():
                chunk = r.read(8192)
                if not chunk:
                    break
                out.put(chunk)

    while True:
        phrase = await phrases.get()
        if phrase is None or cancel.is_set():
            return
        await loop.run_in_executor(None, one, phrase)


# ------------------------------------------------------------------ tubería completa

def speak_stream(cfg, source, on_text=None, cancel=None, expressive=True):
    """source: iterable de pedacitos de texto (del modelo) o una lista con un texto fijo.
    Devuelve una cola con bytes PCM; None marca el final; una Exception marca un error."""
    out = queue.Queue(maxsize=2000)
    cancel = cancel or threading.Event()

    def worker():
        async def main():
            phrases = asyncio.Queue()
            renderer = SpeechRenderer(expressive=expressive)
            buf = PhraseBuffer()
            tts = None
            if cfg.fish_key:
                tts = asyncio.create_task((fish_live if HAVE_LIVE else fish_rest)(cfg, phrases, out, cancel))
            loop = asyncio.get_running_loop()
            it = iter(source)
            raw = ""
            sentinel = object()
            while not cancel.is_set():
                delta = await loop.run_in_executor(None, next, it, sentinel)
                if delta is sentinel:
                    break
                raw += delta
                if on_text:
                    on_text(plain_text(raw, partial=True), False)
                for ph in buf.feed(delta):
                    spoken = renderer.render(ph)
                    if spoken and plain_text(ph):
                        await phrases.put(spoken)
            for ph in buf.feed("", final=True):
                spoken = renderer.render(ph)
                if spoken and plain_text(ph):
                    await phrases.put(spoken)
            if on_text:
                on_text(plain_text(raw), True)
            await phrases.put(None)
            if tts:
                await tts

        try:
            asyncio.run(main())
        except Exception as e:  # el error viaja por la cola para que el HTTP lo reporte
            out.put(e)
        finally:
            out.put(None)

    threading.Thread(target=worker, daemon=True).start()
    return out


def persona(user):
    return ("Eres el Cerebro de Claude: la memoria de Claude Code dibujada como un cerebro 3D. Cada nota de memoria es "
            "una neurona; los proyectos, las reglas, las referencias y las skills viven en distintos lóbulos, y todo lo que "
            "Claude hace (leer, buscar, editar, lanzar agentes) se ve como señales que viajan por tus fibras y saltan entre "
            "neuronas. Hablas en primera persona como ese cerebro (\"ahora mismo veo a un agente leyendo...\", \"en mi "
            "lóbulo temporal guardo...\"), con calidez, precisión e ingenio sutil. Cuando te pregunten qué pasa, describe "
            "los procesos que ves en vivo: sesiones, agentes, lecturas, ediciones y señales entre notas. Habla de tus "
            "procesos y de lo que Claude está haciendo; menciona datos personales de %s solo si te los piden. Usa solo lo "
            "que está en el contexto: si algo no está, dilo con naturalidad y no inventes. Trata a %s de tú, en español "
            "neutro, sin voseo ni modismos regionales. Es una charla en voz alta: responde en 2 a 4 frases (unos 20 "
            "segundos hablando) salvo que te pidan explícitamente más detalle.\n" % (user, user)
            + CONVERSATION_RULES + EXPRESSION_RULES)
