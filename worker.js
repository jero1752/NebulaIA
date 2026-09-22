// Cloudflare Worker — cerebro de tu IA
// Guarda tus claves como "secrets" en Cloudflare, nunca las pongas aquí en texto plano:
//   npx wrangler secret put GEMINI_API_KEY
//   npx wrangler secret put SEARCH_API_KEY   (opcional, Google Custom Search)
//   npx wrangler secret put SEARCH_CX        (opcional, ID del buscador personalizado)

const GEMINI_MODEL = "gemini-2.5-flash"; // capa gratuita generosa

export default {
  async fetch(request, env) {
    // CORS: permite que tu página de GitHub Pages llame a este worker
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // en producción, poné tu dominio de GitHub Pages
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Usá POST", { status: 405, headers: corsHeaders });
    }

    try {
      const { message, history, useSearch } = await request.json();

      if (!message || typeof message !== "string") {
        return json({ error: "Falta el campo 'message'" }, 400, corsHeaders);
      }

      // 1) Búsqueda opcional en Google (si el usuario activó "buscar en internet")
      let searchContext = "";
      if (useSearch && env.SEARCH_API_KEY && env.SEARCH_CX) {
        searchContext = await googleSearch(message, env);
      }

      // 2) Armar el historial de conversación para Gemini
      const contents = buildContents(history, message, searchContext);

      // 3) Llamar a Gemini
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
          }),
        }
      );

      const data = await geminiRes.json();

      if (!geminiRes.ok) {
        return json(
          { error: data?.error?.message || "Error llamando a Gemini" },
          502,
          corsHeaders
        );
      }

      const reply =
        data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
        "No obtuve respuesta del modelo.";

      return json({ reply }, 200, corsHeaders);
    } catch (err) {
      return json({ error: err.message }, 500, corsHeaders);
    }
  },
};

function buildContents(history, message, searchContext) {
  const contents = [];

  // Historial previo (array de {role: 'user'|'model', text: '...'})
  if (Array.isArray(history)) {
    for (const turn of history) {
      contents.push({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.text }],
      });
    }
  }

  const finalMessage = searchContext
    ? `Contexto de búsqueda web (usalo si es útil, y aclará que es info de internet):\n${searchContext}\n\nPregunta del usuario:\n${message}`
    : message;

  contents.push({ role: "user", parts: [{ text: finalMessage }] });
  return contents;
}

async function googleSearch(query, env) {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${env.SEARCH_API_KEY}&cx=${env.SEARCH_CX}&q=${encodeURIComponent(query)}&num=5`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.items) return "";
    return data.items
      .map((item, i) => `${i + 1}. ${item.title} — ${item.snippet} (${item.link})`)
      .join("\n");
  } catch {
    return "";
  }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
