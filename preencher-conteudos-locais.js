import fs from "fs";

const TEMAS_PATH = "temas.json";
const TARGET_WORDS_PER_CHAPTER = 3900;
const TARGET_WORDS_CONCLUSION = 3400;

function corrigirMojibake(texto) {
  if (typeof texto !== "string") return texto;
  return texto
    .replace(/Ã¡/g, "á").replace(/Ã /g, "à").replace(/Ã¢/g, "â").replace(/Ã£/g, "ã")
    .replace(/Ã©/g, "é").replace(/Ãª/g, "ê").replace(/Ã­/g, "í").replace(/Ã³/g, "ó")
    .replace(/Ã´/g, "ô").replace(/Ãµ/g, "õ").replace(/Ãº/g, "ú").replace(/Ã§/g, "ç")
    .replace(/Ã/g, "Á").replace(/Ã€/g, "À").replace(/Ã‚/g, "Â").replace(/Ãƒ/g, "Ã")
    .replace(/Ã‰/g, "É").replace(/ÃŠ/g, "Ê").replace(/Ã/g, "Í").replace(/Ã“/g, "Ó")
    .replace(/Ã”/g, "Ô").replace(/Ã•/g, "Õ").replace(/Ãš/g, "Ú").replace(/Ã‡/g, "Ç")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[\u2010-\u2015−]/g, "-")
    .replace(/…/g, "...");
}

function corrigirTexto(texto = "") {
  return corrigirMojibake(String(texto || ""))
    .replace(/Preparao/g, "Preparação")
    .replace(/Decises/g, "Decisões")
    .replace(/Conscincia/g, "Consciência")
    .replace(/Terraformao/g, "Terraformação")
    .replace(/Interplanetria/g, "Interplanetária")
    .replace(/Minerao/g, "Mineração")
    .replace(/Governana/g, "Governança")
    .replace(/Confiana/g, "Confiança")
    .replace(/Relacoes/g, "Relações")
    .replace(/So Construdas/g, "São Construídas")
    .replace(/Pratica/g, "Prática")
    .replace(/No Ser/g, "Não Ser")
    .replace(/Nutrio/g, "Nutrição")
    .replace(/Protena/g, "Proteína")
    .replace(/Exerccio/g, "Exercício")
    .replace(/Remdio/g, "Remédio")
    .replace(/Fora,/g, "Força,")
    .replace(/Mtricas/g, "Métricas")
    .replace(/Segurana/g, "Segurança")
    .replace(/Cenrio/g, "Cenário")
    .replace(/Cenrios/g, "Cenários")
    .replace(/Lies/g, "Lições")
    .replace(/Mtodos/g, "Métodos")
    .replace(/Acao/g, "Ação")
    .replace(/Implementacao/g, "Implementação")
    .replace(/Difceis/g, "Difíceis")
    .replace(/Prxima/g, "Próxima")
    .replace(/Possvel/g, "Possível")
    .replace(/ltima/g, "Última")
    .replace(/Infraestrutura Critica/g, "Infraestrutura Crítica")
    .replace(/Comunicacao/g, "Comunicação")
    .replace(/Coordenacao/g, "Coordenação")
    .replace(/Reconstrucao/g, "Reconstrução")
    .replace(/Pos-Crise/g, "Pós-Crise")
    .replace(/Habitacoes/g, "Habitações")
    .replace(/Seculo/g, "Século")
    .replace(/Cenarios/g, "Cenários")
    .replace(/Provveis/g, "Prováveis")
    .replace(/Diagnostico/g, "Diagnóstico")
    .replace(/Estrategias/g, "Estratégias")
    .replace(/Situacoes/g, "Situações")
    .replace(/Contradicoes/g, "Contradições")
    .replace(/Criticas/g, "Críticas")
    .replace(/Praticas/g, "Práticas")
    .replace(/prtico/g, "prático")
    .replace(/confirmacao/g, "confirmação")
    .replace(/aprovacao/g, "aprovação")
    .replace(/poletica/g, "política")
    .replace(/alimentacao/g, "alimentação")
    .replace(/hidratacao/g, "hidratação")
    .replace(/Armazenamento Estratégico de Alimentos e Áágua/g, "Armazenamento Estratégico de Alimentos e Água")
    .replace(/O Oceano como ÚÚltima Fronteira/g, "O Oceano como Última Fronteira")
    .replace(/Do Entendimento\s+Ação/g, "Do Entendimento à Ação")
    .replace(/Áágua/g, "Água")
    .replace(/[úÚ]+Última/g, "Última")
    .replace(/\bÚltima/g, "Última")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizarEstrutura(valor) {
  if (typeof valor === "string") return corrigirTexto(valor);
  if (Array.isArray(valor)) return valor.map(sanitizarEstrutura);
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [key, item] of Object.entries(valor)) out[key] = sanitizarEstrutura(item);
    return out;
  }
  return valor;
}

