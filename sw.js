/* Service Worker — PromotoresVet / Agro Hara Gestão de Campo
 *
 * FASE 1 (leitura, aqui): fazer o app ABRIR e CONSULTAR sem internet.
 * FASE 2 (gravação): a fila de envio offline (Visita, Pedido, Cadastro de fazenda,
 * Editar fazenda/pedido/visita) NÃO mora neste arquivo — mora no próprio index.html,
 * usando IndexedDB (módulo "enviarOuEnfileirar" / fila offline). Este service worker
 * só cuida de leitura; por isso o handler de "fetch" abaixo devolve cedo (return, sem
 * responder) para qualquer requisição que não seja GET — POST/PATCH vão direto pra
 * rede e, se falharem, é o JS da página (não este arquivo) que decide enfileirar.
 * Ver OFFLINE.md na documentação do projeto para a descrição completa das duas fases.
 *
 * NADA do comportamento atual muda quando há internet: toda chamada a /api/ continua
 * indo direto para a rede, como sempre foi. O cache só entra em cena quando a rede falha.
 *
 * O que é guardado:
 *   - o próprio app (index.html), o manifest e os ícones;
 *   - Chart.js e SheetJS, que hoje vêm de CDN e sem eles o gráfico e a exportação
 *     quebram offline. São guardados como resposta opaca (no-cors) — funcionam para
 *     executar, mas o navegador não deixa inspecionar o conteúdo. É o suficiente.
 *   - as últimas respostas de /api/propriedades e /api/produtos, que são listas de
 *     consulta. Se a rede cair, o app mostra a última lista conhecida em vez de vazio.
 *
 * O que NÃO é guardado, de propósito:
 *   - /api/login, /api/relatorios e qualquer POST/PATCH. Login precisa de rede, e
 *     relatório desatualizado servido como se fosse atual confundiria o gestor.
 *
 * Para publicar uma versão nova do app: troque VERSAO_CACHE. O service worker antigo
 * apaga os caches anteriores e assume no próximo carregamento. O index.html também
 * regrava sozinho a cópia offline a cada abertura com internet (ver seção 4 do
 * OFFLINE.md), então esquecer de trocar essa constante não deixa a cópia congelada —
 * mas trocar continua sendo o caminho correto.
 */

const VERSAO_CACHE = "agrohara-v4";
const CACHE_APP = VERSAO_CACHE + "-app";
const CACHE_DADOS = VERSAO_CACHE + "-dados";

// Arquivos do próprio app — se algum falhar, a instalação continua (ver install).
const ARQUIVOS_APP = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icone-192.png",
  "/icone-512.png"
];

// Bibliotecas externas usadas pelo index.html. Mantidas nas mesmas URLs de CDN que já
// estão no HTML — não foi preciso mexer no HTML para isso.
const ARQUIVOS_CDN = [
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];

// Respostas de API que vale guardar como "última lista conhecida".
const APIS_CONSULTA = ["/api/propriedades", "/api/produtos"];

self.addEventListener("install", (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);

    // Um a um, com catch: se um arquivo falhar (rede instável no momento da instalação),
    // o service worker ainda instala com o resto. Com cache.addAll(), um erro só
    // derrubaria a instalação inteira.
    await Promise.all(ARQUIVOS_APP.map(async (url) => {
      try { await cache.add(new Request(url, { cache: "reload" })); }
      catch (err) { console.warn("[sw] não consegui guardar", url, err); }
    }));

    await Promise.all(ARQUIVOS_CDN.map(async (url) => {
      try {
        const resp = await fetch(url, { mode: "no-cors" });
        await cache.put(url, resp);
      } catch (err) { console.warn("[sw] não consegui guardar a biblioteca", url, err); }
    }));

    // Assume o controle já no primeiro carregamento, sem esperar o usuário fechar a aba.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(
      nomes.filter(n => !n.startsWith(VERSAO_CACHE)).map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function ehApiDeConsulta(url) {
  return APIS_CONSULTA.some(rota => url.pathname === rota);
}

self.addEventListener("fetch", (evento) => {
  const req = evento.request;

  // Só GET passa pelo cache. POST e PATCH (enviar/editar pedido, visita, fazenda,
  // salvar localização) vão sempre direto para a rede — a fila offline (Fase 2) mora
  // no index.html (IndexedDB), não aqui.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // --- Chamadas de API ---
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    if (!ehApiDeConsulta(url)) return; // login, relatórios etc: rede e ponto final.

    evento.respondWith((async () => {
      try {
        // Rede primeiro: com internet, o comportamento é idêntico ao de hoje.
        const resp = await fetch(req);
        if (resp && resp.ok) {
          const cache = await caches.open(CACHE_DADOS);
          cache.put(req, resp.clone());
        }
        return resp;
      } catch (err) {
        // Sem rede: devolve a última lista conhecida, se houver.
        const guardada = await caches.match(req);
        if (guardada) return guardada;
        return new Response(
          JSON.stringify({ erro: "Sem conexão e sem dados guardados neste aparelho para essa lista." }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
    })());
    return;
  }

  // --- Navegação (abrir o app) ---
  // Rede primeiro para sempre pegar a versão publicada mais nova; se falhar, serve o
  // index.html guardado. É isso que faz o app abrir offline.
  if (req.mode === "navigate") {
    evento.respondWith((async () => {
      try {
        // cache: "no-store" força ignorar qualquer cache HTTP intermediário (do
        // navegador ou da CDN) e buscar sempre a resposta mais nova direto do
        // servidor. Sem isto, mesmo com internet, o navegador podia devolver uma
        // cópia de index.html guardada no cache HTTP comum (não no cache deste
        // service worker) depois de um novo deploy — o app parecia "não atualizar"
        // mesmo com o arquivo certo já publicado no GitHub/Vercel.
        const resp = await fetch(req, { cache: "no-store" });
        // Toda abertura com internet REGRAVA a cópia offline. Sem isto, a cópia
        // guardada congela na versão do dia da instalação: online o promotor veria
        // o app novo e offline o antigo, silenciosamente. Foi o que aconteceu entre
        // a fase 1 e a fase 2.
        if (resp && resp.ok) {
          const cache = await caches.open(CACHE_APP);
          cache.put("/index.html", resp.clone());
          cache.put("/", resp.clone());
        }
        return resp;
      } catch (err) {
        const cache = await caches.open(CACHE_APP);
        return (await cache.match("/index.html")) || (await cache.match("/")) || Response.error();
      }
    })());
    return;
  }

  // --- Estáticos e bibliotecas ---
  // Cache primeiro (não mudam), com a rede como reserva e atualização em segundo plano.
  evento.respondWith((async () => {
    const guardado = await caches.match(req);
    if (guardado) return guardado;
    try {
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === "opaque")) {
        const cache = await caches.open(CACHE_APP);
        cache.put(req, resp.clone());
      }
      return resp;
    } catch (err) {
      return Response.error();
    }
  })());
});
