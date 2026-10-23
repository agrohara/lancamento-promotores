/* Service Worker — PromotoresVet / Agro Hara Gestão de Campo (v5, 23/10/2026)
 * Faz o app ABRIR e CONSULTAR sem internet (a fila de envio offline mora no index.html — ver OFFLINE.md).
 * Mudanças da v5: abertura com limite de 4 s (Wi-Fi sem internet não trava mais a tela), cópia
 * offline também do gestor.html e reserva que ignora ?parametros (ex.: /?app=1).
 * Só GET passa por aqui; login, relatórios e metas vão sempre direto para a rede.
 * Ao publicar versão nova do app, troque VERSAO_CACHE. */
const VERSAO_CACHE = "agrohara-v5";
const CACHE_APP = VERSAO_CACHE + "-app";
const CACHE_DADOS = VERSAO_CACHE + "-dados";
const ARQUIVOS_APP = ["/", "/index.html", "/manifest.json", "/icone-192.png", "/icone-512.png"];
const ARQUIVOS_CDN = [
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];
const APIS_CONSULTA = ["/api/propriedades", "/api/produtos"];
self.addEventListener("install", (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    await Promise.all(ARQUIVOS_APP.map(async (url) => {
      try { await cache.add(new Request(url, { cache: "reload" })); }
      catch (err) { console.warn("[sw] não consegui guardar", url, err); }
    }));
    await Promise.all(ARQUIVOS_CDN.map(async (url) => {
      try { const resp = await fetch(url, { mode: "no-cors" }); await cache.put(url, resp); }
      catch (err) { console.warn("[sw] não consegui guardar a biblioteca", url, err); }
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => !n.startsWith(VERSAO_CACHE)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});
function ehApiDeConsulta(url) { return APIS_CONSULTA.some(rota => url.pathname === rota); }
self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    if (!ehApiDeConsulta(url)) return;
    evento.respondWith((async () => {
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) { const cache = await caches.open(CACHE_DADOS); cache.put(req, resp.clone()); }
        return resp;
      } catch (err) {
        const guardada = await caches.match(req);
        if (guardada) return guardada;
        return new Response(JSON.stringify({ erro: "Sem conexão e sem dados guardados neste aparelho para essa lista." }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }
  if (req.mode === "navigate") {
    evento.respondWith((async () => {
      const cache = await caches.open(CACHE_APP);
      // Reserva offline: a própria página (se já foi aberta) ou o app (index.html). O
      // parâmetro ?app=1 etc. não importa (ignoreSearch).
      const reserva = async () =>
        (await cache.match(url.pathname, { ignoreSearch: true })) ||
        (url.pathname === "/gestor.html" ? null : ((await cache.match("/index.html")) || (await cache.match("/")))) ||
        Response.error();
      const buscar = fetch(req, { cache: "no-store" }).then((resp) => {
        if (resp && resp.ok) {
          // Toda abertura com internet regrava a cópia offline.
          if (url.pathname === "/" || url.pathname === "/index.html") {
            cache.put("/index.html", resp.clone());
            cache.put("/", resp.clone());
          } else if (url.pathname === "/gestor.html") {
            cache.put("/gestor.html", resp.clone());
          }
        }
        return resp;
      });
      // Sem rede de verdade (modo avião) o fetch falha na hora. Com Wi-Fi "pendurado" (sinal
      // sem internet) ele pode demorar minutos: depois de 4 s abre a cópia guardada e a
      // atualização termina em segundo plano.
      try {
        return await Promise.race([
          buscar,
          new Promise((_, rej) => setTimeout(() => rej(new Error("lento")), 4000))
        ]);
      } catch (err) {
        buscar.catch(() => {});
        return reserva();
      }
    })());
    return;
  }
  if (url.hostname.endsWith(".supabase.co")) return;
  evento.respondWith((async () => {
    const guardado = await caches.match(req) || await caches.match(req, { ignoreSearch: true });
    if (guardado) return guardado;
    try {
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === "opaque")) { const cache = await caches.open(CACHE_APP); cache.put(req, resp.clone()); }
      return resp;
    } catch (err) { return Response.error(); }
  })());
});
