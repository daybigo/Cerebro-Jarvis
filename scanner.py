"""Arma el grafo del cerebro: lee las notas de memoria y skills de Claude Code,
las conecta entre sí y detecta problemas (links rotos, notas viejas, repetidas...).

Todo se lee localmente desde ~/.claude; nada sale de la PC.
"""
import collections
import datetime
import glob
import hashlib
import json
import math
import os
import re
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_CONFIG = {
    "port": 7777,
    "user_name": "",
    "claude_dir": "~/.claude",
    "include_skills": True,
    "include_project_instructions": False,
    "extra_roots": [],
    "idle_rest_seconds": 90,
    "idle_dream_seconds": 300,
    "usage_days": 30,
    "open_browser": True,
}

STOP = set("""
    para como esta este esto estos estas pero porque cuando donde desde hasta sobre entre tiene tienen
    todo todos toda todas cada solo sola mismo misma otro otra otros otras puede pueden hacer hace hecho
    siempre nunca tambien ademas antes despues luego ahora aqui alli algo alguno alguna nada muy mucho
    mucha muchos menos mayor menor bien usar usa uso usando ver sera seria fueron estaba estan estar
    that this with from have been will would should could there their them they then than when what which
    while where your about into only also just more most some such very over under each other these those
    because before after does done doing make made using used need needs file files line lines note notes
    name description type metadata user project feedback reference memory http https www html com
    apply como why how true false none null todo todos
""".split())

TYPE_ORDER = [
    ("instrucciones", "Instrucciones"),
    ("indice", "Índice"),
    ("usuario", "Usuario"),
    ("feedback", "Feedback"),
    ("proyecto", "Proyecto"),
    ("referencia", "Referencia"),
    ("skill", "Skill"),
    ("plan", "Plan"),
    ("documento", "Documento"),
]

EDGE_TYPES = [
    # id, etiqueta, estilo, visible por defecto, explicación
    ("wiki", "Wiki [[...]]", "solid-strong", True, "Link [[nombre]] escrito dentro de una nota"),
    ("indice", "Índice", "solid", True, "El MEMORY.md apunta a la nota"),
    ("enlace", "Enlace", "solid", True, "Link markdown [texto](archivo.md)"),
    ("responde", "Responde", "solid", True, "Un feedback que responde al proyecto de su carpeta"),
    ("mencion", "Mención", "solid", True, "La nota nombra a otra (título o skill) sin linkearla"),
    ("carpeta", "Carpeta", "solid", True, "Está en la carpeta pero el índice no la nombra"),
    ("cadena", "Cadena", "dotted", True, "Nacieron en la misma conversación, en orden"),
    ("sugerida", "Sugerida", "dashed", True, "Hablan de lo mismo pero en grupos distintos: conviene linkearlas"),
    ("parecida", "Parecida", "dotted", True, "Contenido parecido dentro del mismo grupo"),
    ("comparte", "Comparte", "dotted", False, "Comparten palabras poco comunes"),
]

# Rol -> región del cerebro
REGIONS = {
    "prefrontal": ("PREFRONTAL", "REGLAS Y PLANES"),
    "frontal": ("FRONTAL", "PROYECTOS"),
    "parietal": ("PARIETAL", "REFERENCIA"),
    "occipital": ("OCCIPITAL", "LO VISUAL"),
    "temporal": ("TEMPORAL", "MEMORIA"),
    "cerebelo": ("CEREBELO", "HERRAMIENTAS"),
    "tronco": ("TRONCO", None),
}

ROLE_COLORS = {
    "memoria": "#ff4f9e",
    "instrucciones": "#ffa53a",
    "proyectos": "#2ec8dc",
    "feedback": "#ffb347",
    "referencia": "#2fe0a0",
    "visual": "#c35cff",
    "skills": "#8f95ad",
}
EXTRA_COLORS = ["#ffd23f", "#ff5a5a", "#a8f03c", "#6f7dff", "#d9b98a", "#4fd6ff", "#ff8fd0"]

