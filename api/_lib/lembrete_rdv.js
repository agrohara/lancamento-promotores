// Lembrete no celular do CONSULTOR: RDV da semana salvo como rascunho e ainda não enviado.
// Roda 1x por dia (Vercel Cron, 08:00 de Brasília) e avisa só quem tem rascunho de RDV, perto do prazo.
//
// Regra (ajuste aqui se o prazo mudar): o RDV da semana (segunda a sábado) deve ser ENVIADO até a
// segunda-feira seguinte, às 12:00 (Brasília). Avisos:
//   - sábado ........ "o prazo é segunda às 12h"      (2 dias antes)
//   - segunda ....... "hoje é o último dia"           (dia do prazo)
//   - terça ......... "o prazo venceu, envie hoje"    (1 dia depois)
// Só consultores com o aviso ativado no celular recebem (Perfil > "Ativar lembretes").
const PRAZO_DIAS_APOS_SEMANA = 7;   // segunda-feira seguinte à semana do RDV
const PRAZO_HORA = "12:00";
const AVISAR_EM = [-2, 0, 1];       // dias em relação ao prazo

let push = null; try { push = require("./push"); } catch (e) { push = null; }

const ms = (iso) => Date.parse(iso + "T00:00:00Z");
const paraIso = (t) => new Date(t).toISOString().slice(0, 10);
const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const hojeBrasil = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const NOMES_DIA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function mensagem(sol, deslocamento, prazoIso) {
  const semana = `${br(sol.periodo_ini)} a ${br(paraIso(ms(sol.periodo_ini) + 5 * 86400000))}`;
  const prazo = `${NOMES_DIA[new Date(prazoIso + "T00:00:00Z").getUTCDay()]} (${br(prazoIso)}) às ${PRAZO_HORA}`;
  if (deslocamento < 0) return { titulo: "RDV ainda em rascunho", corpo: `Seu RDV de ${semana} não foi enviado. Envie até ${prazo}.` };
  if (deslocamento === 0) return { titulo: "Último dia para enviar o RDV", corpo: `Seu RDV de ${semana} ainda está em rascunho. Envie até as ${PRAZO_HORA} de hoje.` };
  return { titulo: "RDV com prazo vencido", corpo: `Seu RDV de ${semana} continua em rascunho e o prazo (${prazo}) já passou. Envie hoje.` };
}

// opcoes.simular = true: só devolve quem seria avisado (não envia nada).
async function rodarLembretes(supabase, opcoes) {
  const simular = !!(opcoes && opcoes.simular);
  const hoje = (opcoes && opcoes.hoje) || hojeBrasil();
  const desde = paraIso(ms(hoje) - 30 * 86400000);
  const { data, error } = await supabase.from("solicitacoes_despesa").select("id,promotor_login,promotor_nome,periodo_ini,status,tipo")
    .eq("tipo", "RDV").eq("status", "rascunho").gte("periodo_ini", desde);
  if (error) throw error;
  const resultado = [];
  for (const sol of data || []) {
    if (!sol.periodo_ini) continue;
    const prazo = paraIso(ms(sol.periodo_ini) + PRAZO_DIAS_APOS_SEMANA * 86400000);
    const desloc = Math.round((ms(hoje) - ms(prazo)) / 86400000);
    if (!AVISAR_EM.includes(desloc)) continue;
    const aviso = { ...mensagem(sol, desloc, prazo), tag: "rdv-rascunho-" + sol.id, url: "/" };
    let enviados = 0;
    if (!simular && push && push.avisarUsuario) enviados = (await push.avisarUsuario(supabase, sol.promotor_login, aviso)).enviados || 0;
    resultado.push({ id: sol.id, consultor: sol.promotor_nome, semana: sol.periodo_ini, prazo, hoje, titulo: aviso.titulo, enviados });
  }
  return { hoje, avisados: resultado.length, itens: resultado, simulado: simular };
}

module.exports = { rodarLembretes };
