"""Servidor local del Cerebro de Claude.

- Sirve la página (web/) y el grafo (/api/graph).
- Lee en vivo los transcripts de Claude Code (~/.claude/projects/**.jsonl) y manda
  cada acción (lee, edita, busca, lanza agentes...) al navegador por SSE (/api/events).
- Vigila las notas: si Claude escribe o cambia una memoria, el cerebro se rearma solo.

Solo escucha en 127.0.0.1: nada sale de la PC.
"""
import collections
import glob
import json
import os
import queue
import random
import re
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import claude_jobs
import scanner
import voice

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CFG = scanner.load_config()
CACHE = CFG["cache_dir"]
PROJECTS = os.path.join(CFG["claude_dir"], "projects")
ENV_PATH = os.environ.get("CEREBRO_ENV") or os.path.join(HERE, ".env")


class Env:
    """Lee .env y lo recarga solo si cambia (así puedes pegar tus claves sin reiniciar)."""

    def __init__(self):
        self.mtime = None
        self.data = {}
        self.voice = voice.VoiceConfig({})
        self.refresh()

    def refresh(self):
        m = os.path.getmtime(ENV_PATH) if os.path.exists(ENV_PATH) else 0
        if m != self.mtime:
            self.mtime = m
            self.data = voice.load_env(ENV_PATH)
            self.voice = voice.VoiceConfig(self.data)
        return self

    def get(self, k, default=None):
        return self.refresh().data.get(k, default)


ENV = Env()

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ SSE hub

