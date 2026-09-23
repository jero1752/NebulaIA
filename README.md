# NebulaIA v2.1

## Frontend
Subí el contenido de esta carpeta a GitHub Pages. El frontend ya apunta al Worker:
`https://nebula.jeronimocaroalfonso3.workers.dev`

## Worker
Subí `worker.js` al Worker de Cloudflare o reemplazá su código por este archivo.

### Secrets
Obligatorio:
- `GEMINI_API_KEY`

Opcionales:
- `SEARCH_API_KEY`
- `SEARCH_CX`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`

Modelos opcionales por variables de entorno:
- `GEMINI_MODEL` (por defecto `gemini-3.6-flash`)
- `OPENAI_MODEL`
- `ANTHROPIC_MODEL`
- `XAI_MODEL`

## Qué incluye
- Chat con historial compacto para ahorrar tokens.
- Selector Auto / Gemini / OpenAI / Claude / Grok.
- Búsqueda web mediante Google Custom Search cuando las claves existen.
- Centro de archivos local.
- Extracción directa de TXT/MD/CSV/JSON.
- Contexto de archivos enviado al modelo con límite para controlar tokens.
- Generación de documentos desde instrucciones.
- Exportación TXT, Markdown, JSON y DOCX.
- PWA y caché actualizable.

## Importante
Las integraciones OpenAI/Anthropic/xAI son opcionales y requieren sus propias claves. Sin esas claves, Auto usa Gemini.
El MVP conserva los archivos en el navegador y no intenta subirlos a un servidor por separado. PDF/DOCX/XLSX quedan registrados pero su extracción completa requiere incorporar lectores específicos; el texto plano sí se procesa directamente.


## Recuperación automática v2.1

- Gemini usa `gemini-3.6-flash` por defecto.
- Si Gemini devuelve 408, 429 o 5xx, el Worker aplica reintentos con backoff exponencial y jitter.
- Si Gemini continúa ocupado, cambia a `GEMINI_FALLBACK_MODEL`, cuyo valor predeterminado es `gemini-3.5-flash-lite`.
- En modo `Auto`, si todos los caminos de Gemini fallan y existen claves configuradas, intenta OpenAI, Anthropic y xAI en ese orden.
- No se reintentan errores de cliente como 400/401/403, para no ocultar errores de configuración.
- Podés ajustar `GEMINI_RETRIES` como variable del Worker; por defecto son 2 reintentos por modelo.

### Variables nuevas opcionales
- `GEMINI_FALLBACK_MODEL` → por defecto `gemini-3.5-flash-lite`
- `GEMINI_RETRIES` → por defecto `2`

La recuperación sigue la recomendación oficial de Gemini de usar exponential backoff para errores transitorios como 429 y 503.
