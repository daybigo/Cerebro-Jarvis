"""Auditar y mejorar la memoria usando el mismo Claude Code de la PC (claude -p, sin API keys extra).

- Auditar: Claude lee las memorias (solo lectura) y devuelve qué % están repetidas, corruptas,
  viejas o con links rotos, con el detalle de cada hallazgo.
- Mejorar: antes se hace un backup completo; Claude corrige los archivos (fusiona repetidas,
  arregla encabezados y links) y el servidor borra solo los archivos que Claude marcó como
  sobrantes, validando que estén dentro de una carpeta memory. "Deshacer" restaura el backup.

Como Claude guarda sus transcripts en ~/.claude/projects, el cerebro muestra en vivo lo que hace."""
import datetime
import glob
import json
import os
import shutil
import subprocess
import threading
import time

import scanner

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = scanner.load_config()["cache_dir"]

AUDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "total": {"type": "integer"},
        "repetidas": {"type": "integer"},
        "corruptas": {"type": "integer"},
        "viejas": {"type": "integer"},
        "rotas": {"type": "integer"},
        "resumen": {"type": "string"},
        "hallazgos": {"type": "array", "items": {"type": "object", "properties": {
            "tipo": {"type": "string", "enum": ["repetida", "corrupta", "vieja", "rota"]},
            "archivos": {"type": "array", "items": {"type": "string"}},
            "motivo": {"type": "string"},
            "arreglo": {"type": "string"}},
            "required": ["tipo", "archivos", "motivo", "arreglo"]}},
    },
    "required": ["total", "repetidas", "corruptas", "viejas", "rotas", "resumen", "hallazgos"],
}

IMPROVE_SCHEMA = {
    "type": "object",
    "properties": {
        "cambios": {"type": "array", "items": {"type": "object", "properties": {
            "archivo": {"type": "string"},
            "accion": {"type": "string"},
            "detalle": {"type": "string"}},
            "required": ["archivo", "accion", "detalle"]}},
        "borrar": {"type": "array", "items": {"type": "string"}},
        "resumen": {"type": "string"},
    },
    "required": ["cambios", "borrar", "resumen"],
}