VISUAL_KW = ("design", "diseno", "video", "motion", "promo", "hype", "meme", "carrusel", "brand",
             "frontend", "visual", "anim", "ui", "ux", "3d")


# ---------------------------------------------------------------- utilidades

def load_config(path=None):
    cfg = dict(DEFAULT_CONFIG)
    path = path or os.environ.get("CEREBRO_CONFIG") or os.path.join(HERE, "config.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:  # config rota: seguimos con los defaults
            print("config.json inválido, uso valores por defecto:", e)
    cfg["claude_dir"] = os.path.expanduser(cfg["claude_dir"])
    cfg["cache_dir"] = os.path.expanduser(cfg.get("cache_dir") or os.path.join(HERE, ".cache"))
    return cfg


def norm_path(p):
    if not p:
        return ""
    p = str(p).strip().strip('"')
    m = re.match(r"^/([a-zA-Z])/(.*)$", p)  # estilo Git Bash: /c/Users/...
    if m:
        p = m.group(1) + ":/" + m.group(2)
    p = os.path.expanduser(p)
    return os.path.normcase(os.path.normpath(p))


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def tokens(text):
    out = []
    for w in re.findall(r"[a-z0-9][a-z0-9_\-]{3,}", fold(text)):
        w = w.strip("-_")
        if len(w) < 4 or w in STOP or w.isdigit():
            continue
        out.append(w)
    return out


def node_id(path):
    return hashlib.sha1(norm_path(path).encode("utf-8")).hexdigest()[:10]


def parse_frontmatter(text):
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            meta = {}
            for line in text[3:end].splitlines():
                m = re.match(r"^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
                if m and m.group(2).strip():
                    meta.setdefault(m.group(1).lower(), m.group(2).strip().strip("\"'"))
            return meta, text[end + 4:].lstrip("\n")
    return {}, text


def first_heading(body):
    m = re.search(r"^#{1,3}\s+(.+)$", body, re.M)
    return m.group(1).strip() if m else ""


def home_key(home):
    return re.sub(r"[^A-Za-z0-9]", "-", home)


def project_label(dirname, user, home_dirkey):
    """C--dev-mi-app-v2 -> mi-app-v2 ; C--Users-ana -> '' (la carpeta de usuario = memoria global)."""
    if dirname.lower() == home_dirkey.lower():
        return ""
    noise = {"c", "d", "e", "", "users", user.lower(), "onedrive", "escritorio", "desktop",
             "documents", "documentos", "projects", "dev", "claude", "home"}
    toks = dirname.split("-")
    i = 0
    while i < len(toks) and toks[i].lower() in noise:
        i += 1
    rest = [t for t in toks[i:]]
    return "-".join(rest) if rest else (toks[-1] or dirname)


def pretty(tok):
    if tok.isupper() and len(tok) <= 4:
        return tok
    if tok.isupper():
        return tok.capitalize()
    return tok[0].upper() + tok[1:]


def read_text(path, limit=400_000):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


# ---------------------------------------------------------------- recolección

class Note:
    __slots__ = ("id", "path", "npath", "title", "desc", "type", "family", "fam_display", "proj",
                 "proj_key", "role", "group", "mtime", "words", "body", "meta", "toks", "key_names",
                 "origin", "dirpath", "problems")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))
        self.problems = []


