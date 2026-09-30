"""Texto hablable para Fish Audio: separa lo legible, las indicaciones de interpretación
([friendly], [pause]...) y el glosario de pronunciación para que la voz suene natural."""
import re
import unicodedata

DEFAULT_PRONUNCIATIONS = """vibecoding = V AY1 B / K OW1 D IH0 NG
vibe coding = V AY1 B / K OW1 D IH0 NG
Claude = K L AO1 D
Claude Code = K L AO1 D / K OW1 D
framework = F R EY1 M W ER2 K
backend = B AE1 K EH2 N D
frontend = F R AH1 N T EH2 N D
workflow = W ER1 K F L OW2
prompt = P R AA1 M P T
prompts = P R AA1 M P T S
Python = P AY1 TH AA0 N
streaming = S T R IY1 M IH0 NG
startup = S T AA1 R T AH2 P
feedback = F IY1 D B AE2 K
software = S AO1 F T W EH2 R
skills = S K IH1 L Z
skill = S K IH1 L"""

MOODS = {"calm", "confident", "curious", "relaxed", "empathetic", "satisfied", "happy", "hopeful", "uncertain", "grateful",
         "soft tone", "excited", "whispering", "breathy", "friendly", "warm and happy", "slightly excited", "determined", "relieved"}
ACCENTS = {"emphasis", "chuckling", "laughing", "sighing", "break", "long-break", "clear throat"}
ALL_CUES = MOODS | ACCENTS | set(
    "sad angry nervous surprised delighted scared worried upset frustrated moved proud sarcastic unhappy anxious "
    "doubtful confused disappointed optimistic nostalgic sympathetic compassionate".split())
CUE_ALIASES = {"soft": "soft tone", "pause": "break", "long pause": "long-break", "laughs": "laughing"}
SOUND_CUES = {"laughing", "chuckling", "sighing", "clear throat"}
CUE = re.compile(r"\[([^\]\n]{1,60})\]")
PHONES = set("AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH".split())
VOWELS = set("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())

CONVERSATION_RULES = """
Contrato de conversación hablada (prioritario sobre preferencias de formato):
Contesta en texto plano natural: sin Markdown, títulos, listas, viñetas, tablas,
asteriscos, emojis ni iconos. Nunca envíes bloques de código al sintetizador.
Elige la extensión según lo que la pregunta necesita: una confirmación puede ser
una frase; una explicación, dos o tres párrafos hablables con transiciones naturales.
No añadas relleno ni repitas conclusiones. Habla español y conserva nombres y
términos ingleses con su ortografía original. No escribas pronunciaciones
castellanizadas ni fonemas: la app prepara la pronunciación.
"""

EXPRESSION_RULES = """
Interpreta cada respuesta como conversación, no como lectura uniforme.
Elige UNA indicación inicial entre corchetes: [friendly] o [relaxed] para charla,
[curious] para una pregunta genuina, [confident] para recomendaciones,
[satisfied] ante un logro, [empathetic] o [soft] para apoyo, [uncertain] si dudas,
[determined] al proponer acción. Puedes añadir UN efecto: [emphasis] antes de una
idea importante o [pause] antes de una revelación. Máximo un tono y un efecto.
"""


def canonical_cue(value):
    value = re.sub(r"\s+", " ", value.strip().lower())
    return CUE_ALIASES.get(value, value)


def sent_cues(text):
    return [canonical_cue(m[1]) for m in CUE.finditer(text) if canonical_cue(m[1]) in ALL_CUES]


def parse_pronunciations(value):
    result = {}
    for line in value.splitlines():
        if not line.strip():
            continue
        term, sep, pron = line.partition("=")
        term = term.strip()
        if not sep or not term:
            continue
        words = pron.upper().strip().split("/")
        ok = True
        for word in words:
            for token in word.split():
                base = token.rstrip("012")
                if base not in PHONES or (token != base and base not in VOWELS):
                    ok = False
        if ok:
            result[term.casefold()] = " ".join(
                "<|phoneme_start|>" + " ".join(w.split()) + "<|phoneme_end|>" for w in words)
    return result


def plain_text(text, partial=False):
    text = re.sub(r"<\|phoneme_start\|>.*?(?:<\|phoneme_end\|>|$)", "", text, flags=re.S)
    text = re.sub(r"```.*?(?:```|$)", "", text, flags=re.S)
    text = re.sub(r"!?\[([^\]\n]+)\]\([^)]*\)", r"\1", text)
    text = CUE.sub(lambda m: "" if canonical_cue(m[1]) in ALL_CUES else m[1], text)
    if partial:
        text = re.sub(r"\[[^\]]*$|<[^>]*$", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"(?m)^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+)", "", text)
    text = re.sub(r"https?://\S+", "enlace", text)
    text = re.sub(r"[*`_~|]", "", text)
    text = "".join(c for c in text if not (unicodedata.category(c) in {"So", "Cf"} or 0x1F000 <= ord(c) <= 0x1FAFF))
    return re.sub(r"\s+", " ", text).strip()


class SpeechRenderer:
    def __init__(self, pronunciations=DEFAULT_PRONUNCIATIONS, expressive=True, automatic=True):
        self.glossary = parse_pronunciations(pronunciations)
        self.pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(t) for t in sorted(self.glossary, key=len, reverse=True))
                                  + r")(?!\w)", re.I) if self.glossary else None
        self.expressive = expressive
        self.automatic = automatic
        self.mood_used = self.accent_used = False
        self.pending = ""

    def render(self, text):
        text = re.sub(r"```.*?(?:```|$)", "", text, flags=re.S)
        text = self.pending + text
        self.pending = ""
        if not plain_text(text):
            self.pending = " ".join("[%s]" % c for c in sent_cues(text)) + " "
            return ""
        parts, start = [], 0
        for m in CUE.finditer(text):
            cue = canonical_cue(m[1])
            if cue not in ALL_CUES:
                continue
            parts.append(plain_text(text[start:m.start()]))
            if self.expressive and cue in MOODS and not self.mood_used:
                parts.append("[%s]" % cue)
                self.mood_used = True
            elif self.expressive and cue in ACCENTS and not self.accent_used:
                parts.append("[%s]" % cue)
                self.accent_used = True
            start = m.end()
        parts.append(plain_text(text[start:]))
        result = " ".join(p for p in parts if p)
        if self.pattern:
            result = self.pattern.sub(lambda m: self.glossary[m[0].casefold()], result)
        return result


class PhraseBuffer:
    """Corta el texto que llega del modelo en frases hablables sin romper palabras ni links."""

    def __init__(self):
        self.text = ""
        self.started = False

    def feed(self, delta, final=False):
        self.text += delta
        out = []
        while self.text:
            boundary = None
            for m in re.finditer(r"[.!?;:,]\s+|\n+|\s+", self.text):
                prefix = self.text[:m.end()]
                if prefix.count("[") != prefix.count("]") or prefix.count("(") != prefix.count(")") or prefix.count("```") % 2:
                    continue
                strong = m[0][0] in ".!?\n"
                clause = m[0][0] in ";:," and len(plain_text(prefix)) >= 55
                if strong or clause or len(prefix) >= (220 if self.started else 110):
                    boundary = m.end()
                    break
            if boundary is None:
                if final:
                    out.append(self.text)
                    self.text = ""
                break
            out.append(self.text[:boundary])
            self.started = True
            self.text = self.text[boundary:]
        return out