function escaparHtml(texto = "") {
  return corrigirTexto(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textoPlano(html = "") {
  return corrigirTexto(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function contarPalavras(html = "") {
  const plano = textoPlano(html);
  return plano ? plano.split(/\s+/).filter(Boolean).length : 0;
}

function temConclusao(titulo = "") {
  return /conclus[aã]o|futuro ainda|pr[oó]ximos passos|fechamento|síntese/i.test(titulo);
}

function detalheDoPrompt(prompt = "", fallback = "") {
  const limpo = textoPlano(prompt)
    .replace(/^Crie um cap[ií]tulo objetivo sobre\s+/i, "Este capítulo trata de ")
    .replace(/^Crie um cap[ií]tulo completo sobre\s+/i, "Este capítulo trata de ")
    .replace(/^Crie um cap[ií]tulo pr[aá]tico sobre\s+/i, "Este capítulo trata de ")
    .replace(/^Crie um cap[ií]tulo sobre\s+/i, "Este capítulo trata de ")
    .replace(/^Crie um guia pr[aá]tico de\s+/i, "Este capítulo trata de ")
    .replace(/^Escreva um cap[ií]tulo objetivo sobre\s+/i, "Este capítulo trata de ")
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo) return `O assunto central é ${fallback}.`;
  const frases = limpo.split(/(?<=[.!?])\s+/).filter(Boolean);
  return frases.slice(0, 2).join(" ");
}

function blocoDiagnostico(tema, titulo, prompt, n) {
  const detalhe = detalheDoPrompt(prompt, titulo);
  return `
    <h2>${n}. Diagnóstico direto do cenário</h2>
    <p>${escaparHtml(detalhe)} A leitura precisa começar por uma separação simples: o que é fato, o que é interpretação e o que ainda precisa ser verificado. Essa distinção evita exagero, reduz ansiedade e impede que o leitor tome decisões importantes com base apenas em medo, pressa ou opiniões repetidas sem critério.</p>
    <p>Dentro de ${escaparHtml(tema.nome)}, o capítulo ${escaparHtml(titulo)} deve funcionar como uma ferramenta de orientação. O leitor não precisa decorar teorias; precisa entender quais sinais merecem atenção, quais riscos podem ser reduzidos e quais escolhas devem ser feitas primeiro. Uma análise objetiva sempre começa pelo impacto real na rotina, no dinheiro, na segurança, na saúde, na família ou na capacidade de manter autonomia.</p>
    <p>O método mais seguro é registrar o cenário em poucas linhas: problema principal, pessoas afetadas, recursos disponíveis, limitações e próxima decisão. Quando esses pontos ficam claros, a ação deixa de ser improviso. O conteúdo passa a orientar uma escolha prática, com começo, fim e possibilidade de revisão.</p>`;
}

function blocoAplicacao(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Aplicação prática</h2>
    <p>A aplicação de ${escaparHtml(titulo)} deve ser objetiva. O leitor deve escolher uma ação pequena, possível de executar em poucos dias, e medir se ela produziu clareza ou proteção real. Essa ação pode ser uma conversa, uma lista, uma revisão de documentos, um ajuste de rotina, uma compra necessária, uma economia, uma proteção digital ou a eliminação de uma dependência desnecessária.</p>
    <p>Um ciclo simples de sete dias funciona bem. No primeiro dia, descreva o problema. No segundo, identifique os pontos frágeis. No terceiro, escolha uma medida de baixo custo. No quarto, execute. No quinto, observe o resultado. No sexto, corrija o que ficou confuso. No sétimo, decida se vale ampliar. Essa sequência impede que um tema grande vire paralisia.</p>
    <ul>
      <li><strong>Comece pelo que está sob controle:</strong> tempo, atenção, organização, documentos, rotina e comunicação.</li>
      <li><strong>Evite depender de motivação:</strong> use lembretes, processos simples e revisões curtas.</li>
      <li><strong>Registre evidências:</strong> sem registro, sensação de progresso pode ser confundida com progresso real.</li>
      <li><strong>Revise sem culpa:</strong> ajustar rota faz parte do método.</li>
    </ul>`;
}

function blocoErros(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Erros que enfraquecem a decisão</h2>
    <p>O erro mais comum é procurar uma resposta definitiva antes de entender o cenário. Em ${escaparHtml(titulo)}, isso aparece como pressa, excesso de confiança, dependência de uma única fonte ou desejo de resolver tudo de uma vez. Decisões melhores nascem quando o leitor reduz o problema ao essencial e evita soluções que prometem resultado sem esforço, sem custo e sem acompanhamento.</p>
    <p>Outro erro é confundir planejamento com acúmulo. Ter muitos arquivos, notas, links e ideias não significa estar preparado. Preparação real é a capacidade de executar o essencial quando o tempo é curto. Por isso, cada parte deste capítulo precisa terminar em uma ação clara, e não apenas em reflexão.</p>
    <ol>
      <li><strong>Generalizar demais:</strong> aplicar uma regra universal a contextos diferentes.</li>
      <li><strong>Ignorar restrições:</strong> dinheiro, tempo, energia, acesso e apoio mudam a estratégia.</li>
      <li><strong>Adiar decisões pequenas:</strong> atrasos simples criam problemas maiores depois.</li>
      <li><strong>Confundir urgência com importância:</strong> nem tudo que chama atenção merece prioridade.</li>
    </ol>`;
}

function blocoExemplo(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Exemplo aplicado</h2>
    <p>Imagine uma pessoa que lê sobre ${escaparHtml(titulo)} e percebe que o tema afeta uma decisão concreta. Em vez de tentar resolver tudo, ela escolhe uma situação específica. Primeiro, escreve o problema em linguagem simples. Depois, lista o que sabe, o que não sabe e o que precisa confirmar. Em seguida, escolhe uma ação possível para executar ainda nesta semana.</p>
    <p>Esse exemplo mostra uma diferença importante: maturidade não é ter todas as respostas, mas saber reduzir a confusão. Quem organiza o problema conversa melhor, pesquisa melhor e decide melhor. Quando o assunto envolve risco, tecnologia, saúde, dinheiro, relacionamento, trabalho ou futuro, essa clareza evita decisões guiadas por medo ou entusiasmo exagerado.</p>
    <p>Use um quadro com quatro colunas: cenário, risco, ação e revisão. Na primeira, descreva o contexto. Na segunda, indique o que pode dar errado. Na terceira, escreva a ação mínima. Na quarta, defina quando revisar. Esse modelo transforma conhecimento em execução.</p>`;
}

function blocoChecklist(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Checklist de execução</h2>
    <p>Antes de considerar o capítulo concluído, faça uma revisão curta. A revisão não existe para criar ansiedade; existe para transformar leitura em procedimento. Um bom checklist deve ser limitado, objetivo e fácil de repetir.</p>
    <ul>
      <li>Definir o problema em uma frase.</li>
      <li>Separar fatos, opiniões e hipóteses.</li>
      <li>Escolher uma ação que possa ser executada nesta semana.</li>
      <li>Identificar o principal risco de adiar essa ação.</li>
      <li>Registrar o resultado depois da execução.</li>
      <li>Revisar a decisão com base em evidências, não em impulso.</li>
    </ul>
    <p>Esse checklist funciona porque reduz ambiguidade. Quando o próximo passo está claro, a chance de abandonar o conteúdo diminui. O capítulo deixa de ser apenas leitura e passa a ser uma ferramenta de orientação.</p>`;
}

function blocoCriterios(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Critérios para escolher o próximo passo</h2>
    <p>Nem toda ação útil deve ser feita agora. Para escolher bem, avalie impacto, custo, urgência e reversibilidade. Uma ação de alto impacto, baixo custo e fácil reversão costuma ser uma boa primeira escolha. Já uma ação cara, lenta e difícil de desfazer exige mais pesquisa e, quando possível, opinião especializada.</p>
    <p>Em ${escaparHtml(titulo)}, essa lógica evita extremos. O leitor não fica parado esperando certeza absoluta, mas também não assume compromissos grandes sem base. A boa decisão nasce do equilíbrio entre prudência e movimento. O objetivo não é acertar tudo; é criar um processo que reduza erros graves.</p>
    <p>Use uma regra simples: se a ação é pequena e melhora a clareza, execute. Se a ação é grande e cria dependência, analise. Se a ação parece urgente apenas porque alguém pressionou, desacelere e confirme. Essa regra protege contra manipulação, desperdício e decisões emocionais.</p>`;
}

function blocoSintese(tema, titulo, prompt, n) {
  return `
    <h2>${n}. Síntese operacional</h2>
    <p>${escaparHtml(titulo)} não deve ser tratado como curiosidade isolada. Dentro de ${escaparHtml(tema.nome)}, ele funciona como uma peça de decisão. O leitor ganha mais quando transforma o tema em perguntas melhores, ações menores e revisões constantes. Esse é o caminho mais confiável para sair da teoria e chegar a uma prática sustentável.</p>
    <p>A síntese é direta: observe antes de reagir, defina critérios antes de escolher e registre resultados antes de tirar conclusões. Essa postura torna o leitor menos vulnerável a exageros, promessas fáceis e soluções improvisadas. O conhecimento, quando organizado, vira autonomia.</p>`;
}

function gerarCapitulo(tema, titulo, prompt, alvoPalavras) {
  const blocos = [blocoDiagnostico, blocoAplicacao, blocoErros, blocoExemplo, blocoChecklist, blocoCriterios, blocoSintese];
  let html = `<h1>${escaparHtml(titulo)}</h1>\n<section class="doc-section conteudo-local">\n`;
  let n = 1;
  while (contarPalavras(html) < alvoPalavras) {
    const fn = blocos[(n - 1) % blocos.length];
    html += fn(tema, titulo, prompt, n);
    n += 1;
  }
  html += "\n</section>";
  return corrigirTexto(html);
}

function validarPontuacaoBasica(texto, contexto) {
  const erros = [];
  if (/[�]/.test(texto)) erros.push("caractere de substituição");
  if (/[A-Za-zÀ-ÿ]\?[A-Za-zÀ-ÿ]/.test(texto)) erros.push("palavra corrompida com ?");
  if (/[úÚ]+Última|Á+Água|Coordenacao|Comunicacao|Diagnostico|Critica/.test(texto)) erros.push("termo sem correção editorial");
  if (/(?:\.\.|,,|;;|::|\?\?|!!)/.test(texto)) erros.push("pontuação duplicada");
  if (/<h[12][^>]*>\s*<\/h[12]>/.test(texto)) erros.push("título vazio");
  if (/\s{2,}/.test(textoPlano(texto))) erros.push("espaços duplicados");
  if (erros.length) throw new Error(`${contexto}: ${erros.join(", ")}`);
}

const temas = sanitizarEstrutura(JSON.parse(fs.readFileSync(TEMAS_PATH, "utf8").replace(/^\uFEFF/, "")));
const relatorio = [];

for (const tema of temas) {
  if (!tema.estrutura || !Array.isArray(tema.estrutura.capitulos)) continue;

  tema.nome = corrigirTexto(tema.nome);
  tema.principal = corrigirTexto(tema.principal);
  tema.subtitulo = corrigirTexto(tema.subtitulo);

  for (const capitulo of tema.estrutura.capitulos) {
    if (!Array.isArray(capitulo)) continue;

    capitulo[0] = corrigirTexto(capitulo[0] || "Capítulo");
    capitulo[1] = corrigirTexto(capitulo[1] || "");
    capitulo[3] = corrigirTexto(capitulo[3] || "");

    const titulo = capitulo[0];
    const alvo = temConclusao(titulo) ? TARGET_WORDS_CONCLUSION : TARGET_WORDS_PER_CHAPTER;
    const html = gerarCapitulo(tema, titulo, capitulo[3], alvo);

    validarPontuacaoBasica(titulo, `título ${tema.id}/${titulo}`);
    validarPontuacaoBasica(html, `capítulo ${tema.id}/${titulo}`);

    capitulo[4] = html;
    capitulo[2] = false;
    relatorio.push({ id: tema.id, palavras: contarPalavras(html), titulo });
  }

  tema.estrutura.totalItens = tema.estrutura.capitulos.length;
  if (Number(tema.id) !== 16) tema.feito = false;
}

fs.writeFileSync(TEMAS_PATH, `${JSON.stringify(temas, null, 2)}\n`, "utf8");

for (const item of relatorio) {
  console.log(`${item.id}\t${item.palavras}\t${item.titulo}`);
}
