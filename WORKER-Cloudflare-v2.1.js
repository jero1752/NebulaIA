// NebulaIA Worker v2
// Secrets in Cloudflare: GEMINI_API_KEY (required), optional SEARCH_API_KEY + SEARCH_CX,
// optional OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY.
// The frontend never receives these keys.

const DEFAULT_MODEL = "gemini-3.6-flash";
const MAX_HISTORY = 8;
const MAX_CONTEXT_CHARS = 28000;

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("Usá POST", { status: 405, headers: cors });

    try {
      const body = await request.json();
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return json({ error: "Falta el campo 'message'" }, 400, cors);

      const history = normalizeHistory(body.history);
      const fileContext = trimText(typeof body.fileContext === "string" ? body.fileContext : "", MAX_CONTEXT_CHARS);
      const useSearch = Boolean(body.useSearch);
      const requestedProvider = typeof body.provider === "string" ? body.provider : "auto";
      const searchContext = useSearch && env.SEARCH_API_KEY && env.SEARCH_CX ? await googleSearch(message, env) : "";
      const prompt = buildPrompt(message, fileContext, searchContext);
      const provider = chooseProvider(requestedProvider, env);

      const result = await callWithRecovery(provider, prompt, history, env);
      return json({ reply: result.reply, provider: result.provider, recovered: result.recovered }, 200, cors);
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status <= 599 ? err.status : 500;
      return json({ error: friendlyError(err), provider: err?.provider || null, recoveryFailed: true }, status, cors);
    }
  }
};

async function callWithRecovery(provider, prompt, history, env) {
  const candidates = provider === "auto"
    ? ["gemini", "openai", "anthropic", "xai"]
    : [provider];

  let lastError = null;
  let attempted = 0;

  for (const candidate of candidates) {
    if (!hasProviderKey(candidate, env)) continue;
    attempted++;
    try {
      const reply = candidate === "gemini"
        ? await callGemini(prompt, history, env)
        : candidate === "openai"
          ? await callOpenAI(prompt, history, env)
          : candidate === "anthropic"
            ? await callAnthropic(prompt, history, env)
            : await callXAI(prompt, history, env);

      return { reply, provider: candidate, recovered: attempted > 1 };
    } catch (err) {
      lastError = err;
      // In Auto mode, move to the next configured provider after a transient/provider failure.
      // In an explicitly selected provider, preserve the error so the user knows what failed.
      if (provider !== "auto") break;
    }
  }

  if (lastError) throw lastError;
  throw new Error("No hay ningún proveedor configurado. Agregá GEMINI_API_KEY en Cloudflare.");
}

function hasProviderKey(provider, env) {
  if (provider === "gemini") return Boolean(env.GEMINI_API_KEY);
  if (provider === "openai") return Boolean(env.OPENAI_API_KEY);
  if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
  if (provider === "xai") return Boolean(env.XAI_API_KEY);
  return false;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.filter(x => x && (x.role === "user" || x.role === "assistant") && typeof x.text === "string")
    .slice(-MAX_HISTORY).map(x => ({ role: x.role, text: trimText(x.text, 6000) }));
}

function buildPrompt(message, fileContext, searchContext) {
  const parts = [
    "Sos NebulaIA, un asistente rápido y útil. Respondé en español salvo que el usuario pida otro idioma.",
    "Priorizá exactitud, claridad y respuestas completas sin relleno. Si falta información, decilo en vez de inventarla.",
    "Si el usuario trabaja con un archivo, distinguí entre contenido del archivo y tus propias inferencias.",
    fileContext ? `\nCONTENIDO DE ARCHIVOS ADJUNTOS:\n${fileContext}` : "",
    searchContext ? `\nRESULTADOS DE INTERNET:\n${searchContext}\nUsalos como contexto y no inventes fuentes.` : "",
    `\nSOLICITUD DEL USUARIO:\n${message}`
  ];
  return parts.filter(Boolean).join("\n");
}

