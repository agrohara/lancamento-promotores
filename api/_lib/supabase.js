// Helper compartilhado pelas tabelas já migradas para o Supabase (Postgres).
//
// O Supabase limita cada resposta a 1000 linhas por padrão (configuração do próprio
// projeto), mesmo pedindo um .range() maior — então uma tabela com mais de 1000 linhas
// (como o catálogo de produtos) sempre vem cortada numa única chamada. Esta função busca
// em blocos de 1000 e junta tudo, para o resto do código não precisar se preocupar com isso.

const { createClient } = require("@supabase/supabase-js");

function obterSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

const TAMANHO_BLOCO = 1000;

async function buscarTodasLinhas(supabase, nomeTabela, colunas, ordenarPor) {
  let todasLinhas = [];
  let inicio = 0;
  while (true) {
    let consulta = supabase.from(nomeTabela).select(colunas).range(inicio, inicio + TAMANHO_BLOCO - 1);
    if (ordenarPor) consulta = consulta.order(ordenarPor, { ascending: true });
    const { data, error } = await consulta;
    if (error) throw error;
    todasLinhas = todasLinhas.concat(data || []);
    if (!data || data.length < TAMANHO_BLOCO) break;
    inicio += TAMANHO_BLOCO;
  }
  return todasLinhas;
}

module.exports = { obterSupabase, buscarTodasLinhas };