class Jobs:
    def __init__(self, cfg, store, hub, env, log):
        self.cfg, self.store, self.hub, self.env, self.log = cfg, store, hub, env, log
        self.lock = threading.Lock()
        self.state = {"kind": None, "status": "idle", "started": 0, "log": [], "result": None, "error": None}
        self.audit = self._load("audit.json")
        self.improve = self._load("improve.json")
        self.projects = os.path.join(cfg["claude_dir"], "projects")

    # ---------------- estado
    def _load(self, name):
        try:
            with open(os.path.join(CACHE, name), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _save(self, name, obj):
        os.makedirs(CACHE, exist_ok=True)
        with open(os.path.join(CACHE, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)

    def public(self):
        s = dict(self.state)
        s["log"] = s["log"][-40:]
        s["lastAudit"] = self.audit
        s["lastImprove"] = self.improve
        s["canUndo"] = bool(self.improve and self.improve.get("backup") and os.path.isdir(self.improve["backup"]))
        return s

    def push(self, line=None):
        if line:
            self.state["log"].append(time.strftime("%H:%M:%S ") + line)
        self.hub.publish({"k": "job", "job": self.public()})

    def busy(self):
        return self.state["status"] == "running"

    # ---------------- material para Claude
    def memory_nodes(self):
        g = self.store.graph
        ex = self.store.extra
        out = []
        for i, n in enumerate(g["nodes"]):
            p = n["p"]
            if os.sep + "memory" + os.sep in p and p.lower().endswith(".md"):
                out.append((i, n, ex["notes"][i]))
        return out

    def inventory(self):
        lines = []
        for i, n, note in self.memory_nodes():
            if os.path.basename(n["p"]).upper() == "MEMORY.MD":
                continue
            ty = self.store.graph["typeIds"][n["ty"]]
            head = " ".join(note.body.split())[:260]
            lines.append("- %s | tipo=%s | %d palabras | título: %s | desc: %s | inicio: %s" % (
                n["p"], ty, n["w"], n["t"], (n["d"] or "—")[:160], head))
        return "\n".join(lines)

    def heuristics(self):
        g = self.store.graph
        lines = []
        for p in g["problems"]:
            n = g["nodes"][p["node"]]
            if os.sep + "memory" + os.sep not in n["p"]:
                continue
            extra = ""
            if p.get("other") is not None:
                extra = " (con %s)" % g["nodes"][p["other"]]["p"]
            lines.append("- %s: %s — %s%s" % (p["kind"], n["p"], p["msg"], extra))
        return "\n".join(lines) or "(nada)"

    def claude_bin(self):
        b = shutil.which("claude")
        if b:
            return b
        for cand in ("~/.local/bin/claude.exe", "~/.local/bin/claude", "~/AppData/Roaming/npm/claude.cmd"):
            c = os.path.expanduser(cand)
            if os.path.exists(c):
                return c
        return None

    # ---------------- correr Claude en modo headless
    def run_claude(self, prompt, schema, allowed, mode, workdir, timeout):
        exe = self.claude_bin()
        if not exe:
            raise RuntimeError("No encuentro el comando 'claude'. Instala Claude Code o agrégalo al PATH.")
        os.makedirs(workdir, exist_ok=True)
        args = [exe, "-p", "--output-format", "stream-json", "--verbose",
                "--json-schema", json.dumps(schema, ensure_ascii=False),
                "--permission-mode", mode,
                "--allowedTools=" + ",".join(allowed),
                "--disallowedTools=Bash,PowerShell,WebFetch,WebSearch,Agent,Task",
                "--add-dir=" + self.projects, "--strict-mcp-config", "--settings", json.dumps({"disableAllHooks": True})]
        model = self.env.get("CLAUDE_MODEL")
        if model:
            args += ["--model", model]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        proc = subprocess.Popen(args, cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", creationflags=flags)
        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        errs = []
        threading.Thread(target=lambda: errs.extend(proc.stderr.readlines()), daemon=True).start()
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
            result = None
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "assistant":
                    for b in (ev.get("message") or {}).get("content") or []:
                        if b.get("type") == "tool_use":
                            inp = b.get("input") or {}
                            what = inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
                            self.push("%s %s" % ({"Read": "lee", "Edit": "edita", "Write": "escribe", "Grep": "busca",
                                                  "Glob": "busca"}.get(b.get("name"), b.get("name")),
                                                 os.path.basename(str(what).rstrip("\\/")) or what))
                        elif b.get("type") == "text" and b.get("text", "").strip():
                            self.push("claude: " + b["text"].strip().splitlines()[0][:140])
                elif ev.get("type") == "result":
                    result = ev
            proc.wait(timeout=30)
        finally:
            timer.cancel()
        if result is None:
            msg = "".join(errs).strip()[-400:] or "Claude terminó sin resultado (¿tiempo agotado?)."
            raise RuntimeError(msg)
        if result.get("is_error") or result.get("subtype") not in (None, "success"):
            raise RuntimeError("Claude no pudo terminar: %s" % (result.get("result") or result.get("subtype")))
        data = result.get("structured_output")
        if not isinstance(data, dict):
            text = result.get("result") or ""
            a, b = text.find("{"), text.rfind("}")
            data = json.loads(text[a:b + 1]) if a >= 0 and b > a else None
        if not isinstance(data, dict):
            raise RuntimeError("Claude no devolvió el JSON esperado.")
        data["_cost"] = result.get("total_cost_usd")
        data["_ms"] = result.get("duration_ms")
        return data

    # ---------------- auditoría
    def start_audit(self):
        with self.lock:
            if self.busy():
                return False
            self.state = {"kind": "audit", "status": "running", "started": time.time(), "log": [], "result": None, "error": None}
        threading.Thread(target=self._audit_job, daemon=True).start()
        return True

    def _audit(self):
        user = self.store.graph["user"]
        today = datetime.date.today().isoformat()
        prompt = f"""Eres el auditor de la memoria de Claude Code de {user}. La memoria son archivos .md en
{self.projects}\\<proyecto>\\memory\\ (cada carpeta es un proyecto; MEMORY.md es el índice de esa carpeta).
Tu trabajo es medir qué porcentaje de las memorias están REPETIDAS o CORRUPTAS, y cuáles quedaron VIEJAS o tienen links ROTOS.

Definiciones:
- repetida: dice lo mismo, o casi, que otra memoria (aunque esté en otra carpeta o con otras palabras). Pon todos los archivos repetidos entre sí en un mismo hallazgo; el primero es el que conviene conservar.
- corrupta: no sirve como memoria: encabezado (frontmatter) inválido o sin name/description/type, contenido vacío, truncado o basura, codificación rota, o contradicciones internas.
- vieja: anuncia planes, plazos o estados con fechas que ya pasaron y no se actualizó. Hoy es {today}.
- rota: tiene [[links]] o enlaces a notas que no existen, o el MEMORY.md apunta a archivos que no están.

Abajo va el inventario completo (con un extracto de cada archivo) y lo que ya marcó un análisis automático, que puede tener falsos positivos.
Usa Read y Grep para confirmar lo que dudes. No modifiques nada.
Cuenta cada archivo una sola vez por tipo. "total" = cantidad de memorias sin contar los MEMORY.md.
En "archivos" pon rutas completas. "motivo" y "arreglo" en español, cortos y concretos. "resumen": 2 o 3 frases para leerle a {user} en voz alta.

INVENTARIO:
{self.inventory()}

DETECTADO AUTOMÁTICAMENTE:
{self.heuristics()}
"""
        self.push("Claude empieza a revisar %d memorias..." % len(self.memory_nodes()))
        data = self.run_claude(prompt, AUDIT_SCHEMA, ["Read", "Glob", "Grep"], "dontAsk",
                               os.path.join(CACHE, "jobs", "auditoria"), 1500)
        total = max(1, int(data.get("total") or 1))
        for k in ("repetidas", "corruptas", "viejas", "rotas"):
            data["pct_" + k] = round(100.0 * int(data.get(k) or 0) / total, 1)
        bad = set()
        for h in data.get("hallazgos") or []:
            if h.get("tipo") in ("repetida", "corrupta"):
                files = h.get("archivos") or []
                bad.update(files[1:] if h.get("tipo") == "repetida" else files)
        data["salud"] = round(max(0.0, 100.0 - 100.0 * len(bad) / total), 1)
        # nodos del cerebro afectados (para iluminarlos)
        nodes = set()
        for h in data.get("hallazgos") or []:
            idx = []
            for f in h.get("archivos") or []:
                i = self.store.node_for_path(f)
                if i is not None:
                    idx.append(i)
                    nodes.add(i)
            h["nodos"] = idx
        data["nodos"] = sorted(nodes)
        data["fecha"] = time.strftime("%Y-%m-%d %H:%M")
        self.audit = data
        self._save("audit.json", data)
        return data

    def _audit_job(self):
        try:
            data = self._audit()
            self.state.update(status="done", result=data)
            self.push("Auditoría lista: %s%% repetidas, %s%% corruptas." % (data["pct_repetidas"], data["pct_corruptas"]))
        except Exception as e:
            self.state.update(status="error", error=str(e))
            self.push("Error: %s" % e)

    # ---------------- mejora
    def start_improve(self):
        with self.lock:
            if self.busy():
                return False
            self.state = {"kind": "improve", "status": "running", "started": time.time(), "log": [], "result": None, "error": None}
        threading.Thread(target=self._improve_job, daemon=True).start()
        return True

    def backup(self):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(CACHE, "backups", stamp)
        files = []
        for p in glob.glob(os.path.join(self.projects, "*", "memory", "*.md")):
            rel = os.path.relpath(p, self.projects)
            tgt = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(tgt), exist_ok=True)
            shutil.copy2(p, tgt)
            files.append(rel)
        with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"created": time.time(), "root": self.projects, "files": files}, f)
        return dest, len(files)

    def safe_memory_file(self, path):
        p = os.path.normcase(os.path.abspath(path))
        root = os.path.normcase(os.path.abspath(self.projects))
        parts = os.path.relpath(p, root).split(os.sep)
        return (p.startswith(root + os.sep) and len(parts) == 3 and parts[1] == "memory" and p.endswith(".md")
                and os.path.basename(p) != "memory.md" and os.path.isfile(path))

    def _improve_job(self):
        try:
            audit = self.audit
            if not audit or time.time() - os.path.getmtime(os.path.join(CACHE, "audit.json")) > 6 * 3600:
                self.push("Primero audito para saber qué arreglar...")
                audit = self._audit()
            hall = [h for h in audit.get("hallazgos") or []]
            if not hall:
                self.state.update(status="done", result={"cambios": [], "borrar": [], "resumen": "No hay nada para corregir: tu memoria está sana."})
                self.push("Nada para corregir.")
                return
            dest, n = self.backup()
            self.push("Backup de %d memorias en %s" % (n, dest))
            user = self.store.graph["user"]
            today = datetime.date.today().isoformat()
            slim = [{k: h.get(k) for k in ("tipo", "archivos", "motivo", "arreglo")} for h in hall]
            prompt = f"""Eres el editor de la memoria de Claude Code de {user}. Los archivos viven en {self.projects}\\<proyecto>\\memory\\
y cada carpeta tiene un índice MEMORY.md con una línea por nota: - [Título](archivo.md) — gancho.
Una auditoría encontró los problemas de abajo. Corrígelos editando esos archivos (ya hay un backup completo, igual trabaja con cuidado):
- repetida: deja UNA sola nota (normalmente el primer archivo del hallazgo), pásale los datos útiles que solo tenían las otras y pon las otras en "borrar". Actualiza los MEMORY.md que las nombraban y los [[links]] que apuntaban a ellas.
- corrupta: arregla el encabezado (--- name / description / type: user|feedback|project|reference ---) y recupera el contenido si se puede; si no sirve para nada, ponla en "borrar" y quítala de su MEMORY.md.
- rota: corrige los [[links]] para que apunten a notas que existen, o quítalos.
- vieja: no inventes datos nuevos: agrega al final una línea "Estado ({today}): la fecha ya pasó, confirmar si sigue vigente." y ajusta la descripción si hace falta.
Mantén el idioma y el estilo de cada nota. No toques nada fuera de las carpetas memory. No borres archivos tú mismo: solo lístalos en "borrar" con su ruta completa.
En "cambios" pon una entrada por archivo tocado. "resumen": 2 o 3 frases para leerle a {user} en voz alta.

HALLAZGOS:
{json.dumps(slim, ensure_ascii=False, indent=1)}
"""
            data = self.run_claude(prompt, IMPROVE_SCHEMA, ["Read", "Edit", "Write", "Glob", "Grep"], "acceptEdits",
                                   os.path.join(CACHE, "jobs", "mejora"), 2400)
            deleted = []
            for f in data.get("borrar") or []:
                if self.safe_memory_file(f):
                    os.remove(f)
                    deleted.append(f)
                    self.push("borrada " + os.path.basename(f))
            data["borradas"] = deleted
            data["backup"] = dest
            data["fecha"] = time.strftime("%Y-%m-%d %H:%M")
            self.improve = data
            self._save("improve.json", data)
            self.audit = None
            try:
                os.remove(os.path.join(CACHE, "audit.json"))
            except OSError:
                pass
            self.state.update(status="done", result=data)
            self.push("Listo: %d archivos corregidos, %d borrados." % (len(data.get("cambios") or []), len(deleted)))
        except Exception as e:
            self.state.update(status="error", error=str(e))
            self.push("Error: %s" % e)

    def undo(self):
        imp = self.improve
        if not imp or not imp.get("backup") or not os.path.isdir(imp["backup"]):
            return False, "No hay backup para restaurar."
        with open(os.path.join(imp["backup"], "manifest.json"), encoding="utf-8") as f:
            man = json.load(f)
        created_after = man["created"]
        restored = 0
        for rel in man["files"]:
            src = os.path.join(imp["backup"], rel)
            dst = os.path.join(self.projects, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            restored += 1
        known = {os.path.normcase(os.path.join(self.projects, r)) for r in man["files"]}
        for p in glob.glob(os.path.join(self.projects, "*", "memory", "*.md")):
            if os.path.normcase(p) not in known and os.path.getmtime(p) > created_after:
                os.remove(p)  # archivos nuevos que creó la mejora
        self.improve = None
        try:
            os.remove(os.path.join(CACHE, "improve.json"))
        except OSError:
            pass
        self.push("Restauradas %d memorias desde el backup." % restored)
        return True, restored