function chooseProvider(requested, env) {
  if (requested === "gemini" && env.GEMINI_API_KEY) return "gemini";
  if (requested === "openai" && env.OPENAI_API_KEY) return "openai";
  if (requested === "anthropic" && env.ANTHROPIC_API_KEY) return "anthropic";
  if (requested === "xai" && env.XAI_API_KEY) return "xai";
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.XAI_API_KEY) return "xai";
  throw new Error("No hay ninguna API configurada. Agregá GEMINI_API_KEY en Cloudflare.");
}

function geminiContents(history, prompt) {
  return [
    ...history.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: prompt }] }
  ];
}

async function callGemini(prompt, history, env) {
  const primary = env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallback = env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
  const models = [...new Set([primary, fallback])];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const result = await callGeminiModel(model, prompt, history, env);
    if (result.ok) return result.reply;

    lastError = result.error;
    // 503/429/408/5xx are transient. Retry the same model before switching.
    if (isRetryableStatus(result.status)) {
      const retries = Number(env.GEMINI_RETRIES || 2);
      for (let attempt = 0; attempt < retries; attempt++) {
        await sleep(backoffMs(attempt));
        const retry = await callGeminiModel(model, prompt, history, env);
        if (retry.ok) return retry.reply;
        lastError = retry.error;
        if (!isRetryableStatus(retry.status)) break;
      }
    }

    // If the main model is overloaded, immediately try the low-latency fallback.
    // If the fallback also fails, the caller can move to another configured provider.
  }

  throw new ProviderError(lastError?.message || "Gemini no está disponible en este momento.", lastError?.status || 503, "gemini");
}

async function callGeminiModel(model, prompt, history, env) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: geminiContents(history, prompt),
        generationConfig: { maxOutputTokens: 3072 }
      })
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, status: res.status, error: new Error(data?.error?.message || `Gemini ${res.status}`) };
    }
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");
    if (!reply) return { ok: false, status: 502, error: new Error("Gemini no devolvió contenido.") };
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, status: 503, error: err };
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function backoffMs(attempt) {
  const base = 700 * (2 ** attempt);
  return Math.min(base + Math.floor(Math.random() * 350), 5000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ProviderError extends Error {
  constructor(message, status, provider) {
    super(message);
    this.status = status;
    this.provider = provider;
  }
}

async function callOpenAI(prompt, history, env) {
  const messages = [{ role: "system", content: "Sos NebulaIA. Respondé en español salvo indicación contraria. Sé preciso y completo." }, ...history.map(t => ({ role: t.role, content: t.text })), { role: "user", content: prompt }];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-5.6-mini", messages, max_tokens: 3072 })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Error llamando a OpenAI");
  return data?.choices?.[0]?.message?.content || "No obtuve respuesta.";
}

async function callAnthropic(prompt, history, env) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5", max_tokens: 3072, system: "Sos NebulaIA. Respondé en español salvo indicación contraria.", messages: [...history.map(t => ({ role: t.role, content: t.text })), { role: "user", content: prompt }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Error llamando a Anthropic");
  return data?.content?.map(x => x.text || "").join("") || "No obtuve respuesta.";
}

async function callXAI(prompt, history, env) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify({ model: env.XAI_MODEL || "grok-4", messages: [{ role: "system", content: "Sos NebulaIA. Respondé en español salvo indicación contraria." }, ...history.map(t => ({ role: t.role, content: t.text })), { role: "user", content: prompt }], max_tokens: 3072 })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Error llamando a xAI");
  return data?.choices?.[0]?.message?.content || "No obtuve respuesta.";
}

async function googleSearch(query, env) {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${env.SEARCH_API_KEY}&cx=${env.SEARCH_CX}&q=${encodeURIComponent(query)}&num=5`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.items) return "";
    return data.items.map((x, i) => `${i + 1}. ${x.title}\n${x.snippet}\n${x.link}`).join("\n\n");
  } catch { return ""; }
}

function trimText(text, max) { return text.length <= max ? text : text.slice(0, max) + "\n[Contenido recortado para ahorrar tokens]"; }
function friendlyError(err) { return String(err?.message || err).replace(/AIza[\w-]+/g, "[API_KEY_OCULTA]"); }
function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } }); }