def collect(cfg):
    cdir = cfg["claude_dir"]
    user = os.environ.get("USERNAME") or os.environ.get("USER") or "yo"
    home = os.path.expanduser("~")
    hkey = home_key(home)
    notes = []

    def add(path, ntype, family, fam_display, proj, proj_key, role):
        text = read_text(path)
        meta, body = parse_frontmatter(text)
        stem = os.path.splitext(os.path.basename(path))[0]
        if ntype == "indice":
            title = "Índice · " + (proj or "global")
        elif ntype == "skill":
            title = meta.get("name") or (os.path.basename(os.path.dirname(path)) if stem == "SKILL" else stem)
        elif ntype == "instrucciones":
            title = "CLAUDE.md — " + (proj or "global")
        else:
            name = meta.get("name", "")
            if not name or re.fullmatch(r"[a-z0-9][a-z0-9_\-]*", name):
                # nombres tipo slug (feedback-sin-guion) -> título legible
                head = first_heading(body)
                slug = (name or stem).replace("_", " ").replace("-", " ").strip()
                title = head if head and len(head) <= 80 else (slug[:1].upper() + slug[1:])
            else:
                title = name
        desc = meta.get("description", "")
        words = len(re.findall(r"\w+", body))
        n = Note(id=node_id(path), path=path, npath=norm_path(path), title=title[:140], desc=desc[:400],
                 type=ntype, family=family, fam_display=fam_display, proj=proj, proj_key=proj_key,
                 role=role, mtime=os.path.getmtime(path), words=words, body=body, meta=meta,
                 origin=meta.get("originsessionid", ""), dirpath=os.path.dirname(norm_path(path)))
        n.toks = tokens(title + " " + title + " " + desc + " " + body[:20000])
        keys = {fold(stem)}
        if meta.get("name"):
            keys.add(fold(meta["name"]))
            keys.add(fold(meta["name"]).replace(" ", "-"))
        keys.add(fold(title))
        n.key_names = {k for k in keys if k}
        notes.append(n)
        return n

    # 1) memoria de cada proyecto
    for mdir in sorted(glob.glob(os.path.join(cdir, "projects", "*", "memory"))):
        dirname = os.path.basename(os.path.dirname(mdir))
        label = project_label(dirname, user, hkey)
        if label == "":
            family, fam_display, role = "__global__", "Memoria global", "memoria"
        else:
            first = label.split("-")[0]
            family = fold(first)
            parts = label.split("-")
            fam_display = pretty(parts[0]) + ((" " + parts[1].lower()) if len(parts[0]) <= 4 and len(parts) > 1 else "")
            role = "proyecto"
        for p in sorted(glob.glob(os.path.join(mdir, "*.md"))):
            base = os.path.basename(p)
            if base.upper() == "MEMORY.MD":
                ntype = "indice"
            else:
                head = read_text(p, 1500)
                meta, _ = parse_frontmatter(head)
                t = (meta.get("type") or "").lower()
                ntype = {"user": "usuario", "feedback": "feedback", "project": "proyecto",
                         "reference": "referencia"}.get(t, "documento")
            add(p, ntype, family, fam_display, label or "global", dirname, role)

    # 2) skills (cerebelo)
    if cfg.get("include_skills", True):
        sdir = os.path.join(cdir, "skills")
        for p in sorted(glob.glob(os.path.join(sdir, "*", "SKILL.md")) + glob.glob(os.path.join(sdir, "*.md"))):
            add(p, "skill", "__skills__", "Skills", "skills", "", "skills")
        for extra in ("agents", "commands"):
            for p in sorted(glob.glob(os.path.join(cdir, extra, "*.md"))):
                add(p, "skill", "__skills__", "Skills", extra, "", "skills")

    # 3) instrucciones y planes globales
    g = os.path.join(cdir, "CLAUDE.md")
    if os.path.exists(g):
        add(g, "instrucciones", "__instr__", "Instrucciones", "global", "", "instrucciones")
    for p in sorted(glob.glob(os.path.join(cdir, "plans", "*.md"))):
        add(p, "plan", "__instr__", "Instrucciones", "planes", "", "instrucciones")

    # 4) CLAUDE.md de cada proyecto (opcional: hay que activarlo en config.json)
    if cfg.get("include_project_instructions"):
        seen = set()
        for mdir in glob.glob(os.path.join(cdir, "projects", "*")):
            cwd = _cwd_from_transcripts(mdir)
            if cwd and cwd not in seen:
                seen.add(cwd)
                p = os.path.join(cwd, "CLAUDE.md")
                if os.path.isfile(p):
                    add(p, "instrucciones", "__instr__", "Instrucciones",
                        os.path.basename(cwd.rstrip("\\/")), os.path.basename(mdir), "instrucciones")

    # 5) carpetas extra elegidas por el usuario
    for root in cfg.get("extra_roots") or []:
        root = os.path.expanduser(root)
        rname = os.path.basename(root.rstrip("\\/")) or root
        count = 0
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d not in ("node_modules", ".git", "dist", "build", "vendor", ".venv", "__pycache__")]
            for f in fn:
                if f.lower().endswith(".md") and count < 400:
                    add(os.path.join(dp, f), "documento", "x:" + fold(rname), pretty(rname), rname, "", "proyecto")
                    count += 1
    return notes, user, hkey


