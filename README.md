# Cerebro de Claude

La memoria de tu Claude Code dibujada como un cerebro 3D que piensa en vivo, y que te habla.

https://github.com/user-attachments/assets/ff2ee8b3-0b48-4ca3-94c1-4be95b93c7d6

▶️ Activa el sonido: el cerebro habla. [Descargar el demo en 1080p](https://github.com/daybigo/Cerebro-Jarvis/raw/main/media/cerebro-demo.mp4)

Cada nota de memoria es una neurona. Los proyectos, las reglas, las referencias y las skills viven en distintos lóbulos. Cuando Claude lee, busca, edita o lanza agentes, lo ves recorrer el cerebro en tiempo real. Además puedes hablarle, pedirle que audite tu memoria y que la corrija.

Todo corre en tu PC: el servidor solo escucha en `127.0.0.1` y lee tu carpeta `~/.claude`.

## Qué hace

- **Cerebro 3D**: unas 20.000 neuronas en WebGL (corteza con surcos, cerebelo, tronco y tractos de fibras). Tus notas son neuronas piramidales de colores, y cada grupo vive en su lóbulo:

  | Lóbulo | Qué guarda |
  |---|---|
  | Temporal | Memoria |
  | Prefrontal | Reglas y feedback |
  | Frontal | Proyectos |
  | Parietal | Referencia |
  | Occipital | Lo visual |
  | Cerebelo | Skills |
  | Tronco | El resto |

- **Actividad en vivo**: lee los transcripts de Claude Code mientras trabaja, sin hooks ni configuración. Muestra cada sesión, cada subagente y lo que hace (lee, edita, busca, compila, commit, espera tu OK), con trayectorias de luz entre notas y los archivos que va programando.
- **Conexiones**:

  | Tipo | Qué significa |
  |---|---|
  | `[[wiki]]` | Links entre notas |
  | Índice | El `MEMORY.md` apunta a la nota |
  | Enlace | Link markdown a otra nota |
  | Mención | La nota nombra a otra sin linkearla |
  | Cadena | Notas nacidas en la misma conversación |
  | Parecida | Contenido parecido en el mismo grupo |
  | Sugerida | Hablan de lo mismo en grupos distintos: conviene linkearlas |

- **Problemas**: detecta links rotos, notas fuera del índice, sin descripción, repetidas o viejas.
- **Auditar memorias**: tu propio Claude Code (`claude -p`, sin claves extra) revisa todas tus memorias y te dice qué % están repetidas, corruptas o viejas, con el detalle de cada hallazgo.
- **Mejorar memoria**: Claude corrige esos archivos. Fusiona las repetidas, arregla encabezados y links, y marca las viejas. Antes hace un backup completo, y **Deshacer** restaura todo.
- **Voz**: le hablas al cerebro con el micrófono (o le escribes) y te contesta hablando. Busca las notas relevantes, las ilumina y responde en streaming con voz de Fish Audio. Cuando habla, se enciende el área de Broca.
- **Estados mentales**: trabajando, pensando, descansando y, si lo dejas quieto un rato, **soñando**: recorre sus propias conexiones.
- **Vistas**: grafo o lista, coloreado por grupo o por **uso** (qué notas lee más Claude). También tiene búsqueda (`/`), filtros, detalle de cada nota y tema claro.

## Requisitos

- Python 3.10 o superior. El cerebro no necesita dependencias.
- Claude Code instalado (el comando `claude`) para auditar y mejorar.
- Opcional, para la voz en vivo: `pip install -r requirements.txt`, que instala `websockets` y `msgpack`. Sin eso usa la API REST de Fish.
- Chrome o Edge para el micrófono.

## Instalación y uso

```bash
git clone https://github.com/daybigo/Cerebro-Jarvis.git
cd Cerebro-Jarvis
python server.py          # en Windows también sirve doble clic en Cerebro.bat
```

Se abre `http://127.0.0.1:7777`. Toca **Probar** para ver una sesión de prueba recorriendo tu cerebro. No toca ningún archivo.

## Voz (opcional)

El cerebro conversa con **tu propio Claude Code** (`claude -p`, sin API keys), y puede abrir tus memorias para contestar. La voz la pone Fish Audio.

1. Copia `.env.example` a `.env`.
2. Pon tu `FISH_API_KEY`. Si quieres otra voz, cambia `FISH_VOICE_ID`. Sin clave, el cerebro contesta por escrito.
3. Toca **Voz** y habla. El servidor relee `.env` solo, sin reiniciar.

`VOICE_CLAUDE_MODEL=sonnet` empieza a hablar en unos 2 a 5 segundos. También puedes usar `haiku` u `opus`.

## Configuración (`config.json`)

| Clave | Qué hace |
|---|---|
| `port` | Puerto (7777) |
| `user_name` | Tu nombre. Vacío = lo deduce de tu memoria |
| `include_skills` | Muestra tus skills en el cerebelo |
| `include_project_instructions` | También lee el `CLAUDE.md` de cada proyecto |
| `extra_roots` | Carpetas extra de notas `.md` para sumar al cerebro |
| `idle_rest_seconds` / `idle_dream_seconds` | Cuándo empieza a descansar o a soñar |
| `usage_days` | Cuántos días de transcripts mira para el modo **Uso** |

## Cómo funciona

```
~/.claude/projects/*/memory/*.md ─┐
~/.claude/skills/*/SKILL.md ──────┼─> scanner.py ─> grafo (notas, conexiones, problemas)
                                  │
~/.claude/projects/**/*.jsonl ────┴─> server.py ─> SSE en vivo ─> web/ (Three.js)
                                        │
                     voice.py ─> claude -p (texto) ─> Fish Audio (voz PCM en vivo)
                claude_jobs.py ─> claude -p (auditar / mejorar, con backup)
```

- `scanner.py` arma el grafo. Si cambia una memoria, el cerebro se rearma solo y la neurona nueva aparece con un destello.
- `server.py` es el servidor HTTP con la actividad en vivo, la voz y los trabajos de Claude. Solo usa la librería estándar.
- `speech.py` y `voice.py` son el sistema de voz: reglas de habla, indicaciones de tono (`[friendly]`, `[pause]`…), glosario de pronunciación y frases que se van mandando a Fish mientras Claude escribe.
- `web/` tiene la anatomía procedural (`anatomy.js`), la escena 3D (`brain.js`) y la interfaz (`app.js`).

## Grabar un demo

```bash
cd demo && npm install
node grabar.mjs           # graba cuadro por cuadro en headless y codifica con ffmpeg
```

El modo `?capture` avanza el reloj a mano, así el video sale perfecto a 30 fps aunque la PC sea lenta.

## Privacidad

- No se manda nada a internet salvo lo que tú actives: las respuestas y auditorías (tu Claude Code) y la voz (Fish Audio).
- `.env` (tus claves) y `.cache/` (auditorías, backups y uso de tus notas) están en `.gitignore` y nunca se suben.

## Créditos

- El sistema de voz (reglas de habla, indicaciones de tono y streaming a Fish) está adaptado de un asistente de voz personal del autor.
- 3D con [three.js](https://threejs.org) (MIT), incluido en `web/vendor`.

## Licencia

MIT. Ver [LICENSE](LICENSE).