class Hub:
    def __init__(self):
        self.clients = set()
        self.lock = threading.Lock()

    def add(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.clients.add(q)
        return q

    def remove(self, q):
        with self.lock:
            self.clients.discard(q)

    def publish(self, obj):
        data = json.dumps(obj, ensure_ascii=False)
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait(data)
            except queue.Full:
                pass


HUB = Hub()


# ------------------------------------------------------------------ grafo

class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.version = 0
        self.graph = None
        self.extra = None
        self.sig = None
        self.usage = {}  # node index -> usos
        self.rebuild()

    def rebuild(self):
        g, extra = scanner.build(CFG)
        with self.lock:
            self.graph, self.extra = g, extra
            self.version += 1
            self.sig = scanner.signature(CFG)
            self.usage = {}
        log("grafo: %d notas, %d conexiones, %d problemas (%d ms)" % (
            len(g["nodes"]), len(g["edges"]), len(g["problems"]), g["buildMs"]))

    def graph_json(self):
        with self.lock:
            g = dict(self.graph)
            g["version"] = self.version
            g["usage"] = self.usage
        return json.dumps(g, ensure_ascii=False).encode("utf-8")

    def node_for_path(self, path):
        if not path:
            return None
        return self.extra["paths"].get(scanner.norm_path(path))

    def node_for_dir(self, path):
        d = scanner.norm_path(path)
        lst = self.extra["dirs"].get(d)
        if lst:
            for i in lst:
                if self.graph["nodes"][i]["ty"] == self.graph["typeIds"].index("indice"):
                    return i
            return lst[0]
        return None

    def skill_node(self, name):
        return self.extra["skills"].get(scanner.fold(name or ""))

    def home_for(self, projkey):
        h = self.graph["homes"].get(projkey)
        return h if h is not None else self.graph.get("globalHome")

    def watch(self):
        while True:
            time.sleep(4)
            try:
                s = scanner.signature(CFG)
                if s != self.sig:
                    log("cambió la memoria: rearmando el cerebro")
                    self.rebuild()
                    HUB.publish({"k": "graph", "v": self.version})
                    threading.Thread(target=USAGE.scan, daemon=True).start()
            except Exception as e:
                log("watch error:", e)


# ------------------------------------------------------------------ actividad en vivo

def parse_ts(s):
    if not s:
        return time.time()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def count_lines(s):
    if not s:
        return 0
    return s.count("\n") + (0 if s.endswith("\n") else 1)


def classify(name, inp):
    """Tool de Claude Code -> (verbo, ruta, detalle, +lineas, -lineas)."""
    inp = inp if isinstance(inp, dict) else {}
    path = inp.get("file_path") or inp.get("notebook_path") or ""
    if name in ("Read", "NotebookRead"):
        return "lee", path, "", 0, 0
    if name == "Edit":
        return "edita", path, "", count_lines(inp.get("new_string")), count_lines(inp.get("old_string"))
    if name == "MultiEdit":
        eds = inp.get("edits") or []
        return ("edita", path, "", sum(count_lines(e.get("new_string")) for e in eds),
                sum(count_lines(e.get("old_string")) for e in eds))
    if name == "NotebookEdit":
        return "edita", path, "", count_lines(inp.get("new_source")), 0
    if name == "Write":
        return "crea", path, "", count_lines(inp.get("content")), 0
    if name in ("Grep", "Glob"):
        return "busca", inp.get("path") or "", str(inp.get("pattern") or "")[:60], 0, 0
    if name in ("ToolSearch", "LSP"):
        return "busca", "", str(inp.get("query") or name)[:60], 0, 0
    if name in ("Bash", "PowerShell"):
        c = str(inp.get("command") or "")
        low = c.lower()
        if re.search(r"\bgit\s+commit\b", low):
            v = "commit"
        elif re.search(r"\bgit\b", low):
            v = "git"
        elif re.search(r"\b(build|compile|tsc|webpack|cargo build|dotnet build|gradle|mvn|make)\b", low):
            v = "compila"
        elif re.search(r"\b(test|tests|pytest|jest|vitest|mocha|playwright)\b", low):
            v = "prueba"
        elif re.search(r"\b(python|py|node|npx|npm|deno|bun|ffmpeg|yt-dlp)\b|\.(py|mjs|js|ps1|sh|ts)\b", low):
            v = "script"
        else:
            v = "ejecuta"
        return v, "", str(inp.get("description") or c.splitlines()[0] if c else "")[:70], 0, 0
    if name in ("Agent", "Task"):
        return "agente", "", "%s: %s" % (inp.get("subagent_type") or "agente", inp.get("description") or ""), 0, 0
    if name == "Workflow":
        return "agente", "", "workflow", 0, 0
    if name == "Skill":
        return "skill", "", str(inp.get("skill") or ""), 0, 0
    if name in ("WebFetch", "WebSearch") or name.startswith("mcp__claude-in-chrome"):
        u = str(inp.get("url") or inp.get("query") or "")
        m = re.match(r"https?://([^/]+)", u)
        return "navega", "", (m.group(1) if m else u)[:50], 0, 0
    if name in ("AskUserQuestion", "ExitPlanMode", "EnterPlanMode"):
        return "espera", "", "espera tu OK", 0, 0
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate", "ScheduleWakeup", "CronCreate"):
        return "planea", "", "", 0, 0
    if name.startswith("mcp__"):
        parts = name.split("__")
        return "usa", "", parts[1] if len(parts) > 1 else name, 0, 0
    return name.lower()[:12], "", "", 0, 0


class Session:
    def __init__(self, sid, projkey, name):
        self.sid, self.projkey, self.name = sid, projkey, name
        self.state = "listo"
        self.cur = ""
        self.last = 0.0
        self.agents = collections.OrderedDict()  # aid -> dict
        self.pending_agents = collections.deque()
        self.type_count = collections.Counter()
        self.demo = False


class Live:
    RECENT = 30 * 60

    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.files = {}  # ruta -> info
        self.sessions = {}
        self.feed = collections.deque(maxlen=40)
        self.edits = {}
        self.last_any = 0.0
        self.mind = "descansando"
        self.names_used = collections.Counter()

    # -- sesiones y agentes
    def session(self, sid, projkey, cwd=None):
        s = self.sessions.get(sid)
        if not s:
            if cwd and os.path.normcase(os.path.join(CACHE, "jobs")) in os.path.normcase(cwd):
                base = os.path.basename(cwd.rstrip("\\/"))  # auditoria / mejora
            else:
                user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
                label = scanner.project_label(projkey, user, scanner.home_key(os.path.expanduser("~")))
                base = (label or "inicio")[:26]
            self.names_used[base] += 1
            name = base if self.names_used[base] == 1 else "%s·%d" % (base, self.names_used[base])
            s = Session(sid, projkey, name)
            self.sessions[sid] = s
        return s

    def agent(self, s, aid):
        a = s.agents.get(aid)
        if not a:
            atype = s.pending_agents.popleft() if s.pending_agents else "subagente"
            s.type_count[atype] += 1
            a = {"aid": aid, "name": "%s #%d" % (atype, s.type_count[atype]), "verb": "", "n": 0, "last": 0}
            s.agents[aid] = a
        return a

    # -- archivos
    def discover(self):
        now = time.time()
        pats = [os.path.join(PROJECTS, "*", "*.jsonl"), os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl")]
        for pat in pats:
            for p in glob.glob(pat):
                if p in self.files:
                    continue
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                parts = os.path.relpath(p, PROJECTS).split(os.sep)
                info = {"projkey": parts[0], "sub": "subagents" in parts, "pos": st.st_size, "buf": b"",
                        "sid": parts[1] if "subagents" in parts else os.path.splitext(parts[1])[0],
                        "aid": os.path.splitext(parts[-1])[0] if "subagents" in parts else None}
                self.files[p] = info
                if now - st.st_mtime < self.RECENT:
                    self.backfill(p, info, st.st_size)

    def backfill(self, p, info, size):
        start = max(0, size - 3_000_000)
        try:
            with open(p, "rb") as f:
                f.seek(start)
                data = f.read(size - start)
        except OSError:
            return
        lines = data.split(b"\n")
        if start > 0:
            lines = lines[1:]
        cutoff = time.time() - self.RECENT
        for ln in lines:
            try:
                rec = json.loads(ln)
            except ValueError:
                continue
            if parse_ts(rec.get("timestamp")) >= cutoff:
                self.handle(rec, info, live=False)

    def poll(self):
        for p, info in list(self.files.items()):
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            if size < info["pos"]:
                info["pos"] = 0
            if size == info["pos"]:
                continue
            try:
                with open(p, "rb") as f:
                    f.seek(info["pos"])
                    data = f.read(size - info["pos"])
            except OSError:
                continue
            info["pos"] = size
            data = info["buf"] + data
            *lines, info["buf"] = data.split(b"\n")
            for ln in lines:
                if not ln.strip():
                    continue
                try:
                    rec = json.loads(ln)
                except ValueError:
                    continue
                try:
                    self.handle(rec, info, live=True)
                except Exception as e:
                    log("evento ignorado:", e)

    # -- eventos
    def handle(self, rec, info, live):
        t = rec.get("type")
        if t not in ("assistant", "user"):
            return
        ts = parse_ts(rec.get("timestamp"))
        sid = rec.get("sessionId") or info["sid"]
        with self.lock:
            s = self.session(sid, info["projkey"], rec.get("cwd"))
            aid = info["aid"] or (rec.get("agentId") if rec.get("isSidechain") else None)
            a = self.agent(s, aid) if aid else None
            msg = rec.get("message") or {}
            content = msg.get("content")
            s.last = max(s.last, ts)
            self.last_any = max(self.last_any, ts)
            if t == "assistant":
                blocks = content if isinstance(content, list) else []
                used_tool = False
                for b in blocks:
                    if b.get("type") == "tool_use":
                        used_tool = True
                        self.tool(s, a, b.get("name") or "", b.get("input") or {}, ts, live)
                if not used_tool and not a and msg.get("stop_reason") == "end_turn":
                    s.state, s.cur = "listo", ""
                    self.emit(s, None, "listo", None, None, "terminó de responder", 0, 0, ts, live)
                elif not used_tool and not a:
                    s.state = "pensando"
                self.push_state(live)
            elif t == "user":
                if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                    if not a:
                        if s.state != "espera":
                            s.state = "pensando"
                        self.push_state(live)
                    return
                if a or rec.get("isMeta"):
                    return
                text = content if isinstance(content, str) else " ".join(
                    b.get("text", "") for b in (content or []) if isinstance(b, dict))
                if not text.strip() or text.lstrip().startswith("<local-command") or "<system-reminder>" in text[:40]:
                    return
                s.state, s.cur = "pensando", ""
                self.emit(s, None, "mensaje", None, None, "escribió un mensaje", 0, 0, ts, live, actor="user")
                self.push_state(live)

    def tool(self, s, a, name, inp, ts, live):
        verb, path, detail, plus, minus = classify(name, inp)
        node = self.store.node_for_path(path) if path else None
        if node is None and verb == "busca" and path:
            node = self.store.node_for_dir(path)
        if verb == "skill":
            node = self.store.skill_node(detail)
        fname = None
        if path and node is None:
            fname = os.path.basename(path.rstrip("\\/"))
        if verb == "agente" and not a:
            s.pending_agents.append((inp.get("subagent_type") or "agente") if isinstance(inp, dict) else "agente")
        if verb in ("edita", "crea") and path:
            key = scanner.norm_path(path)
            e = self.edits.setdefault(key, {"name": os.path.basename(path), "plus": 0, "minus": 0, "ts": 0})
            e["plus"] += plus
            e["minus"] += minus
            e["ts"] = max(e["ts"], ts)
        target = (self.store.graph["nodes"][node]["t"] if node is not None else (fname or detail))
        if a:
            a["verb"], a["n"], a["last"] = verb, a["n"] + 1, ts
        else:
            s.state = "espera" if verb == "espera" else "trabajando"
            s.cur = ("%s %s" % (verb, target)).strip()[:80]
        self.emit(s, a, verb, node, fname, detail if node is None and not fname else target, plus, minus, ts, live)

    def emit(self, s, a, verb, node, fname, text, plus, minus, ts, live, actor=None):
        ev = {"k": "act", "ts": ts, "sid": s.sid, "sname": s.name, "aid": a["aid"] if a else None,
              "aname": a["name"] if a else None, "verb": verb, "node": node, "file": fname,
              "text": text or "", "plus": plus, "minus": minus, "home": self.store.home_for(s.projkey),
              "actor": actor, "demo": s.demo}
        self.feed.append(ev)
        if live:
            HUB.publish(ev)

    def snapshot_sessions(self):
        now = time.time()
        out = []
        for s in sorted(self.sessions.values(), key=lambda s: -s.last):
            if now - s.last > 15 * 60:
                continue
            agents = [dict(a) for a in s.agents.values() if now - a["last"] < 120]
            state = s.state
            if state in ("trabajando", "pensando") and now - s.last > 180:
                state = "listo"
            out.append({"sid": s.sid, "name": s.name, "state": state, "cur": s.cur, "last": s.last,
                        "agents": agents, "home": self.store.home_for(s.projkey), "demo": s.demo})
        return out[:6]

    def push_state(self, live=True):
        if live:
            HUB.publish({"k": "sessions", "sessions": self.snapshot_sessions()})

    def edits_recent(self):
        cutoff = time.time() - self.RECENT
        lst = [dict(e) for e in self.edits.values() if e["ts"] >= cutoff]
        lst.sort(key=lambda e: -e["ts"])
        return lst[:5]

    def compute_mind(self):
        now = time.time()
        with self.lock:
            active = [s for s in self.sessions.values() if now - s.last < 25]
            thinking = [s for s in self.sessions.values() if s.state == "pensando" and now - s.last < 120]
            working = [s for s in active if s.state in ("trabajando", "espera")]
        if working:
            return "trabajando"
        if thinking or active:
            return "pensando"
        idle = now - self.last_any
        if idle > CFG["idle_dream_seconds"]:
            return "soñando"
        if idle > CFG["idle_rest_seconds"]:
            return "descansando"
        return "pensando" if idle < 20 else "descansando"

    def snapshot(self):
        with self.lock:
            return {"k": "snapshot", "sessions": self.snapshot_sessions(), "feed": list(self.feed)[-12:],
                    "edits": self.edits_recent(), "mind": self.compute_mind(), "user": self.store.graph["user"],
                    "v": self.store.version}

    def run(self):
        last_disc = 0
        last_tick = 0
        while True:
            try:
                now = time.time()
                if now - last_disc > 3:
                    self.discover()
                    last_disc = now
                self.poll()
                if now - last_tick > 1:
                    last_tick = now
                    m = self.compute_mind()
                    if m != self.mind:
                        self.mind = m
                        HUB.publish({"k": "mind", "mind": m})
                    with self.lock:
                        HUB.publish({"k": "tick", "sessions": self.snapshot_sessions(),
                                     "edits": self.edits_recent()})
            except Exception as e:
                log("live error:", e)
            time.sleep(0.35)


# ------------------------------------------------------------------ "Probar": sesión de prueba

def run_demo(store, live):
    """Simula una sesión 'prueba' con notas reales del cerebro. No toca ningún archivo."""
    g = store.graph
    nodes = g["nodes"]
    if not nodes:
        return
    tyi = {t: i for i, t in enumerate(g["typeIds"])}
    by_type = collections.defaultdict(list)
    for i, n in enumerate(nodes):
        by_type[n["ty"]].append(i)

    def pick(*types):
        pool = [i for t in types for i in by_type.get(tyi[t], [])] or list(range(len(nodes)))
        return random.choice(pool)

    home = g.get("globalHome") if g.get("globalHome") is not None else pick("indice")
    sid = "demo-%d" % int(time.time())
    with live.lock:
        s = Session(sid, "", "prueba")
        s.demo = True
        live.sessions[sid] = s

    def act(verb, node=None, fname=None, text="", plus=0, minus=0, agent=None, state=None):
        ts = time.time()
        with live.lock:
            s.last = ts
            live.last_any = ts
            a = None
            if agent:
                a = s.agents.get(agent[0])
                if not a:
                    a = {"aid": agent[0], "name": agent[1], "verb": "", "n": 0, "last": ts}
                    s.agents[agent[0]] = a
                a["verb"], a["n"], a["last"] = verb, a["n"] + 1, ts
            else:
                s.state = state or ("espera" if verb == "espera" else "trabajando")
                tgt = nodes[node]["t"] if node is not None else (fname or text)
                s.cur = ("%s %s" % (verb, tgt)).strip()[:80] if verb not in ("listo",) else ""
            if fname and verb in ("edita", "crea"):
                live.edits[fname] = {"name": fname, "plus": plus, "minus": minus, "ts": ts}
            ev = {"k": "act", "ts": ts, "sid": sid, "sname": "prueba", "aid": a["aid"] if a else None,
                  "aname": a["name"] if a else None, "verb": verb, "node": node, "file": fname,
                  "text": text or (nodes[node]["t"] if node is not None else ""), "plus": plus, "minus": minus,
                  "home": home, "actor": None, "demo": True}
            live.feed.append(ev)
            HUB.publish(ev)
            HUB.publish({"k": "sessions", "sessions": live.snapshot_sessions()})

    agents = [("d1", "general-purpose #1"), ("d2", "Explore #1"), ("d3", "general-purpose #2"),
              ("d4", "Explore #2"), ("d5", "general-purpose #3"), ("d6", "Plan #1")]
    verbs = ["lee", "busca", "script", "git", "compila", "lee", "prueba", "busca"]
    steps = [
        (0.0, lambda: act("lee", pick("proyecto"))),
        (1.6, lambda: act("busca", pick("indice"), text="memoria")),
        (1.2, lambda: act("agente", home, text="lanza 3 agentes")),
    ]
    for i in range(3):
        steps.append((0.25, lambda i=i: act(random.choice(verbs), pick("referencia", "proyecto", "feedback"), agent=agents[i])))
    steps.append((1.0, lambda: act("lee", pick("indice"))))
    steps.append((0.8, lambda: act("agente", home, text="lanza 3 agentes más")))
    for i in range(3, 6):
        steps.append((0.25, lambda i=i: act(random.choice(verbs), pick("referencia", "proyecto", "feedback", "skill"), agent=agents[i])))
    for _ in range(14):
        steps.append((random.uniform(0.35, 0.9), lambda: act(random.choice(verbs), pick("proyecto", "referencia", "feedback", "usuario", "skill"),
                                                             agent=random.choice(agents))))
        if random.random() < 0.35:
            steps.append((0.4, lambda: act("lee", pick("proyecto", "referencia"))))
    steps += [
        (0.8, lambda: act("edita", None, fname="demo.txt", plus=12, minus=3)),
        (1.4, lambda: act("compila", None, text="build")),
        (1.5, lambda: act("espera", None, text="espera tu OK")),
        (2.2, lambda: act("crea", None, fname="nota-de-prueba.md", plus=20, minus=0)),
        (1.3, lambda: act("commit", None, text="en prueba")),
        (1.5, lambda: act("lee", pick("indice"))),
        (1.8, lambda: act("listo", None, text="terminó de responder", state="listo")),
    ]
    for delay, fn in steps:
        time.sleep(delay)
        fn()
    time.sleep(20)
    with live.lock:
        s.agents.clear()


# ------------------------------------------------------------------ uso de cada nota

class Usage:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()

    def scan(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            t0 = time.time()
            os.makedirs(CACHE, exist_ok=True)
            cpath = os.path.join(CACHE, "usage.json")
            try:
                with open(cpath, encoding="utf-8") as f:
                    cache = json.load(f)
            except (OSError, ValueError):
                cache = {"files": {}}
            files = cache.setdefault("files", {})
            cutoff = time.time() - CFG["usage_days"] * 86400
            pats = [os.path.join(PROJECTS, "*", "*.jsonl"), os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl")]
            rx = re.compile(r'"name":"(Read|Edit|Write|MultiEdit)","input":\{"file_path":"((?:[^"\\]|\\.)*)"')
            for pat in pats:
                for p in glob.glob(pat):
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    if st.st_mtime < cutoff:
                        continue
                    ent = files.setdefault(p, {"pos": 0, "hits": {}})
                    if st.st_size < ent["pos"]:
                        ent["pos"], ent["hits"] = 0, {}
                    if st.st_size == ent["pos"]:
                        continue
                    with open(p, "rb") as f:
                        f.seek(ent["pos"])
                        for raw in f:
                            if b"file_path" not in raw:
                                continue
                            line = raw.decode("utf-8", "replace")
                            for m in rx.finditer(line):
                                fp = json.loads('"' + m.group(2) + '"')
                                if fp.lower().endswith(".md"):
                                    k = scanner.norm_path(fp)
                                    ent["hits"][k] = ent["hits"].get(k, 0) + 1
                    ent["pos"] = st.st_size
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(cache, f)
            total = collections.Counter()
            for ent in files.values():
                total.update(ent["hits"])
            usage = {}
            for path, c in total.items():
                i = self.store.extra["paths"].get(path)
                if i is not None:
                    usage[i] = c
            with self.store.lock:
                self.store.usage = usage
            HUB.publish({"k": "usage", "usage": usage})
            log("uso de notas calculado: %d notas usadas (%.1fs)" % (len(usage), time.time() - t0))
        except Exception as e:
            log("usage error:", e)
        finally:
            self.lock.release()


# ------------------------------------------------------------------ voz: el cerebro contesta

HISTORY = collections.deque(maxlen=8)


def brain_context(question, demo_only=False):
    """Arma lo que el cerebro 'sabe' para contestar: resumen, actividad en vivo y las notas más relevantes."""
    g, ex = STORE.graph, STORE.extra
    tyid = g["typeIds"]
    qt = set(scanner.tokens(question))
    scored = []
    for i, note in enumerate(ex["notes"]):
        tt = set(scanner.tokens(note.title + " " + note.desc))
        s = 3 * len(qt & tt) + len(qt & set(note.toks))
        if s:
            scored.append((s + g["nodes"][i]["i"] * 0.05, i))
    top = [i for _, i in sorted(scored, reverse=True)[:6]]
    L = ["RESUMEN DEL CEREBRO (generado %s):" % g["generated"],
         "%d notas, %d conexiones, %d problemas detectados automáticamente." % (len(g["nodes"]), len(g["edges"]), len(g["problems"]))]
    reg = {r["id"]: "%s·%s" % (r["name"].lower(), r["theme"].lower()) for r in g["regions"]}
    L.append("Grupos (lóbulo): " + "; ".join("%s = %d notas (%s)" % (gr["name"], gr["count"], reg.get(gr["region"], gr["region"]))
                                         for gr in g["groups"]))
    kinds = collections.Counter(p["kind"] for p in g["problems"])
    if kinds:
        L.append("Problemas: " + ", ".join("%s %d" % (k, v) for k, v in kinds.items()))
    if JOBS.audit:
        a = JOBS.audit
        L.append("Última auditoría con Claude (%s): %s%% repetidas, %s%% corruptas, %s%% viejas, salud %s%%. %s" % (
            a.get("fecha"), a.get("pct_repetidas"), a.get("pct_corruptas"), a.get("pct_viejas"), a.get("salud"), a.get("resumen", "")))
    with LIVE.lock:
        sess = LIVE.snapshot_sessions()
        feed = list(LIVE.feed)[-40:]
    if demo_only:  # para grabar demos: solo la sesión de prueba
        sess = [x for x in sess if x.get("demo")]
        feed = [e for e in feed if e.get("demo")]
    feed = feed[-12:]
    if sess:
        L.append("AHORA MISMO: " + "; ".join("%s está %s%s%s" % (s["name"], s["state"], (": " + s["cur"]) if s["cur"] else "",
                                                                 (" con %d agentes" % len(s["agents"])) if s["agents"] else "")
                                              for s in sess))
    if feed:
        L.append("Últimas acciones: " + "; ".join("%s %s %s" % (e.get("aname") or e["sname"], e["verb"], e.get("text", ""))
                                                   for e in feed))
    L.append("Estado mental: " + LIVE.mind)
    L.append("Notas más importantes: " + "; ".join(g["nodes"][i]["t"] for i in sorted(range(len(g["nodes"])), key=lambda i: -g["nodes"][i]["i"])[:12]))
    if top:
        L.append("\nNOTAS RELEVANTES PARA LA PREGUNTA:")
        for i in top:
            n, note = g["nodes"][i], ex["notes"][i]
            L.append("### %s (%s, grupo %s, archivo %s)\n%s\n%s" % (n["t"], tyid[n["ty"]], g["groups"][n["g"]]["name"],
                                                                    os.path.basename(n["p"]), n["d"], note.body[:1300]))
    return "\n".join(L), top


class Handler_Voice:
    @staticmethod
    def stream_pcm(handler, outq, cancel, vid):
        handler.send_response(200)
        handler.send_header("Content-Type", "application/octet-stream")
        handler.send_header("X-Sample-Rate", str(voice.SAMPLE_RATE))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        try:
            while True:
                item = outq.get(timeout=150)
                if item is None:
                    break
                if isinstance(item, Exception):
                    HUB.publish({"k": "voice", "id": vid, "error": str(item)})
                    continue
                handler.wfile.write(b"%X\r\n" % len(item) + item + b"\r\n")
                handler.wfile.flush()
            handler.wfile.write(b"0\r\n\r\n")
            handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError, queue.Empty):
            cancel.set()


def cap_words(gen, limit):
    """Corta la respuesta hablada al terminar la frase en la que se pasa del límite de palabras."""
    words = 0
    for piece in gen:
        words += len(piece.split())
        if words > limit:
            m = re.search(r"[.!?…](\s|$)", piece)
            if m:
                yield piece[:m.end()]
                return
        yield piece


def voice_ask(handler, body):
    cfg = ENV.refresh().voice
    q = (body.get("text") or "").strip()[:2000]
    vid = body.get("id") or str(time.time())
    if not q:
        return handler.send_json({"error": "No escuché ninguna pregunta."}, 400)
    if not cfg.can_talk:
        return handler.send_json({"error": "No encuentro Claude Code (el comando 'claude'): instálalo para que el cerebro pueda conversar."}, 409)
    ctx, nodes = brain_context(q, demo_only=body.get("focus") == "demo")
    HUB.publish({"k": "voice", "id": vid, "phase": "thinking", "nodes": nodes, "q": q})
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    system = voice.persona(STORE.graph["user"]) + "\nFecha y hora: " + now
    system += ("\nTienes el contexto del cerebro en el mensaje. Si hace falta un dato que no está, puedes leer los "
               "archivos de memoria con Read (las rutas están en el contexto), pero solo si es imprescindible: "
               "la respuesta hablada tiene que arrancar rápido. Nunca menciones herramientas ni rutas en voz alta.")
    convo = "\n".join(("%s: %s" % ("Usuario" if m["role"] == "user" else "Cerebro", m["content"])) for m in HISTORY)
    prompt = ctx + ("\n\nCONVERSACIÓN RECIENTE:\n" + convo if convo else "") + "\n\nPREGUNTA DE %s (responde hablando):\n%s" % (
        STORE.graph["user"], q)
    if body.get("tone") == "tiktok":  # para videos cortos: gancho y directo
        prompt += ("\n\n(Es para un video corto de TikTok: responde en 2 frases, máximo 30 palabras, directo y con un "
                   "gancho audaz o un poco polémico que llame la atención, sin mentir. Nombra uno o dos de los proyectos "
                   "que ves por su nombre de grupo, pero nada de datos personales del usuario.)")
        limit = 40
    else:
        prompt += "\n\n(Respuesta hablada: máximo 3 frases, menos de 70 palabras, salvo que pida más detalle.)"
        limit = 260 if re.search(r"detalle|expl[ií]ca|cu[eé]ntame todo|contame todo|largo", q, re.I) else 95
    source = cap_words(voice.claude_stream(cfg, system, prompt, os.path.join(CACHE, "jobs", "voz"), PROJECTS), limit)
    reply = {"text": ""}

    def on_text(text, final):
        reply["text"] = text
        HUB.publish({"k": "voice", "id": vid, "phase": "final" if final else "text", "text": text})
        if final:
            HISTORY.append({"role": "user", "content": q})
            HISTORY.append({"role": "assistant", "content": text})

    cancel = threading.Event()
    outq = voice.speak_stream(cfg, source, on_text=on_text, cancel=cancel)
    if body.get("json"):
        return collect_json(handler, outq, {"nodes": nodes}, reply)
    Handler_Voice.stream_pcm(handler, outq, cancel, vid)


def collect_json(handler, outq, extra, reply=None):
    """Para herramientas (grabar el demo): junta todo el audio y devuelve texto + PCM en base64."""
    import base64
    pcm, err = bytearray(), None
    while True:
        item = outq.get(timeout=180)
        if item is None:
            break
        if isinstance(item, Exception):
            err = str(item)
            continue
        pcm.extend(item)
    out = dict(extra, text=(reply or {}).get("text", ""), sampleRate=voice.SAMPLE_RATE,
               pcm=base64.b64encode(bytes(pcm)).decode("ascii"), error=err)
    handler.send_json(out)


def voice_say(handler, body):
    cfg = ENV.refresh().voice
    text = (body.get("text") or "").strip()[:1500]
    if not text or not cfg.fish_key:
        return handler.send_json({"error": "Sin texto o sin FISH_API_KEY."}, 409)
    cancel = threading.Event()
    outq = voice.speak_stream(cfg, [text], cancel=cancel)
    if body.get("json"):
        return collect_json(handler, outq, {}, {"text": text})
    Handler_Voice.stream_pcm(handler, outq, cancel, body.get("id") or "say")


# ------------------------------------------------------------------ HTTP

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
         ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_bytes(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_bytes(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), TYPES[".json"])

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/graph":
            return self.send_bytes(200, STORE.graph_json(), TYPES[".json"])
        if u.path == "/api/events":
            return self.sse()
        if u.path == "/api/note":
            return self.note(q.get("i", [""])[0])
        if u.path == "/api/voice/status":
            return self.send_json(ENV.refresh().voice.status())
        if u.path == "/api/job":
            return self.send_json(JOBS.public())
        return self.static(u.path)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(min(n, 200_000)).decode("utf-8"))
        except ValueError:
            return {}

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/voice/ask":
            return voice_ask(self, self.read_body())
        if u.path == "/api/voice/say":
            return voice_say(self, self.read_body())
        if u.path == "/api/audit":
            return self.send_json({"ok": JOBS.start_audit(), "job": JOBS.public()})
        if u.path == "/api/improve":
            return self.send_json({"ok": JOBS.start_improve(), "job": JOBS.public()})
        if u.path == "/api/undo":
            ok, info = JOBS.undo()
            return self.send_json({"ok": ok, "info": info})
        if u.path == "/api/probar":
            threading.Thread(target=run_demo, args=(STORE, LIVE), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path == "/api/open":
            try:
                i = int(q.get("i", ["-1"])[0])
                path = STORE.graph["nodes"][i]["p"]
                if hasattr(os, "startfile"):
                    os.startfile(path)
                return self.send_json({"ok": True})
            except (ValueError, IndexError, OSError) as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)
        if u.path == "/api/reload":
            STORE.rebuild()
            HUB.publish({"k": "graph", "v": STORE.version})
            return self.send_json({"ok": True})
        self.send_json({"error": "no existe"}, 404)

    def note(self, i):
        try:
            n = STORE.graph["nodes"][int(i)]
        except (ValueError, IndexError):
            return self.send_json({"error": "no existe"}, 404)
        text = scanner.read_text(n["p"], 60000)
        meta, body = scanner.parse_frontmatter(text)
        self.send_json({"i": int(i), "meta": meta, "body": body})

    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(WEB) or not os.path.isfile(full):
            return self.send_bytes(404, b"no existe", TYPES[".txt"])
        with open(full, "rb") as f:
            body = f.read()
        self.send_bytes(200, body, TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream"))

    def sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = HUB.add()
        try:
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.write(("data: %s\n\n" % json.dumps(LIVE.snapshot(), ensure_ascii=False)).encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(("data: %s\n\n" % data).encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            HUB.remove(q)


def free_port(start):
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return start


STORE = Store()
LIVE = Live(STORE)
USAGE = Usage(STORE)
JOBS = claude_jobs.Jobs(CFG, STORE, HUB, ENV, log)


def main():
    port = free_port(int(CFG["port"]))
    threading.Thread(target=STORE.watch, daemon=True).start()
    threading.Thread(target=LIVE.run, daemon=True).start()
    threading.Thread(target=USAGE.scan, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    url = "http://127.0.0.1:%d/" % port
    log("Cerebro de Claude listo en", url)
    if CFG.get("open_browser") and "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