def _cwd_from_transcripts(projdir):
    for p in sorted(glob.glob(os.path.join(projdir, "*.jsonl")), key=os.path.getmtime, reverse=True)[:1]:
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                for _ in range(40):
                    line = f.readline()
                    if not line:
                        break
                    m = re.search(r'"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"', line)
                    if m:
                        return json.loads('"' + m.group(1) + '"')
        except OSError:
            pass
    return None


# ---------------------------------------------------------------- grupos

def build_groups(notes, user_name):
    fam_count = collections.Counter(n.family for n in notes if n.role == "proyecto")
    total_proj = sum(fam_count.values()) or 1
    ranked = [f for f, _ in fam_count.most_common()]
    dominant = ranked[0] if ranked and fam_count[ranked[0]] >= max(40, 0.3 * total_proj) else None
    own = [f for f in ranked if f != dominant and fam_count[f] >= 8][:3]

    groups = {}  # key -> dict

    def group(key, name, role):
        if key not in groups:
            groups[key] = {"key": key, "name": name, "role": role, "notes": []}
        return groups[key]

    disp = {}
    for n in notes:
        disp.setdefault(n.family, collections.Counter())[n.fam_display] += 1

    for n in notes:
        if n.role == "memoria":
            g = group("memoria", "Memoria (global, la de " + user_name + ")", "memoria")
        elif n.role == "skills":
            g = group("skills", "Skills · Herramientas", "skills")
        elif n.role == "instrucciones":
            g = group("instr", "Instrucciones (CLAUDE.md y planes)", "instrucciones")
        elif n.family == dominant:
            fname = disp[dominant].most_common(1)[0][0].split(" ")[0]
            if any(k in fold(n.proj) for k in VISUAL_KW):
                g = group("dom-visual", fname + " · Diseño y contenido", "visual")
            elif n.type == "feedback":
                g = group("dom-feedback", fname + " · Feedback", "feedback")
            elif n.type == "referencia":
                g = group("dom-ref", fname + " · Referencia", "referencia")
            else:
                g = group("dom-proj", fname + " · Proyectos", "proyectos")
        elif n.family in own:
            g = group("fam-" + n.family, disp[n.family].most_common(1)[0][0], "familia")
        else:
            g = group("otros", "Otros proyectos", "otros")
        g["notes"].append(n)

    # grupos del dominante muy chicos se juntan con Proyectos
    for k in ("dom-feedback", "dom-ref", "dom-visual"):
        if k in groups and len(groups[k]["notes"]) < 4 and "dom-proj" in groups:
            groups["dom-proj"]["notes"].extend(groups.pop(k)["notes"])

    # región y color
    fixed = {"memoria": "temporal", "skills": "cerebelo", "instrucciones": "prefrontal",
             "feedback": "prefrontal", "referencia": "parietal", "visual": "occipital", "proyectos": "frontal"}
    # capacidad relativa de cada región (el tronco es finito: solo grupos chicos)
    cap = {"temporal": 1.0, "frontal": 1.0, "parietal": 0.9, "occipital": 0.7, "prefrontal": 0.7,
           "cerebelo": 0.6, "tronco": 0.25}
    load = collections.Counter()
    order = sorted(groups.values(), key=lambda g: (g["role"] in ("familia", "otros"), -len(g["notes"])))
    extra_i = 0
    for g in order:
        size = len(g["notes"])
        if g["role"] in fixed:
            g["region"] = fixed[g["role"]]
            g["color"] = ROLE_COLORS.get(g["role"] if g["role"] != "proyectos" else "proyectos")
        else:
            cands = [c for c in cap if c != "cerebelo" and (c != "tronco" or size <= 14)]
            g["region"] = min(cands, key=lambda c: ((load[c] + size) / cap[c], c))
            g["color"] = EXTRA_COLORS[extra_i % len(EXTRA_COLORS)]
            extra_i += 1
        load[g["region"]] += size
    order.sort(key=lambda g: ["memoria", "instrucciones", "proyectos", "feedback", "referencia", "visual",
                              "familia", "otros", "skills"].index(g["role"]))
    return order


# ---------------------------------------------------------------- conexiones

def build_edges(notes, idx_of):
    edges = {}  # (a,b,type) -> weight
    linked = set()
    problems = []

    def add(a, b, t, w=1.0):
        if a == b:
            return
        key = (min(a, b), max(a, b), t)
        edges[key] = max(edges.get(key, 0), w)
        linked.add((min(a, b), max(a, b)))

    by_key = collections.defaultdict(list)
    by_path = {}
    for i, n in enumerate(notes):
        by_path[n.npath] = i
        for k in n.key_names:
            by_key[k].append(i)

    def resolve_name(name, near):
        cands = by_key.get(fold(name).strip(), []) or by_key.get(fold(name).strip().replace(" ", "-"), [])
        if not cands:
            return None
        same = [c for c in cands if notes[c].dirpath == near]
        return (same or cands)[0]

    link_re = re.compile(r"\[([^\]]{1,200})\]\(([^)\s]{1,300})\)")
    wiki_re = re.compile(r"\[\[([^\]|#]{1,120})(?:[#|][^\]]*)?\]\]")

    indexed_in_dir = collections.defaultdict(set)
    index_of_dir = {}
    for i, n in enumerate(notes):
        if n.type == "indice":
            index_of_dir[n.dirpath] = i

    for i, n in enumerate(notes):
        body = n.body
        # [[wiki]]
        for m in wiki_re.finditer(body):
            j = resolve_name(m.group(1), n.dirpath)
            if j is None:
                n.problems.append(("roto", "Link roto: [[%s]] no existe" % m.group(1).strip()))
            else:
                add(i, j, "wiki")
        # [texto](archivo.md)
        for m in link_re.finditer(body):
            target = m.group(2).split("#")[0]
            if not target.lower().endswith(".md") or target.startswith("http"):
                continue
            tp = norm_path(os.path.join(os.path.dirname(n.path), target))
            j = by_path.get(tp)
            if n.type == "indice":
                if j is None:
                    n.problems.append(("roto", "El índice apunta a %s y ese archivo no existe" % target))
                else:
                    add(i, j, "indice")
                    indexed_in_dir[n.dirpath].add(j)
            elif j is not None:
                add(i, j, "enlace")

    # carpeta: notas que el índice no nombra
    for i, n in enumerate(notes):
        if n.type in ("indice", "skill", "instrucciones", "plan"):
            continue
        ix = index_of_dir.get(n.dirpath)
        if ix is not None and i not in indexed_in_dir[n.dirpath] and n.path.lower().find("memory") != -1:
            add(ix, i, "carpeta")
            n.problems.append(("fuera_indice", "Está en la carpeta pero MEMORY.md no la nombra"))

    # menciones: títulos largos y nombres de skills
    mention_keys = []
    for j, n in enumerate(notes):
        if n.type == "skill":
            k = fold(n.title)
            if len(k) >= 5:
                mention_keys.append((k, j))
        elif n.type not in ("indice",):
            k = fold(n.title)
            if len(k) >= 12 and len(k.split()) >= 2 and len(k) <= 60:
                mention_keys.append((k, j))
    compiled = [(re.compile(r"(?<![\w-])" + re.escape(k) + r"(?![\w-])"), j) for k, j in mention_keys]
    for i, n in enumerate(notes):
        low = fold(n.body[:30000])
        found = 0
        for rx, j in compiled:
            if j == i or (min(i, j), max(i, j)) in linked:
                continue
            if rx.search(low):
                add(i, j, "mencion", 0.6)
                found += 1
                if found >= 10:
                    break

    # cadena: misma conversación de origen
    by_origin = collections.defaultdict(list)
    for i, n in enumerate(notes):
        if n.origin:
            by_origin[n.origin].append(i)
    for lst in by_origin.values():
        lst.sort(key=lambda i: notes[i].mtime)
        for a, b in zip(lst, lst[1:]):
            add(a, b, "cadena", 0.7)

    # similitud (tf-idf con índice invertido)
    df = collections.Counter()
    for n in notes:
        df.update(set(n.toks))
    N = len(notes) or 1
    vecs = []
    for n in notes:
        tf = collections.Counter(n.toks)
        v = {t: (1 + math.log(c)) * math.log(1 + N / df[t]) for t, c in tf.items() if df[t] <= max(40, N // 8)}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({t: x / norm for t, x in v.items()})
    post = collections.defaultdict(list)
    for i, v in enumerate(vecs):
        for t, x in v.items():
            post[t].append((i, x))
    sim = collections.defaultdict(float)
    rare = collections.defaultdict(int)
    for t, lst in post.items():
        if len(lst) < 2:
            continue
        for a in range(len(lst)):
            ia, xa = lst[a]
            for b in range(a + 1, len(lst)):
                ib, xb = lst[b]
                sim[(ia, ib)] += xa * xb
                if df[t] <= 6:
                    rare[(ia, ib)] += 1

    best_same = collections.defaultdict(list)
    best_other = collections.defaultdict(list)
    for (a, b), s in sim.items():
        if s < 0.20:
            continue
        if notes[a].group is notes[b].group:
            best_same[a].append((s, b))
            best_same[b].append((s, a))
        else:
            best_other[a].append((s, b))
            best_other[b].append((s, a))

    # responde: feedback -> proyecto más parecido de su carpeta
    for i, n in enumerate(notes):
        if n.type != "feedback":
            continue
        cands = [(sim.get((min(i, j), max(i, j)), 0), j) for j, m in enumerate(notes)
                 if m.dirpath == n.dirpath and m.type in ("proyecto", "usuario")]
        cands = [c for c in cands if c[0] > 0.02]
        if cands:
            s, j = max(cands)
            if (min(i, j), max(i, j)) not in linked:
                add(i, j, "responde", 0.8)

    for a, lst in best_same.items():
        for s, b in sorted(lst, reverse=True)[:2]:
            if s >= 0.20 and (min(a, b), max(a, b)) not in linked:
                add(a, b, "parecida", s)
    sug = []
    for a, lst in best_other.items():
        for s, b in sorted(lst, reverse=True)[:1]:
            if s >= 0.22:
                sug.append((s, a, b))
    for s, a, b in sorted(sug, reverse=True)[:70]:
        if (min(a, b), max(a, b)) not in linked:
            add(a, b, "sugerida", s)
    comp = collections.defaultdict(list)
    for (a, b), c in rare.items():
        if c >= 3:
            comp[a].append((c, b))
    for a, lst in comp.items():
        for c, b in sorted(lst, reverse=True)[:2]:
            if (min(a, b), max(a, b)) not in linked:
                add(a, b, "comparte", min(1.0, c / 6))

    # problemas: repetidas
    seen_titles = {}
    for i, n in enumerate(notes):
        if n.type in ("indice",):
            continue
        k = fold(n.title)
        if k in seen_titles and n.type != "skill":
            j = seen_titles[k]
            n.problems.append(("repetida", "Mismo título que otra nota: %s" % notes[j].title, j))
        else:
            seen_titles[k] = i
    for (a, b), s in sim.items():
        if s >= 0.82 and notes[a].type != "indice" and notes[b].type != "indice":
            notes[b].problems.append(("repetida", "Casi idéntica a: %s" % notes[a].title, a))

    return edges, problems


def find_other_problems(notes):
    today = datetime.date.today()
    date_re = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")
    for n in notes:
        if n.type in ("feedback", "proyecto", "referencia", "usuario", "documento") and not n.desc:
            n.problems.append(("sin_descripcion", "No tiene descripción en el encabezado"))
        if n.type == "skill" and not n.desc:
            n.problems.append(("sin_descripcion", "La skill no tiene descripción"))
        if n.words < 15 and n.type != "indice":
            n.problems.append(("vacia", "Casi vacía (%d palabras)" % n.words))
        if n.type in ("proyecto", "documento"):
            # "vieja" = anuncia un plazo/reunión/lanzamiento que ya pasó y nadie la actualizó
            due = []
            low = fold(n.body)
            for m in date_re.finditer(low):
                ctx = low[max(0, m.start() - 60):m.start()]
                if not re.search(r"deadline|fecha limite|plazo|vence|hasta el|lanzamiento|launch|reunion|"
                                 r"meeting|entrega|demo day|pitch|cierre", ctx):
                    continue
                try:
                    due.append(datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
                except ValueError:
                    pass
            age = (time.time() - n.mtime) / 86400
            if due and max(due) < today - datetime.timedelta(days=21) and age > 21:
                n.problems.append(("vieja", "Quedó vieja: anuncia %s como fecha clave y no se actualiza hace %d días"
                                   % (max(due).isoformat(), age)))


# ---------------------------------------------------------------- armado final

def user_display_name(cfg, notes):
    if cfg.get("user_name"):
        return cfg["user_name"]
    for n in notes:
        if n.type == "usuario" and n.role == "memoria":
            first = re.split(r"[\s—\-–,:]+", n.title.strip())[0]
            if first and first[0].isupper() and first.isalpha():
                return first
    u = os.environ.get("USERNAME") or os.environ.get("USER") or "Tú"
    return u[:1].upper() + u[1:]


def build(cfg=None):
    t0 = time.time()
    cfg = cfg or load_config()
    notes, user, hkey = collect(cfg)
    uname = user_display_name(cfg, notes)
    groups = build_groups(notes, uname)
    for gi, g in enumerate(groups):
        for n in g["notes"]:
            n.group = gi
    # orden estable: por grupo y título
    notes.sort(key=lambda n: (n.group, n.type != "indice", fold(n.title)))
    idx_of = {n.id: i for i, n in enumerate(notes)}
    edges, _ = build_edges(notes, idx_of)
    find_other_problems(notes)

    deg = collections.Counter()
    for (a, b, t) in edges:
        if t != "comparte":
            deg[a] += 1
            deg[b] += 1

    type_ids = [t for t, _ in TYPE_ORDER]
    etype_ids = [e[0] for e in EDGE_TYPES]
    bonus = {"indice": 1.3, "usuario": 1.6, "instrucciones": 1.8, "plan": 0.6, "skill": 0.3}

    out_nodes, problems = [], []
    for i, n in enumerate(notes):
        imp = math.log2(1 + deg[i]) + bonus.get(n.type, 0)
        for p in n.problems:
            problems.append({"kind": p[0], "node": i, "msg": p[1], "other": p[2] if len(p) > 2 else None})
        out_nodes.append({
            "id": n.id, "t": n.title, "d": n.desc, "ty": type_ids.index(n.type), "g": n.group,
            "p": n.path, "pr": n.proj, "m": int(n.mtime), "w": n.words, "k": deg[i],
            "i": round(imp, 3), "pb": len(n.problems),
        })

    etype_count = collections.Counter(t for (_, _, t) in edges)
    type_count = collections.Counter(n.type for n in notes)
    region_groups = collections.defaultdict(list)
    for gi, g in enumerate(groups):
        region_groups[g["region"]].append(gi)
    regions = []
    for rid, (rname, theme) in REGIONS.items():
        gl = region_groups.get(rid, [])
        if not gl:
            continue
        th = theme or groups[gl[0]]["name"].split("·")[-1].strip().upper()
        regions.append({"id": rid, "name": rname, "theme": th, "groups": gl})

    homes = {}
    for i, n in enumerate(notes):
        if n.type == "indice" and n.proj_key:
            homes[n.proj_key] = i
    global_home = homes.get(hkey)

    graph = {
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "user": uname,
        "groups": [{"name": g["name"], "color": g["color"], "region": g["region"], "count": len(g["notes"])}
                   for g in groups],
        "regions": regions,
        "types": [{"id": t, "label": lbl, "count": type_count.get(t, 0)} for t, lbl in TYPE_ORDER
                  if type_count.get(t, 0)],
        "typeIds": type_ids,
        "edgeTypes": [{"id": e[0], "label": e[1], "style": e[2], "on": e[3], "help": e[4],
                       "count": etype_count.get(e[0], 0)} for e in EDGE_TYPES],
        "nodes": out_nodes,
        "edges": [[a, b, etype_ids.index(t), round(w, 3)] for (a, b, t), w in sorted(edges.items())],
        "problems": problems,
        "homes": homes,
        "globalHome": global_home,
        "buildMs": int((time.time() - t0) * 1000),
    }
    path_index = {n.npath: i for i, n in enumerate(notes)}
    dir_index = collections.defaultdict(list)
    for i, n in enumerate(notes):
        dir_index[n.dirpath].append(i)
    skill_index = {fold(n.title): i for i, n in enumerate(notes) if n.type == "skill"}
    return graph, {"paths": path_index, "dirs": dict(dir_index), "skills": skill_index,
                   "notes": notes, "homeKey": hkey}


def signature(cfg):
    cdir = cfg["claude_dir"]
    parts = []
    pats = [os.path.join(cdir, "projects", "*", "memory", "*.md"), os.path.join(cdir, "CLAUDE.md"),
            os.path.join(cdir, "plans", "*.md")]
    if cfg.get("include_skills", True):
        pats += [os.path.join(cdir, "skills", "*", "SKILL.md"), os.path.join(cdir, "skills", "*.md")]
    for pat in pats:
        for p in glob.glob(pat):
            try:
                st = os.stat(p)
                parts.append("%s|%d|%d" % (p, st.st_mtime_ns, st.st_size))
            except OSError:
                pass
    return hashlib.sha1("\n".join(sorted(parts)).encode("utf-8", "replace")).hexdigest()


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    g, extra = build()
    print("notas:", len(g["nodes"]), "conexiones:", len(g["edges"]), "problemas:", len(g["problems"]),
          "ms:", g["buildMs"])
    for gr in g["groups"]:
        print("  grupo:", gr["name"], gr["count"], gr["region"], gr["color"])
    print("  regiones:", [(r["name"], r["theme"]) for r in g["regions"]])
    print("  tipos:", [(t["label"], t["count"]) for t in g["types"]])
    print("  conexiones:", [(e["label"], e["count"]) for e in g["edgeTypes"]])
    print("  problemas por tipo:", collections.Counter(p["kind"] for p in g["problems"]))
