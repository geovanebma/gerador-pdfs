import fs from "fs";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { Groq } from 'groq-sdk';
import path from "path";
import axios from "axios";
import { PDFDocument, rgb } from 'pdf-lib';
import { HfInference } from "@huggingface/inference";

dotenv.config();

const GROQ_KEY = process.env.GROQ_API_KEY;
const HF_TOKEN = process.env.HF_TOKEN;
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY;
const MINIMO_PAGINAS_EBOOK = 100;
const MINIMO_PALAVRAS_CAPITULO = 2600;
const MAX_TENTATIVAS_COMPLEMENTO_CAPITULO = 5;
const MAX_PALAVRAS_CONTEXTO_COMPLEMENTO = 420;
const MAX_PALAVRAS_ULTIMO_TRECHO = 220;
const MAX_RETRIES_GROQ = 5;
const MAX_RODADAS_REFORCO_PAGINAS = 4;
const REFORCAR_PAGINAS_COM_IA = process.env.REFORCAR_PAGINAS_COM_IA === 'true';

if (!GROQ_KEY) {
    console.error("❌ ERRO FATAL: A variável GROQ_API_KEY (Groq) não foi encontrada no arquivo .env!");
    process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_KEY });

function aguardar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function erroGroqLimite(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const mensagem = String(error?.message || '');
    return status === 413 || status === 429 || /rate_limit|tokens per minute|request too large|TPM/i.test(mensagem);
}

function extrairEsperaGroq(error, tentativa) {
    const retryAfter = error?.headers?.['retry-after'] || error?.response?.headers?.['retry-after'];
    const segundos = Number(retryAfter);
    if (Number.isFinite(segundos) && segundos > 0) return (segundos + 5) * 1000;

    return Math.min(120000, (20 + tentativa * 20) * 1000);
}

async function chamarGroqTexto(prompt, options = {}) {
    const {
        temperature = 0.7,
        maxCompletionTokens = 2200,
        origem = "groq"
    } = options;

    for (let tentativa = 1; tentativa <= MAX_RETRIES_GROQ; tentativa++) {
        try {
            const response = await groq.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: [{ role: "user", content: prompt }],
                temperature,
                max_completion_tokens: maxCompletionTokens
            });

            return sanitizarTexto(response.choices[0].message.content.replace(/```html|```|```json|```/g, "").trim());
        } catch (error) {
            if (!erroGroqLimite(error) || tentativa === MAX_RETRIES_GROQ) {
                throw error;
            }

            const espera = extrairEsperaGroq(error, tentativa);
            console.warn(`⏳ Limite Groq em ${origem}. Tentativa ${tentativa}/${MAX_RETRIES_GROQ}. Aguardando ${Math.round(espera / 1000)}s...`);
            await aguardar(espera);
        }
    }

    throw new Error(`Falha ao chamar Groq em ${origem}`);
}

function pareceMojibake(texto) {
    if (typeof texto !== 'string' || !texto) return false;
    return /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF\u20AC\u201A-\u201E]|�)/u.test(texto);
}

function tentarCorrigirMojibake(texto) {
    if (!pareceMojibake(texto)) return texto;

    try {
        const corrigido = Buffer.from(texto, 'latin1').toString('utf8');
        if (!pareceMojibake(corrigido)) return corrigido;
    } catch {
        // Continua para correção pontual abaixo.
    }

    const mapaMojibake = {
        '\u00C3\u00A1': 'á',
        '\u00C3\u00A0': 'à',
        '\u00C3\u00A2': 'â',
        '\u00C3\u00A3': 'ã',
        '\u00C3\u00A9': 'é',
        '\u00C3\u00AA': 'ê',
        '\u00C3\u00AD': 'í',
        '\u00C3\u00B3': 'ó',
        '\u00C3\u00B4': 'ô',
        '\u00C3\u00B5': 'õ',
        '\u00C3\u00BA': 'ú',
        '\u00C3\u00A7': 'ç',
        '\u00C3\u0081': 'Á',
        '\u00C3\u0080': 'À',
        '\u00C3\u0082': 'Â',
        '\u00C3\u0083': 'Ã',
        '\u00C3\u0089': 'É',
        '\u00C3\u008A': 'Ê',
        '\u00C3\u008D': 'Í',
        '\u00C3\u0093': 'Ó',
        '\u00C3\u0094': 'Ô',
        '\u00C3\u0095': 'Õ',
        '\u00C3\u009A': 'Ú',
        '\u00C3\u0087': 'Ç',
        '\u00C2\u00A0': ' ',
        '\u00C2\u00B0': '°',
        '\u00C2\u00BA': 'º',
        '\u00C2\u00AA': 'ª',
        '\u00E2\u0080\u0093': '-',
        '\u00E2\u0080\u0094': '-',
        '\u00E2\u0080\u0098': "'",
        '\u00E2\u0080\u0099': "'",
        '\u00E2\u0080\u009C': '"',
        '\u00E2\u0080\u009D': '"',
        '\u00E2\u0080\u00A6': '...',
        '\u00E2\u0080\u0091': '-',
        '\u00E2\u0080\u00AF': ' ',
        '\u00E2\u0089\u00A5': '>=',
        '\u00E2\u009C\u0094': 'OK'
    };

    let parcial = texto;
    Object.entries(mapaMojibake).forEach(([quebrado, correto]) => {
        parcial = parcial.split(quebrado).join(correto);
    });

    return parcial;
}

function sanitizarTexto(texto) {
    if (typeof texto !== 'string') return texto;
    return normalizarCaracteresEditoriais(tentarCorrigirMojibake(texto)).replace(/^\uFEFF/, '');
}

function normalizarCaracteresEditoriais(texto) {
    if (typeof texto !== 'string') return texto;

    return texto
        .replace(/\u00A0/g, ' ')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2013\u2014\u2212]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function textoPlano(html = '') {
    return sanitizarTexto(String(html || ''))
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function contarPalavras(html = '') {
    const plano = textoPlano(html);
    if (!plano) return 0;

    return plano.split(/\s+/).filter(Boolean).length;
}

function limitarPalavras(texto = '', maxPalavras = 300, lado = 'inicio') {
    const palavras = textoPlano(texto).split(/\s+/).filter(Boolean);
    if (palavras.length <= maxPalavras) return palavras.join(' ');

    return lado === 'fim'
        ? palavras.slice(-maxPalavras).join(' ')
        : palavras.slice(0, maxPalavras).join(' ');
}

function montarContextoComplemento(html = '') {
    const plano = textoPlano(html);
    const paragrafos = String(html || '')
        .replace(/\r\n/g, '\n')
        .split(/<\/p>|<\/li>|<\/h2>|<\/h3>/i)
        .map(textoPlano)
        .filter(Boolean);

    return {
        resumo: limitarPalavras(plano, MAX_PALAVRAS_CONTEXTO_COMPLEMENTO, 'inicio'),
        ultimoTrecho: limitarPalavras(paragrafos.slice(-4).join(' '), MAX_PALAVRAS_ULTIMO_TRECHO, 'fim'),
        palavrasAtuais: contarPalavras(html)
    };
}

function contextoErroTexto(texto, index, tamanho = 45) {
    const inicio = Math.max(0, index - tamanho);
    const fim = Math.min(texto.length, index + tamanho);
    return texto.slice(inicio, fim).replace(/\s+/g, ' ').trim();
}

function validarCaracteresTexto(html = '', origem = 'texto') {
    const texto = sanitizarTexto(String(html || ''));
    const erros = [];
    const adicionarErrosRegex = (regex, codigo, mensagem) => {
        for (const match of texto.matchAll(regex)) {
            erros.push({
                origem,
                codigo,
                mensagem,
                trecho: contextoErroTexto(texto, match.index || 0),
                encontrado: match[0]
            });
        }
    };

    adicionarErrosRegex(/\uFFFD/g, 'CARACTERE_SUBSTITUICAO', 'Caractere quebrado encontrado. Geralmente indica erro de encoding.');
    adicionarErrosRegex(/(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF\u20AC\u201A-\u201E])/gu, 'MOJIBAKE', 'Texto com provável UTF-8 lido/escrito como Latin-1.');
    adicionarErrosRegex(/[A-Za-zÀ-ÿ][@?]*\?[@?]*[A-Za-zÀ-ÿ]/g, 'PALAVRA_CORROMPIDA', 'Palavra com ? no meio, como a@?o no lugar de ação. E-mails com @ são permitidos.');
    adicionarErrosRegex(/[^\S\r\n\t ]{2,}/g, 'ESPACO_INVISIVEL', 'Sequência incomum de espaços ou caracteres invisíveis.');
    adicionarErrosRegex(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, 'CONTROLE_INVISIVEL', 'Caractere de controle invisível no texto.');

    return {
        origem,
        ok: erros.length === 0,
        total_erros: erros.length,
        erros
    };
}

function salvarRelatorioValidacaoTexto(temaId, relatorios) {
    if (!Array.isArray(relatorios) || !relatorios.length) return;
    if (!fs.existsSync('output')) fs.mkdirSync('output', { recursive: true });

    const erros = relatorios.flatMap(r => r.erros || []);
    const payload = {
        tema_id: temaId,
        ok: erros.length === 0,
        total_erros: erros.length,
        gerado_em: new Date().toISOString(),
        legenda: {
            CARACTERE_SUBSTITUICAO: "Apareceu � no texto; provável quebra de encoding.",
            MOJIBAKE: "Apareceu Ã, Â ou â fora do lugar; provável texto UTF-8 interpretado errado.",
            PALAVRA_CORROMPIDA: "Apareceu @ ou ? dentro de palavra; exemplo: a@?o em vez de ação.",
            ESPACO_INVISIVEL: "Espaços/caracteres invisíveis incomuns.",
            CONTROLE_INVISIVEL: "Caractere de controle que não deveria entrar no PDF."
        },
        relatorios
    };

    writeJsonFile(path.join('output', `validacao_texto_tema_${temaId}.json`), payload);
}

function assertTextoValido(html, origem) {
    const relatorio = validarCaracteresTexto(html, origem);
    if (!relatorio.ok) {
        const resumo = relatorio.erros
            .slice(0, 5)
            .map(e => `${e.codigo}: "${e.encontrado}" em "${e.trecho}"`)
            .join(' | ');
        throw new Error(`Validação de texto falhou em ${origem}. ${resumo}`);
    }

    return relatorio;
}

function sanitizarEstrutura(valor) {
    if (typeof valor === 'string') {
        return sanitizarTexto(valor);
    }

    if (Array.isArray(valor)) {
        return valor.map(item => sanitizarEstrutura(item));
    }

    if (valor && typeof valor === 'object') {
        const saida = {};

        Object.keys(valor).forEach((chave) => {
            saida[chave] = sanitizarEstrutura(valor[chave]);
        });

        return saida;
    }

    return valor;
}

function parseJsonSafe(raw) {
    return sanitizarEstrutura(JSON.parse(String(raw).replace(/^\uFEFF/, '')));
}

function readJsonFile(filePath) {
    return parseJsonSafe(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(sanitizarEstrutura(data), null, 2), 'utf8');
}

function instrucoesPtBrExtras() {
    return `
        REGRAS OBRIGATORIAS DE IDIOMA:
        - Escreva em português do Brasil natural.
        - Use acentuação correta em todas as palavras.
        - Não remova acentos de palavras como "você", "não", "relação", "bônus", "capítulo", "introdução".
        - Não devolva texto corrompido como "VocÃª", "nÃ£o", "bÃ´nus".
        - Não use ASCII simplificado quando o idioma for português.
    `;
}

async function imagemPareceTerTexto(filePath) {
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');

    const response = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{
            role: "user",
            content: [
                {
                    type: "text",
                    text: [
                        "Analise esta imagem e responda APENAS com JSON válido no formato:",
                        '{"has_text": true|false, "confidence": 0.0-1.0, "reason": "curta"}',
                        "Considere como texto qualquer palavra, letra, número, tipografia, logo com lettering ou frase visível dentro da ilustração.",
                        "Se houver qualquer dúvida, marque has_text como true."
                    ].join(" ")
                },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${base64Image}`
                    }
                }
            ]
        }],
        temperature: 0.0,
        response_format: { type: "json_object" }
    });

    const raw = response?.choices?.[0]?.message?.content || '{"has_text":true,"confidence":0,"reason":"sem resposta"}';
    const parsed = JSON.parse(raw);

    return parsed?.has_text === true;
}

async function gerarCapitulosIA(principal, temaNome) {
    const prompt = `
        Aja como um Arquiteto Editorial de E-books de alto valor.
        O tema principal é "${principal}" e o subtema é "${temaNome}".

        Crie uma estrutura de capítulos robusta para um e-book de 10 a 15 capítulos.
        Para cada capítulo, julgue se ele precisa de uma "Escrita Profunda" (subtópicos detalhados) ou se é um capítulo "Direto" (texto único).

        REGRAS DE JULGAMENTO:
        - Capítulos teóricos, técnicos ou científicos: true (precisa de subtópicos).
        - Introdução, Conclusão, Tabelas, Cronogramas ou Dicas Rápidas: false (direto).

        FORMATO DE RETORNO (Apenas JSON):
        [
            ["Nome do Capítulo", true],
            ["Nome do Capítulo", false]
        ]

        ${instrucoesPtBrExtras()}
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });

        const cleanContent = sanitizarTexto(
            response.choices[0].message.content.replace(/```json|```/g, "").trim()
        );
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error("❌ Erro ao gerar capítulos via IA, usando fallback.");
        return [["Introdução", false], [temaNome, true], ["Conclusão", false]];
    }
}

function criarPastaTema(tema) {
    const nomeLimpo = `${tema.id} - ${tema.nome}`.replace(/[:*?"<>|/\\]/g, '-');

    const pastaPath = path.join(process.cwd(), 'output', nomeLimpo);

    if (!fs.existsSync(pastaPath)) {
        fs.mkdirSync(pastaPath, { recursive: true });
    }

    return pastaPath;
}

function salvarBackupHTML(caminhoTema, conteudo, idioma) {
    const file = (idioma == "pt") ? 'backup-html-pt.txt' : 'backup-html-en.txt';

    const backup = path.join(caminhoTema, file);

    fs.writeFileSync(backup, conteudo, 'utf8');
}

function buscarProximoTema() {
    const data = fs.readFileSync('temas.json', 'utf8');
    let busca_temas = parseJsonSafe(data);

    const proximo = busca_temas.find(t => t.feito === false);

    if (!proximo) {
        console.log("Todos os PDFs já foram gerados!");
        return null;
    }

    return proximo;
}

function marcarComoConcluido(id) {
    const data = fs.readFileSync('temas.json', 'utf8');
    let dados_temas = parseJsonSafe(data);

    const index = dados_temas.findIndex(t => t.id === id);

    if (index !== -1) {
        dados_temas[index].feito = true;

        writeJsonFile('temas.json', dados_temas);
        console.log(`ID ${id} marcado como concluído.`);
    }
}

function ajustarTextoCapa(texto, tipo) {
    const len = texto.length;
    let fontSize, tag;

    if (tipo === 'principal') {
        // Lógica para o campo "Vamos de..."
        tag = 'h2';
        if (len <= 20) fontSize = '3.5rem';
        else if (len <= 30) fontSize = '3.2rem';
        else { fontSize = '3rem'; tag = 'h3'; } // Reduz a tag se for muito longo
    } else {
        // Lógica para o Título do Ebook
        tag = 'h3';
        if (len <= 20) fontSize = '2.5rem';
        else if (len <= 30) fontSize = '2.2rem';
        else if (len <= 45) fontSize = '2rem';
        else { fontSize = '3rem'; tag = 'h4'; } // Títulos muito longos
    }

    return { fontSize, tag };
}

async function planejarEstruturaDetalhada(principal, temaNome) {
    const prompt = `
        Aja como um autor especialista em e-books. 
        O tema principal é "${principal}" e o subtema é "${temaNome}".
        
        Crie uma estrutura DETALHADA para um capítulo de alta autoridade.
        Retorne um array JSON de strings, onde cada string é um tópico ou subtópico específico que precisa ser explorado detalhadamente.
        
        Exemplo: 
        ["Tópico a", "Tópico b", "Tópico c", "Tópico d"...]

        No máximo estourando apenas 1 subtópico ou menos.
        
        Retorne APENAS o array JSON, sem explicações.

        ${instrucoesPtBrExtras()}
    `;

    const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
    });

    try {
        const cleanContent = sanitizarTexto(
            response.choices[0].message.content.replace(/```json|```/g, "").trim()
        );

        return JSON.parse(cleanContent);
    } catch (e) {
        console.error("Erro ao parsear estrutura detalhada, usando fallback.");

        return [temaNome, "Conceitos Fundamentais", "Aplicações Práticas", "Conclusão Detalhada"];
    }
}

async function escreverTopicoProfundo(temaPrincipal, subtema, topicoEspecifico, topico_detalhado, conteudo) {
    const minimoPalavras = topicoEspecifico ? 1400 : MINIMO_PALAVRAS_CAPITULO;
    const regrasEstilo = `
        REGRAS DE QUALIDADE EDITORIAL:
        - Escreva de forma objetiva, útil e direta, sem frases robóticas, sem clichês de IA e sem promessas genéricas.
        - Não use expressões como "neste capítulo exploraremos", "é importante destacar", "em um mundo cada vez mais" ou conclusões repetitivas.
        - Use exemplos concretos, procedimentos, critérios, alertas, listas acionáveis e explicações práticas.
        - Não enrole para aumentar volume; cada parágrafo precisa entregar informação nova.
        - Mínimo de ${minimoPalavras} palavras para esta entrega.
        - Use HTML válido com <h2>, <h3>, <p>, <ul> e <ol> quando fizer sentido.
        - Não use caracteres quebrados, símbolos estranhos ou substituições como "a@?o" no lugar de "ação".
    `;
    const prompt = topicoEspecifico
        ? `Você está escrevendo uma seção de um e-book profissional sobre "${temaPrincipal} - ${subtema}". Foque EXCLUSIVAMENTE no subtópico: "${topicoEspecifico}". Diretriz detalhada: ${topico_detalhado}. ${regrasEstilo} ${instrucoesPtBrExtras()}`
        : `Você está escrevendo uma seção de um e-book profissional sobre "${temaPrincipal} - ${subtema}". Foque EXCLUSIVAMENTE neste capítulo. Diretriz detalhada: ${topico_detalhado}. ${regrasEstilo} ${instrucoesPtBrExtras()}`;

    let sucesso = false;
    let resultado = "";

    while (!sucesso) {
        try {
            if (conteudo && String(conteudo).trim()) {
                // Usa conteudo predefinido do temas.json quando existir
                resultado = sanitizarTexto(conteudo);
            } else {
                resultado = await chamarGroqTexto(prompt, {
                    temperature: 0.75,
                    maxCompletionTokens: topicoEspecifico ? 1800 : 2200,
                    origem: `capitulo:${subtema}${topicoEspecifico ? `:${topicoEspecifico}` : ''}`
                });
            }

            assertTextoValido(resultado, `capitulo:${subtema}${topicoEspecifico ? `:${topicoEspecifico}` : ''}`);

            sucesso = true; // Sai do loop se der certo
        } catch (error) {
            if (String(error?.message || '').startsWith('Validação de texto falhou')) {
                throw error;
            }

            if (error.status === 429) {
                // Extrai o tempo de espera da mensagem ou usa um padrão de 60 segundos
                console.log(`\n⏳ [RATE LIMIT] Limite atingido no capítulo: ${topicoEspecifico || subtema}`);

                // Pega o tempo sugerido pelo erro (retry-after) ou espera 90 segundos por segurança
                const tempoEsperaSegundos = error.headers && error.headers['retry-after']
                    ? parseInt(error.headers['retry-after']) + 5
                    : 90;

                console.warn(`🕒 Aguardando ${tempoEsperaSegundos} segundos para liberar tokens... Não feche o terminal.`);

                // Faz o script "dormir"
                await aguardar(tempoEsperaSegundos * 1000);

                console.log("🚀 Retomando geração...");
            } else {
                // Se for outro erro (ex: internet caida), tenta de novo em 10s
                console.error("❌ Erro de conexão ou API:", error.message);
                await aguardar(10000);
            }
        }
    }

    return resultado;
}

async function complementarCapituloAteMinimo(tema, capituloNome, htmlAtual) {
    let html = sanitizarTexto(htmlAtual);
    let palavras = contarPalavras(html);
    let tentativa = 0;

    while (palavras < MINIMO_PALAVRAS_CAPITULO && tentativa < MAX_TENTATIVAS_COMPLEMENTO_CAPITULO) {
        tentativa += 1;
        const faltam = MINIMO_PALAVRAS_CAPITULO - palavras;
        const contexto = montarContextoComplemento(html);
        console.log(`    > Complementando capítulo "${capituloNome}" (${palavras}/${MINIMO_PALAVRAS_CAPITULO} palavras, faltam ~${faltam})`);

        const prompt = `
            Continue e aprofunde o capítulo "${capituloNome}" do e-book "${tema.principal} - ${tema.nome}".

            Resumo do que ja foi abordado, para evitar repetição:
            ${contexto.resumo}

            Ultimo trecho escrito, apenas para continuidade:
            ${contexto.ultimoTrecho}

            Gere APENAS HTML complementar, sem repetir o que já foi dito.
            Regras:
            - Acrescente entre ${Math.min(900, Math.max(450, faltam))} e ${Math.min(1200, Math.max(700, faltam + 250))} palavras.
            - Seja objetivo, prático e humano.
            - Inclua exemplos concretos, critérios de decisão, erros comuns, passos aplicáveis e alertas úteis.
            - Não use frases robóticas, introduções genéricas ou conclusões vazias.
            - Não use caracteres quebrados, símbolos estranhos ou palavras como a@?o.
            - Não faça resumo do capítulo inteiro; continue com informação nova.
            - Use <h2>, <h3>, <p>, <ul> e <ol>.
            ${instrucoesPtBrExtras()}
        `;

        const complemento = await chamarGroqTexto(prompt, {
            temperature: 0.55,
            maxCompletionTokens: 1600,
            origem: `complemento:${capituloNome}:${tentativa}`
        });
        assertTextoValido(complemento, `complemento:${capituloNome}:${tentativa}`);
        html += `\n${complemento}`;
        palavras = contarPalavras(html);
    }

    if (palavras < MINIMO_PALAVRAS_CAPITULO) {
        throw new Error(`Capítulo "${capituloNome}" ficou curto (${palavras} palavras). Mínimo exigido: ${MINIMO_PALAVRAS_CAPITULO}.`);
    }

    return html;
}

async function traduzirParaIngles(conteudo) {
    const html = sanitizarTexto(String(conteudo || ''));
    const blocos = html
        .split(/(?=<h[1-3]\b|<p\b|<ul\b|<ol\b)/i)
        .map(b => b.trim())
        .filter(Boolean);

    const grupos = [];
    let atual = '';
    for (const bloco of blocos.length ? blocos : [html]) {
        const candidato = `${atual}\n${bloco}`.trim();
        if (contarPalavras(candidato) > 900 && atual) {
            grupos.push(atual);
            atual = bloco;
        } else {
            atual = candidato;
        }
    }
    if (atual) grupos.push(atual);

    const partes = [];
    for (let i = 0; i < grupos.length; i++) {
        const prompt = `
            Traduza o seguinte conteúdo HTML para o Inglês, mantendo todas as tags HTML intactas.
            Quero apenas a tradução pura, sem comentários antes ou depois.
            Não use caracteres quebrados, mojibake ou símbolos estranhos.

            Parte ${i + 1}/${grupos.length}:
            ${grupos[i]}
        `;

        const parte = await chamarGroqTexto(prompt, {
            temperature: 0.25,
            maxCompletionTokens: 1700,
            origem: `traducao:ingles:${i + 1}`
        });
        assertTextoValido(parte, `traducao:ingles:${i + 1}`);
        partes.push(parte);
    }

    const traducao = sanitizarTexto(partes.join('\n'));
    assertTextoValido(traducao, "traducao:ingles");
    return traducao;
}

function rgbFromHex(hex) {
    if (!hex || typeof hex !== 'string') return rgb(0.8, 0.8, 0.2);

    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    return rgb(r, g, b);
}

function normalizarHexCor(hex, fallback = '#6D8EDB') {
    if (typeof hex !== 'string') return fallback;
    const valor = hex.trim();
    return /^#[0-9a-f]{6}$/i.test(valor) ? valor : fallback;
}

function hexParaRgb(hex) {
    const cor = normalizarHexCor(hex).replace('#', '');
    return {
        r: parseInt(cor.slice(0, 2), 16),
        g: parseInt(cor.slice(2, 4), 16),
        b: parseInt(cor.slice(4, 6), 16)
    };
}

function rgbParaHex({ r, g, b }) {
    const canal = (valor) => Math.max(0, Math.min(255, Math.round(valor))).toString(16).padStart(2, '0');
    return `#${canal(r)}${canal(g)}${canal(b)}`;
}

function misturarHex(hexA, hexB, pesoB = 0.5) {
    const a = hexParaRgb(hexA);
    const b = hexParaRgb(hexB);
    const pesoA = 1 - pesoB;
    return rgbParaHex({
        r: a.r * pesoA + b.r * pesoB,
        g: a.g * pesoA + b.g * pesoB,
        b: a.b * pesoA + b.b * pesoB
    });
}

function luminanciaHex(hex) {
    const { r, g, b } = hexParaRgb(hex);
    const canal = (valor) => {
        const normalizado = valor / 255;
        return normalizado <= 0.03928 ? normalizado / 12.92 : Math.pow((normalizado + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

function corTituloCapaLegivel(corTema) {
    const cor = normalizarHexCor(corTema);
    const luminancia = luminanciaHex(cor);

    if (luminancia < 0.22) return misturarHex(cor, '#FFFFFF', 0.52);
    if (luminancia < 0.34) return misturarHex(cor, '#FFFFFF', 0.34);
    if (luminancia > 0.78) return misturarHex(cor, '#111111', 0.25);
    return cor;
}

// async function generateImage(titulo, prompt, HF_TOKEN) {
//     const hf = new HfInference(HF_TOKEN);

//     try {
//         const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;

//         console.log(`🚀 Tentando gerar via Serverless API: ${titulo}...`);

//         const response = await hf.textToImage({
//             model: "stabilityai/stable-diffusion-xl-base-1.0",
//             inputs: prompt,
//             provider: "hf-inference"
//         });

//         console.log(response);

//         const buffer = Buffer.from(await response.arrayBuffer());

//         if (!fs.existsSync('output')) fs.mkdirSync('output');
//         fs.writeFileSync(`output/${fileName}`, buffer);

//         console.log(`✅ Sucesso! Arquivo: output/${fileName}`);

//         return fileName;
//     } catch (error) {
//         console.error("❌ Erro:", error.message);
//     }
// }

// async function generateImage(titulo, prompt, receitaResult) {
//     const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;

//     const promptImagem = (prompt)?prompt:`Ultra realistic food photography of the following title: ${titulo}`;

//     const encodedPrompt = encodeURIComponent(promptImagem);
//     // const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1000)}`;
//     const url = `https://gen.pollinations.ai/image/${encodeURIComponent(promptImagem)}?width=1024&height=1024&model=flux&seed=42`;

//     try {
//         const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000});
//         fs.writeFileSync(`output/${fileName}`, response.data);
//         return fileName;
//     } catch (error) {
//         console.error("❌ Erro na Pollinations AI:", error.message);
//         return null;
//     }
// }

async function generateImage(titulo, prompt, api_key) {
    const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;
    const promptImagem = prompt ? prompt : `Ultra realistic food photography of the following title: ${titulo}`;
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(promptImagem)}`;

    try {
        const response = await axios.get(url, {
            params: {
                width: 1024,
                height: 1024,
                model: 'flux', // Você pode trocar por 'turbo' ou 'nanobanana'
                seed: Math.floor(Math.random() * 100000),
                nologo: true
            },
            headers: {
                // 4. Adiciona a autenticação necessária no novo sistema
                'Authorization': `Bearer ${api_key}` 
            },
            responseType: 'arraybuffer',
            timeout: 180000 // 3 minutos
        });

        // 5. Salva o arquivo
        if (!fs.existsSync('output')) fs.mkdirSync('output');
        fs.writeFileSync(`output/${fileName}`, response.data);
        
        console.log(`✅ Imagem gerada: ${fileName}`);
        return fileName;

    } catch (error) {
        // Se o erro for 401, sua chave está errada ou expirou
        if (error.response?.status === 401) {
            console.error("❌ Erro de Autenticação: Verifique sua API Key no enter.pollinations.ai");
        } else {
            console.error("❌ Erro na Pollinations AI:", error.message);
        }
        return null;
    }
}

// async function generateImage(titulo, prompt, HF_TOKEN) {
//     // ... dentro do seu try/catch
//     const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;
//     const promptEncoded = encodeURIComponent(prompt);
//     const url = `https://image.pollinations.ai/{promptEncoded}?width=1024&height=1024&model=flux&seed=${Math.floor(Math.random() * 1000000)}`;

//     console.log(`🚀 Gerando via Pollinations: ${titulo}...`);

//     const imageResponse = await axios({
//         url,
//         method: 'GET',
//         responseType: 'arraybuffer'
//     });

//     // A 'response' aqui seria o buffer da imagem
//     const response = Buffer.from(imageResponse.data);
//     // Salve o arquivo normalmente usando o fileName que você já criou
//     fs.writeFileSync(fileName, response);

//     return fileName;
// }

async function gerarIntroducaoDinamica(tema, conteudosAcumulados) {
    const listaTitulos = conteudosAcumulados.map((c, i) => `${i + 1}. ${c.titulo}`).join(", ");

    var prompt = `
        Aja como um editor de e-books profissional.
        Crie uma introdução envolvente e inspiradora para o e-book: "${tema.principal} - ${tema.nome}".
        
        O e-book contém os seguintes tópicos: ${listaTitulos}.
        
        REGRAS:
        - Use uma linguagem calorosa, profissional e objetiva.
        - Mencione a importância do tema "${tema.nome}" para o leitor.
        - O texto deve ter entre 3 e 4 parágrafos.
        - Retorne APENAS o conteúdo em HTML (usando tags <p>).
        - Não use <h1>, pois o título "Introdução" já existe no template.
        - Não use frases robóticas, clichês de IA ou promessas exageradas.
        - Não use caracteres quebrados, símbolos estranhos ou palavras como a@?o.
        ${tema.introducao_prompt ? `- Diretrizes específicas deste tema: ${tema.introducao_prompt}` : ''}
        ${instrucoesPtBrExtras()}
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8,
        });

        var resp = sanitizarTexto(response.choices[0].message.content.replace(/```html|```/g, "").trim());
        assertTextoValido(resp, `introducao:${tema.id}`);
        return resp;
    } catch (error) {
        console.error("❌ Erro ao gerar introdução:", error.message);
        const fallback = `<p>Este guia reúne orientações práticas sobre ${tema.nome}, com foco em decisões, exemplos e aplicações que ajudam o leitor a entender o tema sem rodeios.</p>`;
        assertTextoValido(fallback, `introducao_fallback:${tema.id}`);
        return fallback;
    }
}

async function gerarPdfSimples(html, outputPath) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.setBypassServiceWorker(true);

    const tempHtmlPath = path.resolve('./temp-pdf-content.html');
    fs.writeFileSync(tempHtmlPath, html, 'utf8');

    await page.goto(`file://${tempHtmlPath}`, {
        waitUntil: 'networkidle0'
    });

    await page.evaluateHandle('document.fonts.ready');

    await page.pdf({
        path: outputPath,
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();
    fs.unlinkSync(tempHtmlPath);
}

async function gerarCapaPng(html, outputPath) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // A4 em pixels (aprox. 96dpi) com boa nitidez via deviceScaleFactor.
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await page.setBypassServiceWorker(true);

    // Remove page-break para nao interferir no bounding da capa.
    const htmlSemPageBreak = String(html).replace(
        /<div class="page-break"[^>]*><\/div>/gi,
        ''
    );

    const tempHtmlPath = path.resolve(`./temp-cover-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, htmlSemPageBreak, 'utf8');

    try {
        await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle0' });
        await page.evaluateHandle('document.fonts.ready');

        // Garante que as imagens da capa terminaram de carregar.
        await page.evaluate(async () => {
            const imgs = Array.from(document.images || []);
            await Promise.all(
                imgs.map((img) => {
                    if (img.complete) return Promise.resolve();
                    return new Promise((resolve) => {
                        img.addEventListener('load', resolve, { once: true });
                        img.addEventListener('error', resolve, { once: true });
                    });
                })
            );
        });

        const coverEl = await page.$('.cover-full');

        if (!coverEl) {
            throw new Error("Elemento '.cover-full' nao encontrado para exportar a capa.");
        }

        // Recorte em proporcao A4 (1:sqrt(2)) para evitar sobra embaixo.
        const box = await coverEl.boundingBox();
        if (!box) {
            throw new Error("Nao foi possivel calcular bounding box da capa.");
        }

        const alturaA4 = Math.round(box.width * Math.SQRT2);
        const clip = {
            x: Math.max(0, Math.floor(box.x)),
            y: Math.max(0, Math.floor(box.y)),
            width: Math.floor(box.width),
            height: Math.floor(Math.min(box.height, alturaA4))
        };

        await page.screenshot({
            path: outputPath,
            type: 'png',
            clip
        });
    } finally {
        await browser.close();
        if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    }
}

async function juntarPdfs(paths, outputPath, corTema, corFonte) {
    const pdfFinal = await PDFDocument.create();
    const fonteEstilizada = await pdfFinal.embedFont('Helvetica-Bold');
    const corParaDesenho = rgbFromHex(corTema);
    const corParaFonte = rgbFromHex(corFonte);

    let contadorPagina = 1;

    for (let i = 0; i < paths.length; i++) {
        const pdfPath = paths[i];
        if (fs.existsSync(pdfPath)) {
            const bytes = fs.readFileSync(pdfPath);
            const pdf = await PDFDocument.load(bytes);
            const pages = await pdfFinal.copyPages(pdf, pdf.getPageIndices());

            pages.forEach((page) => {
                if (i > 2) {
                    const { width, height } = page.getSize();

                    page.drawRectangle({
                        x: width - 40,
                        y: 30,
                        width: 25,
                        height: 25,
                        color: corParaDesenho,
                        opacity: 1,
                    });

                    page.drawText(`${contadorPagina}`, {
                        x: width - 33,
                        y: 38,
                        size: 12,
                        font: fonteEstilizada,
                        color: corParaFonte,
                    });

                    contadorPagina++;
                }
                pdfFinal.addPage(page);
            });
        }
    }
    const pdfBytes = await pdfFinal.save();
    fs.writeFileSync(outputPath, pdfBytes);
}

async function contarPaginasPdf(pdfPath) {
    const bytes = fs.readFileSync(pdfPath);
    const pdf = await PDFDocument.load(bytes);
    return pdf.getPageCount();
}

async function gerarPDF(tema, capitulosAcumulados, idioma = "pt", pastaTema, imagemCapa, opcoes = {}) {
    const corTema = tema.cor;
    const corFonte = tema.cor_fonte;
    const corTituloCapa = corTituloCapaLegivel(corTema);
    const principalCapa = opcoes.principalCapa || ((idioma == "pt") ? tema.principal : tema.main);
    const tituloCapa = opcoes.tituloCapa || ((idioma == "pt") ? tema.nome : tema.name);
    const imagemCapaArquivo = opcoes.imagemCapaArquivo || imagemCapa;
    const capaModo = opcoes.capaModo || "principal";
    const icone = tema.icone;
    const sufixo = idioma === "en" ? "english" : "portugues";
    const nomeArquivo = `${tema.nome.replace(/[:*?"<>|/\\]/g, '-')}-${sufixo}`;
    const outputPath = path.join(pastaTema, nomeArquivo);
    const caminhosTemporarios = [];
    const dadosParaIndice = [];
    const relatoriosValidacaoTexto = [];
    var fullHtmlPT = ``
    var fullHtmlEN = ``

    const css = `
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
            @import url('https://fonts.googleapis.com/css2?family=Kaushan+Script&display=swap');

            /* Importação dos Ícones Bootstrap via CDN */
            @import url('https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css');

            body { 
                font-family: 'Roboto', sans-serif; 
                margin: 0; 
                padding: 0;
                color: #333;
            }

            .cover-script{
                font-family: "Kaushan Script", cursive;
                font-weight: 400;
                font-style: normal;
            }

            .cover-full {
                margin: 0;
                padding: 0;
                position: relative;
                box-shadow: none;
            }

            .cover-full ~ .page-number-box {
                display: none;
            }

            .footer {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                height: 20mm;
            }

            .recipe,
            .recipe-break {
                page-break-inside: avoid;
            }

            .doc-section li {
                page-break-inside: avoid;
                margin-bottom: 12px;
                padding-bottom: 6px;
            }

            /* Segurança extra para listas longas */
            .recipe-content ul,
            .recipe-content ol {
                margin-bottom: 10mm;
            }

            /* Dicas extras (parágrafo final costuma quebrar feio) */
            .recipe-content p:last-of-type {
                margin-bottom: 12mm;
            }

            .page-break {
                page-break-after: always;
            }

            /* Estilos Capa */
            .cover-page {
                width: 100%; 
                height: 1vh; 
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                text-align: center;
                color: #FFF;
                padding: 0px;
            }
            
            .cover-page h1 { font-size: 3.5em; margin-bottom: 20px; }
            .cover-page h2 { font-size: 1.5em; font-weight: 400; }
            .logo { max-width: 200px; margin-bottom: 50px; filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3)); }

            /* Estilos de Conteúdo Geral e Paginação */
            .page-content {
                padding: 3cm 2cm;
                position: relative;
            }

            .page-number-intro, .page-number-index, .page-number-recipes-title {
                position: absolute;
                bottom: 1cm;
                right: 2cm;
                font-size: 0.8em;
                color: #888;
            }

            /* Estilos Introdução */
            .introduction-page h1 { color: ${corTema}; border-bottom: 3px solid ${corTema}; padding-bottom: 10px; }
            .signature { margin-top: 40px; font-style: italic; color: #555; }

            /* Estilos Índice */
            .index-page h1 { color: #333; border-bottom: 3px solid #333; padding-bottom: 10px; }
            .index-item { 
                display: flex; 
                justify-content: space-between; 
                padding: 8px 0; 
                border-bottom: 1px dashed #DDD;
                font-size: 1.1em;
            }

            .index-item span { font-weight: 700; color: ${corTema}; }

            .recipe-container {
                display: flex;
                flex-direction: row;
                justify-content: space-between;
                align-items: flex-start;
                gap: 30px;
                width: 100%;
            }

            /* Coluna do texto - ocupa a maior parte da largura */
            .recipe-content {
                flex: 1; /* Ocupa o espaço disponível */
                max-width: 60%; /* Garante que sobre espaço para a imagem */
            }

            /* Coluna da imagem - fixa na direita */
            .recipe-image {
                width: 35%; /* Define um tamanho fixo para a coluna da imagem */
                position: sticky; /* Tenta manter a imagem visível se houver quebra */
                top: 0;
            }

            .recipe-image img {
                width: 100%;
                height: auto;
                display: block;
                border-radius: 8px;
                object-fit: cover;
            }

            /* Garante que se o texto for muito longo, ele não "esprema" a imagem */
            .recipe-content, .recipe-image {
                word-wrap: break-word;
            }
            
            .recipe-content h1 { font-size: 1.8em; color: ${corTema}; margin-top: 0; }
            .recipe-content h2 { font-size: 1.4em; color: ${corTema}; border-bottom: 1px solid #EEE; padding-bottom: 5px; margin-top: 25px; }
            .recipe-content ul, .recipe-content ol { padding-left: 20px; }
            .page-number-recipe {
                position: absolute;
                bottom: -2cm;
                right: 0;
                font-size: 0.8em;
                color: #888;
            }

            .indice-page {
                page-break-after: always;
            }

            .indice-titulo {
                font-size: 28px;
                margin-bottom: 20px;
                color: ${corTema};
            }

            .indice-item {
                display: flex;
                align-items: center;
                margin-bottom: 14px;
                font-size: 14px;
            }

            .indice-nome {
                white-space: nowrap;
            }

            .indice-pontilhado {
                flex: 1;
                border-bottom: 1px dashed #ccc;
                margin: 0 10px;
            }

            .indice-pagina {
                white-space: nowrap;
                color: ${corTema};
                font-weight: bold;
            }

            @page {
                size: A4;
                /* Define a margem real que aparecerá em todas as folhas */
                margin: 20mm 20mm 25mm 25mm; 
            }

            p, li{
                line-height: 1.5;
            }

            body {
                margin: 0;
                padding: 0;
            }

            /* Remova a altura fixa e o padding interno */
            .recipe-page {
                width: 100%;
                position: relative;
                /* Permite que o conteúdo flua naturalmente entre as páginas */
                display: block; 
            }

            /* Evita que uma imagem ou título seja cortado ao meio entre páginas */
            h1, h2, .recipe-image {
                break-inside: avoid;
            }

            .topicos-div h1, h2, h3, h4, h5, h6, strong {
                color: ${corTema};
            }

            .topicos-div h2 {
                margin-top: 40px;
            }
        </style>
    `;

    const cssCapa = `
    <style>
        @page {
            margin: 0 !important;
            padding: 0 !important;
        }

        /* Adicionado &display=swap no final das URLs */
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Kaushan+Script&display=swap');

        /* Importação dos Ícones Bootstrap via CDN */
        @import url('https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css');
        
        body { 
            font-family: 'Roboto', sans-serif !important; 
            margin: 0; 
            padding: 0;
            color: #333;
        }

        .cover-script {
            font-family: 'Kaushan Script', cursive !important;
            // font-weight: 400;
        }
        
        .cover-full {
            width: 100vw !important;
            height: 100vh !important;
            margin: 0 !important;
            padding: 0 !important;
            display: block;
        }

        .introduction-page h1 { color: ${corTema}; border-bottom: 3px solid ${corTema}; padding-bottom: 10px; }

        /* Capa v2 (impacto alto, layout assimétrico) */
        .cover-v2 {
            position: relative;
            min-height: 100vh;
            overflow: hidden;
            background: #050505;
            color: #fff;
        }
        .cover-v2::before {
            content: "";
            position: absolute;
            inset: 0;
            background:
                radial-gradient(circle at 15% 5%, rgba(255,255,255,0.08), transparent 38%),
                radial-gradient(circle at 100% 25%, rgba(255,255,255,0.05), transparent 45%);
            pointer-events: none;
        }
        .cover-v2::after {
            content: "";
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 120px;
            background: linear-gradient(180deg, transparent, ${corTema});
            opacity: .95;
            pointer-events: none;
        }
        .cover-v2-inner {
            position: relative;
            z-index: 1;
            min-height: 100vh;
            display: grid;
            grid-template-rows: auto auto auto 1fr auto;
            padding: 28px 26px 18px;
            gap: 12px;
        }
        .cover-v2-top {
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .cover-v2-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 7px 12px;
            border-radius: 999px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .1em;
            text-transform: uppercase;
        }
        .cover-v2-icon { display: none; }
        .cover-v2-kicker {
            margin: 6px 0 0;
            text-align: center;
            color: rgba(255,255,255,0.96);
            font-size: 18px;
            line-height: 1.15;
        }
        .cover-v2-main {
            display: block;
        }
        .cover-v2-script {
            margin: 2px 0 10px;
            text-align: center;
            color: rgba(255,255,255,0.96);
            line-height: 1.04;
            text-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .cover-v2-title-wrap {
            display: block;
            margin: 0 auto;
            max-width: 96%;
            background: transparent;
            border: 0;
            box-shadow: none;
            padding: 0;
        }
        .cover-v2-title {
            margin: 0;
            text-align: center;
            color: ${corTituloCapa};
            text-transform: uppercase;
            font-weight: 900;
            letter-spacing: 0;
            line-height: 0.95;
            text-shadow: 0 2px 2px rgba(0,0,0,0.72), 0 10px 26px rgba(0,0,0,0.58);
            -webkit-text-stroke: 1px rgba(255,255,255,0.16);
            display: block;
        }
        .cover-v2-sub,
        .cover-v2-impact,
        .cover-v2-strip {
            display: none;
        }
        .cover-v2-image-wrap {
            position: relative;
            margin-top: 4px;
            border-radius: 0;
            overflow: hidden;
            border: 0;
            background: transparent;
            box-shadow: none;
            clip-path: polygon(0 14%, 50% 0, 100% 14%, 100% 100%, 0 100%);
        }
        .cover-v2-image-wrap::before {
            content: "";
            position: absolute;
            inset: 0;
            background: ${corTema};
            clip-path: polygon(0 0, 50% 11%, 100% 0, 100% 7%, 50% 18%, 0 7%);
            z-index: 2;
        }
        .cover-v2-image {
            width: 100%;
            height: 650px;
            object-fit: cover;
            display: block;
            filter: saturate(1.05) contrast(1.03);
        }
        .cover-v2-image-overlay {
            position: absolute;
            inset: 0;
            background:
                linear-gradient(180deg, rgba(0,0,0,0.18), transparent 25%, transparent 72%, rgba(0,0,0,0.28)),
                linear-gradient(10deg, ${corTema} 0 8%, transparent 8% 100%);
            z-index: 1;
        }
        .cover-v2-badge {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 16px;
            margin: 0 auto;
            width: fit-content;
            max-width: 90%;
            padding: 9px 14px;
            border-radius: 999px;
            background: rgba(15,15,18,0.76);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .12em;
            text-transform: uppercase;
            border: 1px solid rgba(255,255,255,0.12);
            z-index: 3;
        }
        .cover-v2-footer {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            align-items: center;
            gap: 12px;
            margin-top: 6px;
        }
        .cover-v2-line {
            height: 1px;
            background: linear-gradient(to right, rgba(255,255,255,0.08), rgba(255,255,255,0.45), rgba(255,255,255,0.08));
        }
        .cover-v2-mark {
            width: 62px;
            height: 62px;
            border-radius: 50%;
            background: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 10px 18px rgba(0,0,0,0.2);
        }
        .cover-v2-mark img {
            width: 34px;
            height: 34px;
            object-fit: contain;
        }
        .cover-v2-bottombar {
            margin-top: 10px;
            height: 10px;
            border-radius: 999px;
            background: linear-gradient(90deg, ${corTema}, rgba(255,255,255,0.18), ${corTema});
        }

        /* Capa bonus (layout distinto) */
        .cover-bonus {
            min-height: 100vh;
            background: linear-gradient(145deg, #0a0a0a 0%, #111 40%, ${corTema} 100%);
            color: #fff;
            position: relative;
            overflow: hidden;
        }
        .cover-bonus::before {
            content: "";
            position: absolute;
            inset: 0;
            background:
                radial-gradient(circle at 20% 0%, rgba(255,255,255,0.12), transparent 35%),
                radial-gradient(circle at 100% 100%, rgba(255,255,255,0.10), transparent 35%);
            pointer-events: none;
        }
        .cover-bonus-inner {
            position: relative;
            z-index: 1;
            min-height: 100vh;
            display: grid;
            grid-template-rows: auto auto 1fr auto;
            gap: 14px;
            padding: 34px 26px 24px;
        }
        .cover-bonus-chip {
            display: inline-block;
            width: fit-content;
            padding: 8px 12px;
            border-radius: 999px;
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: .14em;
            font-weight: 700;
            background: rgba(255,255,255,.1);
            border: 1px solid rgba(255,255,255,.18);
        }
        .cover-bonus-title {
            margin: 6px 0 0;
            font-size: 64px;
            line-height: .95;
            letter-spacing: -0.02em;
            text-transform: uppercase;
            font-weight: 900;
            color: #fff;
            text-shadow: 0 10px 28px rgba(0,0,0,.35);
        }
        .cover-bonus-image-wrap {
            position: relative;
            overflow: hidden;
            border-radius: 22px;
            border: 1px solid rgba(255,255,255,.18);
            box-shadow: 0 16px 40px rgba(0,0,0,.35);
        }
        .cover-bonus-image {
            width: 100%;
            height: 620px;
            object-fit: cover;
            display: block;
        }
        .cover-bonus-image-overlay {
            position: absolute;
            inset: 0;
            background:
                linear-gradient(180deg, rgba(0,0,0,.2), transparent 35%, transparent 75%, rgba(0,0,0,.4)),
                linear-gradient(115deg, transparent 0 45%, rgba(0,0,0,.32) 45% 100%);
        }
        .cover-bonus-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            font-size: 12px;
            letter-spacing: .08em;
            text-transform: uppercase;
            color: rgba(255,255,255,.85);
        }
        .cover-bonus-footer-line {
            flex: 1;
            height: 1px;
            background: rgba(255,255,255,.35);
        }
    </style>`

    console.log(" 📄 Calculando páginas dos tópicos individualmente...");

    let paginaAtualAcumulada = 1;

    for (let i = 0; i < capitulosAcumulados.length; i++) {
        const topico = capitulosAcumulados[i];
        const pathTemp = `output/_temp_r${i}.pdf`;
        const origemTopico = `${idioma}:pdf:${tema.id}:${topico?.titulo || `topico_${i + 1}`}`;
        relatoriosValidacaoTexto.push(assertTextoValido(topico?.html || '', origemTopico));

        var img = ``;

        if (topico.imagem) {
            img = `
                <div>
                    <img src="./output/${topico.imagem}" style="border: 4px solid ${corTema};">
                </div>
            `
        }

        const htmlTopicoIndividual = `
            <!DOCTYPE html>
            <html lang="pt-BR">
                <head><meta charset="UTF-8">${css}</head>
                <body>
                    <div class='topicos-div'>
                        <div>
                            <div>${topico.html}</div>
                            ${img}
                        </div>
                    </div>
                </body>
            </html>`;

        if (idioma == "pt") {
            fullHtmlPT += htmlTopicoIndividual
        } else {
            fullHtmlEN += htmlTopicoIndividual
        }

        await gerarPdfSimples(htmlTopicoIndividual, pathTemp);

        const bytes = fs.readFileSync(pathTemp);
        const pdfDoc = await PDFDocument.load(bytes);
        const qtd = pdfDoc.getPageCount();

        dadosParaIndice.push({
            titulo: topico.titulo,
            pagina: paginaAtualAcumulada
        });

        paginaAtualAcumulada += qtd;

        caminhosTemporarios.push(pathTemp);
    }

    const htmlIndiceFinal = `
        <section class="indice-page">
            <h1 class="indice-titulo" style="color: ${corTema}">${(idioma == 'pt') ? 'Índice' : 'Summary'}</h1>
            <div class="indice-lista">
                ${dadosParaIndice.map((item, index) => `
                    <div class="indice-item">
                        <span class="indice-nome">${index + 1}. ${item.titulo}</span>
                        <span class="indice-pontilhado"></span>
                        <span class="indice-pagina">${(idioma == 'pt') ? 'Pág' : 'Pag'}. ${item.pagina}</span>
                    </div>
                `).join('')}
            </div>
        </section>`;

    const estiloPrincipal = ajustarTextoCapa(principalCapa, 'principal');
    const estiloTitulo = ajustarTextoCapa(tituloCapa, 'titulo');

    // const htmlCapa = `
//   (modelo antigo mantido comentado para referencia)
// `;

    const htmlCapaPrincipal = `
        <div class="cover-full cover-v2">
            <div class="cover-v2-inner">
                <div class="cover-v2-top">
                </div>

                <div class="cover-v2-main">
                    <div>
                        <${estiloPrincipal.tag} class="cover-script cover-v2-script" style="font-size:${estiloPrincipal.fontSize} !important;">
                            ${principalCapa}
                        </${estiloPrincipal.tag}>
                        <div class="cover-v2-title-wrap">
                            <${estiloTitulo.tag} class="cover-v2-title" style="font-size:${Math.max(60, parseInt(estiloTitulo.fontSize) * 1.45 || 72)}px !important;">
                                ${tituloCapa}
                            </${estiloTitulo.tag}>
                        </div>
                        <p class="cover-v2-kicker"><i class="bi ${icone}"></i></p>
                    </div>

                    <div class="cover-v2-image-wrap">
                        <img class="cover-v2-image" src="./output/${imagemCapaArquivo}" alt="Imagem de capa" />
                        <div class="cover-v2-image-overlay"></div>
                        <div class="cover-v2-badge">${(idioma == "pt") ? "Coleção Especial" : "Special Collection"}</div>
                    </div>
                </div>

                <div>
                    <div class="cover-v2-footer">
                        <div class="cover-v2-line"></div>
                        <div class="cover-v2-mark">
                            <img src="img/realizart-logo.png" alt="Logo">
                        </div>
                        <div class="cover-v2-line"></div>
                    </div>
                    <div class="cover-v2-bottombar"></div>
                </div>
            </div>
        </div>
        <div class="page-break" style="page-break-after: always;"></div>
    `;

    const htmlCapaBonus = `
        <div class="cover-full cover-bonus">
            <div class="cover-bonus-inner">
                <div>
                    <span class="cover-bonus-chip">${(idioma === "pt") ? "Material Bonus" : "Bonus Material"}</span>
                    <h1 class="cover-bonus-title">${tituloCapa}</h1>
                </div>

                <p class="cover-v2-kicker"><i class="bi ${icone}"></i> ${(idioma === "pt") ? tema.principal : tema.main}</p>

                <div class="cover-bonus-image-wrap">
                    <img class="cover-bonus-image" src="./output/${imagemCapaArquivo}" alt="Imagem de capa bonus" />
                    <div class="cover-bonus-image-overlay"></div>
                </div>

                <div class="cover-bonus-footer">
                    <span>${(idioma === "pt") ? "Diagnostico Amoroso" : "Dating Diagnosis"}</span>
                    <span class="cover-bonus-footer-line"></span>
                    <span>${(idioma === "pt") ? "Edicao Extra" : "Extra Edition"}</span>
                </div>
            </div>
        </div>
        <div class="page-break" style="page-break-after: always;"></div>
    `;

    const htmlCapa = capaModo === "bonus" ? htmlCapaBonus : htmlCapaPrincipal;

    const htmlCapaCompleta = `<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>`;

    if (opcoes?.somenteCapa) {
        const capaPdfFinalPath = path.join(pastaTema, `${nomeArquivo}-somente-capa.pdf`);
        const capaPngPath = path.join(pastaTema, `${nomeArquivo}-capa.png`);

        await gerarPdfSimples(htmlCapaCompleta, capaPdfFinalPath);
        await gerarCapaPng(htmlCapaCompleta, capaPngPath);

        console.log(`🧪 Capa de teste gerada (PDF): ${capaPdfFinalPath}`);
        console.log(`🧪 Capa de teste gerada (PNG): ${capaPngPath}`);

        return {
            idioma,
            nomeArquivoBase: nomeArquivo,
            pdfFileName: `${nomeArquivo}-somente-capa.pdf`,
            pdfFinalPath: capaPdfFinalPath,
            capaPngFileName: `${nomeArquivo}-capa.png`,
            capaPngPath
        };
    }

    var textoIntroducaoAi = await gerarIntroducaoDinamica(tema, capitulosAcumulados);

    if (idioma != 'pt') {
        textoIntroducaoAi = await traduzirParaIngles(textoIntroducaoAi);
    }

    const htmlIntroducao = `
        <section class="indice-page">
            <div class="introduction-page">
                <h1>${(idioma == 'pt') ? 'Introdução' : 'Introduction'}</h1>
                ${textoIntroducaoAi}
            </div>
            <div class="page-break"></div>
        </section>
    `;


    if (idioma == "pt") {
        fullHtmlPT = `<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>` + `<html><head>${css}</head><body>${htmlIndiceFinal}</body></html>` + `<html><head>${css}</head><body>${htmlIntroducao}</body></html>` + fullHtmlPT
        salvarBackupHTML(pastaTema, fullHtmlPT, 'pt');

        fs.writeFileSync(
            path.join(pastaTema, 'conteudo-pt.html'),
            fullHtmlPT
        );
    } else {
        fullHtmlEN = `<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>` + `<html><head>${css}</head><body>${htmlIndiceFinal}</body></html>` + `<html><head>${css}</head><body>${htmlIntroducao}</body></html>` + fullHtmlEN
        salvarBackupHTML(pastaTema, fullHtmlEN, 'en');

        fs.writeFileSync(
            path.join(pastaTema, 'conteudo-en.html'),
            fullHtmlEN
        );
    }

    const capaPdfPath = `output/_temp_capa.pdf`;
    await gerarPdfSimples(htmlCapaCompleta, capaPdfPath);

    const capaPngPath = path.join(pastaTema, `${nomeArquivo}-capa.png`);
    await gerarCapaPng(htmlCapaCompleta, capaPngPath);
    console.log(`🖼️ Capa PNG salva em: ${capaPngPath}`);

    const indicePdfPath = `output/_temp_indice.pdf`;
    await gerarPdfSimples(`<html><head>${css}</head><body>${htmlIndiceFinal}</body></html>`, indicePdfPath);

    const introPdfPath = `output/_temp_intro.pdf`;
    await gerarPdfSimples(`<html><head>${css}</head><body>${htmlIntroducao}</body></html>`, introPdfPath);

    const pdfFinalPath = path.join(pastaTema, `${nomeArquivo}.pdf`);

    await juntarPdfs(
        [capaPdfPath, introPdfPath, indicePdfPath, ...caminhosTemporarios],
        pdfFinalPath,
        corTema,
        corFonte,
        imagemCapa
    );

    const totalPaginas = await contarPaginasPdf(pdfFinalPath);
    const exigirMinimoPaginas = opcoes.exigirMinimoPaginas === true && opcoes.capaModo !== "bonus" && opcoes.somenteCapa !== true;

    salvarRelatorioValidacaoTexto(tema.id, relatoriosValidacaoTexto);

    if (exigirMinimoPaginas && totalPaginas < MINIMO_PAGINAS_EBOOK) {
        throw new Error(`PDF "${path.basename(pdfFinalPath)}" ficou com ${totalPaginas} páginas. Mínimo exigido: ${MINIMO_PAGINAS_EBOOK}. Aumente capítulos/subtópicos ou rode novamente para complementar conteúdo.`);
    }

    [capaPdfPath, introPdfPath, indicePdfPath, ...caminhosTemporarios].forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    return {
        idioma,
        nomeArquivoBase: nomeArquivo,
        pdfFileName: `${nomeArquivo}.pdf`,
        pdfFinalPath,
        totalPaginas,
        capaPngFileName: `${nomeArquivo}-capa.png`,
        capaPngPath
    };
}

async function executarGeracaoProfunda(tema, capituloNome, precisaSubtopicos, topico_detalhado, ctd) {
    let htmlCapitulo = `<h1>${capituloNome}</h1>`;
    const temConteudoPredefinido = typeof ctd === 'string' && ctd.trim().length > 0;

    if (precisaSubtopicos) {
        console.log(`  ✍️ Planejando subtópicos para: ${capituloNome}`);
        const subtopicos = await planejarEstruturaDetalhada(tema.principal + " " + tema.nome, capituloNome);

        for (const sub of subtopicos) {
            console.log(`    > Escrevendo profundamente: ${sub}`);
            const trecho = await escreverTopicoProfundo(tema.principal + " " + tema.nome, capituloNome, sub, topico_detalhado, ctd);
            htmlCapitulo += trecho;
        }
    } else {
        console.log(`    > Escrevendo capítulo direto: ${capituloNome}`);
        const trecho = await escreverTopicoProfundo(tema.principal + " " + tema.nome, capituloNome, null, topico_detalhado, ctd);
        htmlCapitulo += trecho;
    }

    if (!temConteudoPredefinido) {
        htmlCapitulo = await complementarCapituloAteMinimo(tema, capituloNome, htmlCapitulo);
    } else {
        console.log(`    > Usando conteúdo existente do temas.json sem regenerar: ${capituloNome}`);
    }

    assertTextoValido(htmlCapitulo, `capitulo_final:${tema.id}:${capituloNome}`);

    return htmlCapitulo;
}

async function gerarCapituloComplementarParaPaginas(tema, capitulosAtuais, rodada, indice) {
    const titulo = `Material Complementar ${rodada}.${indice}: Aplicações Práticas de ${tema.nome}`;
    const contexto = capitulosAtuais
        .slice(-3)
        .map(cap => `${cap.titulo}: ${limitarPalavras(cap.html, 90, 'inicio')}`)
        .join('\n');

    const prompt = `
        Escreva um capítulo complementar para o e-book "${tema.principal} - ${tema.nome}".
        Título do capítulo: "${titulo}".

        Contexto dos capítulos recentes, apenas para evitar repetição:
        ${contexto}

        Objetivo:
        - Aumentar a profundidade editorial do livro com conteúdo novo e útil.
        - Trazer aplicações práticas, cenários reais, checklists, erros comuns, decisões recomendadas e exemplos.
        - Manter linguagem humana, objetiva e profissional.

        Regras:
        - Gere entre 1700 e 2200 palavras.
        - Retorne APENAS HTML válido.
        - Use <h1>${titulo}</h1> no começo e depois <h2>, <h3>, <p>, <ul> e <ol>.
        - Não repita capítulos anteriores.
        - Não use frases robóticas, clichês de IA ou conclusões vazias.
        - Não use caracteres quebrados ou palavras como a@?o.
        ${instrucoesPtBrExtras()}
    `;

    const html = await chamarGroqTexto(prompt, {
        temperature: 0.62,
        maxCompletionTokens: 2400,
        origem: `reforco_paginas:${tema.id}:${rodada}:${indice}`
    });

    assertTextoValido(html, `reforco_paginas:${tema.id}:${rodada}:${indice}`);
    return {
        titulo,
        html
    };
}

async function reforcarCapitulosAteMinimoPaginas(tema, capitulos, gerarPdfCallback) {
    let capitulosFinais = [...capitulos];
    let resultado = await gerarPdfCallback(capitulosFinais);

    if (!REFORCAR_PAGINAS_COM_IA) {
        if (resultado.totalPaginas < MINIMO_PAGINAS_EBOOK) {
            console.warn(`📄 PDF com ${resultado.totalPaginas}/${MINIMO_PAGINAS_EBOOK} páginas. Reforço automático com IA está desligado (REFORCAR_PAGINAS_COM_IA=true para ativar).`);
        }

        return {
            capitulos: capitulosFinais,
            resultado
        };
    }

    for (let rodada = 1; resultado.totalPaginas < MINIMO_PAGINAS_EBOOK && rodada <= MAX_RODADAS_REFORCO_PAGINAS; rodada++) {
        const faltam = MINIMO_PAGINAS_EBOOK - resultado.totalPaginas;
        const novosCapitulos = Math.min(4, Math.max(1, Math.ceil(faltam / 8)));

        console.warn(`📚 PDF com ${resultado.totalPaginas}/${MINIMO_PAGINAS_EBOOK} páginas. Gerando ${novosCapitulos} capítulo(s) complementar(es)...`);

        for (let i = 1; i <= novosCapitulos; i++) {
            const extra = await gerarCapituloComplementarParaPaginas(tema, capitulosFinais, rodada, i);
            capitulosFinais.push(extra);
        }

        resultado = await gerarPdfCallback(capitulosFinais);
    }

    if (resultado.totalPaginas < MINIMO_PAGINAS_EBOOK) {
        throw new Error(`PDF "${resultado.pdfFileName}" ficou com ${resultado.totalPaginas} páginas após reforços. Mínimo exigido: ${MINIMO_PAGINAS_EBOOK}.`);
    }

    return {
        capitulos: capitulosFinais,
        resultado
    };
}

// Salva o progresso atual do tema para não perder dados se o script cair
function salvarProgressoLocal(temaId, dados) {
    const backupPath = path.join('output', `progresso_tema_${temaId}.json`);
    writeJsonFile(backupPath, dados);
}

// Carrega o progresso se ele existir
function carregarProgressoLocal(temaId) {
    const backupPath = path.join('output', `progresso_tema_${temaId}.json`);
    if (fs.existsSync(backupPath)) {
        return readJsonFile(backupPath);
    }
    return { pt: [], en: [] };
}

// Atualiza o arquivo temas.json marcando o capítulo como concluído (true)
function marcarCapituloConcluido(temaId, indiceCapitulo) {
    const temasPath = './temas.json'; // Ajuste o caminho se necessário
    const temas = readJsonFile(temasPath);

    const temaIndex = temas.findIndex(t => t.id === temaId);
    if (temaIndex !== -1) {
        temas[temaIndex].estrutura.capitulos[indiceCapitulo][2] = true;
        writeJsonFile(temasPath, temas);
    }
}

function salvarArquivosNoSiteJson(temaId, pastaTema, arquivos = {}) {
    const caminhosSite = [
        path.join(process.cwd(), 'landing-page', 'site.json'),
    ];
    const pastaLandingImg = path.join(process.cwd(), 'landing-page', 'img');
    const pastaLandingPdf = path.join(process.cwd(), 'landing-page', 'pdf');

    const nomePasta = path.basename(pastaTema);
    const pastaRelativa = path.join('output', nomePasta).replace(/\\/g, '/');

    if (!fs.existsSync(pastaLandingImg)) fs.mkdirSync(pastaLandingImg, { recursive: true });
    if (!fs.existsSync(pastaLandingPdf)) fs.mkdirSync(pastaLandingPdf, { recursive: true });

    const localCoverPt = arquivos.capaPngPt || arquivos.capaPng || null;
    const localCoverEn = arquivos.capaPngEn || null;
    const localImagemTema = arquivos.imagemCapaGerada || null;

    if (localCoverPt) {
        const origem = path.join(pastaTema, localCoverPt);
        const destino = path.join(pastaLandingPdf, localCoverPt);
        if (fs.existsSync(origem)) fs.copyFileSync(origem, destino);
    }
    if (localCoverEn) {
        const origem = path.join(pastaTema, localCoverEn);
        const destino = path.join(pastaLandingPdf, localCoverEn);
        if (fs.existsSync(origem)) fs.copyFileSync(origem, destino);
    }
    if (localImagemTema) {
        const origem = path.join(pastaTema, localImagemTema);
        const destino = path.join(pastaLandingImg, localImagemTema);
        if (fs.existsSync(origem)) fs.copyFileSync(origem, destino);
    }

    const payloadArquivos = {
        pastaTema: nomePasta,
        pastaRelativa,
        capaPng: arquivos.capaPng || null,
        capaPngPt: arquivos.capaPngPt || null,
        capaPngEn: arquivos.capaPngEn || null,
        capaPngPathRelativo: localCoverPt ? `pdf/${localCoverPt}` : (arquivos.capaPngPathRelativo || null),
        capaPngPtPathRelativo: localCoverPt ? `pdf/${localCoverPt}` : (arquivos.capaPngPtPathRelativo || null),
        capaPngEnPathRelativo: localCoverEn ? `pdf/${localCoverEn}` : (arquivos.capaPngEnPathRelativo || null),
        pdfPt: arquivos.pdfPt || null,
        pdfEn: arquivos.pdfEn || null,
        paginasPt: arquivos.paginasPt || null,
        paginasEn: arquivos.paginasEn || null,
        imagemCapaGerada: arquivos.imagemCapaGerada || null,
        imagemSitePathRelativo: localImagemTema ? `img/${localImagemTema}` : null,
        atualizadoEm: new Date().toISOString()
    };

    caminhosSite.forEach((sitePath) => {
        try {
            if (!fs.existsSync(sitePath)) return;

            const lista = readJsonFile(sitePath);
            if (!Array.isArray(lista)) {
                console.warn(`⚠️ site.json inválido em ${sitePath} (não é array).`);
                return;
            }

            const idx = lista.findIndex(item => Number(item?.id) === Number(temaId));
            if (idx === -1) {
                console.warn(`⚠️ ID ${temaId} não encontrado em ${sitePath}.`);
                return;
            }

            lista[idx].arquivos = {
                ...(lista[idx].arquivos || {}),
                ...payloadArquivos
            };

            writeJsonFile(sitePath, lista);
            console.log(`📝 site.json atualizado (${path.relative(process.cwd(), sitePath)}): pasta/PNG do ID ${temaId}`);
        } catch (err) {
            console.error(`❌ Erro ao atualizar ${sitePath}:`, err.message);
        }
    });
}

function caminhoRelativoProjeto(caminho) {
    if (!caminho) return null;
    return path.relative(process.cwd(), caminho).replace(/\\/g, '/');
}

function caminhoArquivoTema(pastaTema, arquivo) {
    if (!arquivo) return null;
    return caminhoRelativoProjeto(path.join(pastaTema, arquivo));
}

function montarConfigComercialBonus(index, item = {}) {
    const ordem = index + 1;
    const isOrderBump = ordem <= 2;

    return {
        tipo_oferta: item?.tipo_oferta || (isOrderBump ? "order_bump" : "bonus_gratuito"),
        etapa_checkout: item?.etapa_checkout || (isOrderBump ? "antes_do_pagamento" : "entrega_pos_compra"),
        cobrar: typeof item?.cobrar === "boolean" ? item.cobrar : isOrderBump,
        preco: {
            moeda: "BRL",
            valor: typeof item?.preco?.valor === "number" ? item.preco.valor : (isOrderBump ? 7.99 : 0),
            valor_formatado: item?.preco?.valor_formatado || (isOrderBump ? "R$ 7,99" : "R$ 0,00")
        },
        kiwify: {
            configurar_como: item?.kiwify?.configurar_como || (isOrderBump ? "order_bump" : "conteudo_incluso"),
            observacao: item?.kiwify?.observacao || (isOrderBump
                ? "Oferecer antes do pagamento como adicional de R$ 7,99."
                : "Entregar gratuitamente dentro da area de membros junto com o ebook principal.")
        }
    };
}

function montarRegistroSubir(tema, pastaTema, arquivos = {}, bonus = []) {
    const nomePasta = path.basename(pastaTema);
    const pastaRelativa = caminhoRelativoProjeto(pastaTema);
    const landingUrl = `landing-page/index.html?id=${tema.id}`;

    return {
        id: tema.id,
        subir: false,
        tem_video: false,
        status: "aguardando_liberacao_manual",
        plataformas: {
            kiwify: {
                habilitado: true,
                produto_tipo: "ebook"
            },
            amazon_ebooks: {
                habilitado: true,
                produto_tipo: "ebook"
            }
        },
        preco: {
            moeda: "BRL",
            valor: 37,
            valor_formatado: "R$ 37,00"
        },
        titulo: tema.nome || null,
        titulo_en: tema.name || null,
        categoria: tema.principal || null,
        categoria_en: tema.main || null,
        subtitulo: tema.subtitulo || null,
        descricao: tema.subtitulo || null,
        pasta: {
            nome: nomePasta,
            relativa: pastaRelativa,
            absoluta: pastaTema
        },
        arquivos: {
            pdf_pt: {
                nome: arquivos.pdfPt || null,
                caminho: caminhoArquivoTema(pastaTema, arquivos.pdfPt),
                paginas: arquivos.paginasPt || null
            },
            pdf_en: {
                nome: arquivos.pdfEn || null,
                caminho: caminhoArquivoTema(pastaTema, arquivos.pdfEn),
                paginas: arquivos.paginasEn || null
            },
            capa_pt: {
                nome: arquivos.capaPngPt || arquivos.capaPng || null,
                caminho: caminhoArquivoTema(pastaTema, arquivos.capaPngPt || arquivos.capaPng)
            },
            capa_en: {
                nome: arquivos.capaPngEn || null,
                caminho: caminhoArquivoTema(pastaTema, arquivos.capaPngEn)
            },
            imagem_principal: {
                nome: arquivos.imagemCapaGerada || null,
                caminho: caminhoArquivoTema(pastaTema, arquivos.imagemCapaGerada)
            }
        },
        bonus: (Array.isArray(bonus) ? bonus : []).map((item, index) => ({
            ordem: index + 1,
            titulo: item?.title || item?.titulo || `Bonus ${index + 1}`,
            descricao: item?.desc || null,
            valor_declarado: item?.value || null,
            comercial: montarConfigComercialBonus(index, item),
            arquivos: {
                pdf: {
                    nome: item?.arquivos?.pdf || item?.pdf || null,
                    caminho: caminhoArquivoTema(pastaTema, item?.arquivos?.pdf || item?.pdf)
                },
                capa: {
                    nome: item?.arquivos?.capa || item?.capa || null,
                    caminho: caminhoArquivoTema(pastaTema, item?.arquivos?.capa || item?.capa)
                },
                imagem: {
                    nome: item?.arquivos?.imagem || item?.imagem || null,
                    caminho: caminhoArquivoTema(pastaTema, item?.arquivos?.imagem || item?.imagem)
                }
            }
        })),
        landing_page: {
            url_local: landingUrl,
            site_json: "landing-page/site.json"
        },
        automacao: {
            pronto_para_script: false,
            observacao: "Altere subir para true manualmente quando quiser liberar este ebook para automacao de upload."
        },
        atualizado_em: new Date().toISOString()
    };
}

function atualizarSubirJson(tema, pastaTema, arquivos = {}) {
    const subirPath = path.join(process.cwd(), 'subir.json');
    const listaAtual = fs.existsSync(subirPath) ? readJsonFile(subirPath) : [];
    const lista = Array.isArray(listaAtual) ? listaAtual : [];
    const registroExistente = lista.find(item => Number(item?.id) === Number(tema.id));
    const registroNovo = montarRegistroSubir(tema, pastaTema, arquivos, tema?.bonus || []);

    if (registroExistente) {
        registroNovo.subir = registroExistente.subir === true;
        registroNovo.tem_video = registroExistente.tem_video === true;
        registroNovo.status = registroNovo.subir ? "liberado_para_upload" : "aguardando_liberacao_manual";
        registroNovo.automacao.pronto_para_script = registroNovo.subir;
    }

    const index = lista.findIndex(item => Number(item?.id) === Number(tema.id));
    if (index === -1) {
        lista.push(registroNovo);
    } else {
        lista[index] = {
            ...registroExistente,
            ...registroNovo
        };
    }

    writeJsonFile(subirPath, lista);
    console.log(`📝 subir.json atualizado: ID ${tema.id} (${registroNovo.subir ? 'liberado' : 'aguardando flag subir=true'})`);
}

function salvarBonusNoTemasJson(temaId, bonusAtualizados) {
    try {
        const temasPath = path.join(process.cwd(), 'temas.json');
        if (!fs.existsSync(temasPath)) return;

        const temas = readJsonFile(temasPath);
        if (!Array.isArray(temas)) return;

        const idx = temas.findIndex(t => Number(t?.id) === Number(temaId));
        if (idx === -1) return;

        temas[idx].bonus = bonusAtualizados;
        writeJsonFile(temasPath, temas);
    } catch (err) {
        console.error("❌ Erro ao salvar bonus no temas.json:", err.message);
    }
}

function extrairHtmlBonus(bonus) {
    if (typeof bonus?.conteudo === "string" && bonus.conteudo.trim()) {
        return bonus.conteudo.trim();
    }

    if (typeof bonus?.html === "string" && bonus.html.trim()) {
        return bonus.html.trim();
    }

    return "";
}

function escaparHtml(texto = '') {
    return String(texto)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function decodificarEntidadesHtmlBasicas(texto = '') {
    return String(texto)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function limparHtmlBonus(html = '') {
    let texto = sanitizarTexto(decodificarEntidadesHtmlBasicas(html));

    texto = texto
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<input[^>]*type=["']?checkbox["']?[^>]*>/gi, '')
        .replace(/<br\s*\/?>/gi, '<br>')
        .replace(/<\/?(?:table|thead|tbody|tr|td|th)[^>]*>/gi, ' ')
        .replace(/^\s*\|?[-:\s|]{3,}\|?\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return texto;
}

function markdownBasicoParaHtml(markdown = '') {
    const texto = String(markdown || '').replace(/\r\n/g, '\n').trim();
    if (!texto) return '';

    const linhas = texto.split('\n');
    let html = '';
    let emLista = false;
    let emListaOrdenada = false;
    let bufferParagrafo = [];

    const fecharParagrafo = () => {
        if (!bufferParagrafo.length) return;
        html += `<p>${bufferParagrafo.join(' ').trim()}</p>\n`;
        bufferParagrafo = [];
    };

    const fecharListas = () => {
        if (emLista) {
            html += '</ul>\n';
            emLista = false;
        }
        if (emListaOrdenada) {
            html += '</ol>\n';
            emListaOrdenada = false;
        }
    };

    const inline = (valor) => escaparHtml(valor)
        .replace(/&lt;br\s*\/?&gt;/gi, ' ')
        .replace(/\[x\]\s*/gi, '')
        .replace(/\[\s\]\s*/g, '')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');

    for (const linhaOriginal of linhas) {
        const linha = linhaOriginal.trim();

        if (!linha) {
            fecharParagrafo();
            fecharListas();
            continue;
        }

        if (/^#{1,6}\s+/.test(linha)) {
            fecharParagrafo();
            fecharListas();
            const nivel = Math.min((linha.match(/^#+/)[0] || '#').length + 1, 6);
            const conteudo = linha.replace(/^#{1,6}\s+/, '');
            html += `<h${nivel}>${inline(conteudo)}</h${nivel}>\n`;
            continue;
        }

        if (/^\|.*\|$/.test(linha)) {
            fecharParagrafo();
            fecharListas();

            const celulas = linha
                .split('|')
                .map(celula => celula.trim())
                .filter(Boolean);

            const separador = celulas.length > 0 && celulas.every(celula => /^:?-{3,}:?$/.test(celula));
            if (!separador && celulas.length) {
                html += `<p>${celulas.map(inline).join(' - ')}</p>\n`;
            }

            continue;
        }

        if (/^[-*_]{3,}$/.test(linha)) {
            fecharParagrafo();
            fecharListas();
            continue;
        }

        if (/^>\s+/.test(linha)) {
            fecharParagrafo();
            fecharListas();
            html += `<p>${inline(linha.replace(/^>\s+/, ''))}</p>\n`;
            continue;
        }

        if (/^\d+\.\s+/.test(linha)) {
            fecharParagrafo();
            if (emLista) {
                html += '</ul>\n';
                emLista = false;
            }
            if (!emListaOrdenada) {
                html += '<ol>\n';
                emListaOrdenada = true;
            }
            html += `<li>${inline(linha.replace(/^\d+\.\s+/, ''))}</li>\n`;
            continue;
        }

        if (/^[-*]\s+/.test(linha)) {
            fecharParagrafo();
            if (emListaOrdenada) {
                html += '</ol>\n';
                emListaOrdenada = false;
            }
            if (!emLista) {
                html += '<ul>\n';
                emLista = true;
            }
            html += `<li>${inline(linha.replace(/^[-*]\s+/, ''))}</li>\n`;
            continue;
        }

        fecharListas();
        bufferParagrafo.push(inline(linha));
    }

    fecharParagrafo();
    fecharListas();
    return html.trim();
}

function normalizarConteudoBonusParaHtml(conteudo) {
    const texto = limparHtmlBonus(String(conteudo || '').trim());
    if (!texto) return '';

    const pareceHtml = /<(h\d|p|ul|ol|li|section|article|div)\b/i.test(texto);
    const temMarkdownProblematico = /^\s*\|.*\|\s*$/m.test(texto)
        || /^\s*#{1,6}\s+/m.test(texto)
        || /^\s*[-*]\s+/m.test(texto)
        || /^\s*\d+\.\s+/m.test(texto)
        || /\[[ x]\]/i.test(texto);

    if (pareceHtml && !temMarkdownProblematico) {
        return limparHtmlBonus(texto);
    }

    return markdownBasicoParaHtml(texto);
}

async function gerarConteudoBonusIA(tema, bonus) {
    const tituloBonus = String(bonus?.title || "Material Bonus").trim();
    const promptUsuario = String(bonus?.prompt || "").trim();
    const promptBase = promptUsuario || `
        Você está escrevendo um material bônus premium para o e-book "${tema.nome}".
        Título do bônus: "${tituloBonus}".
    `;

    const regras = `
        Regras obrigatórias:
        - Escreva em português do Brasil com acentuação correta.
        - Entregue conteúdo útil, prático, aprofundado e objetivo.
        - Retorne APENAS HTML válido com <h2>, <h3>, <p>, <ul> e <ol>.
        - Não use Markdown, tabelas, checkboxes, inputs HTML, caractere "|" ou quadros-resumo.
        - Desenvolva cada ideia em parágrafos completos, com exemplos reais, erros comuns, exercícios e orientação passo a passo.
        - Evite frases robóticas, clichês de IA, aberturas genéricas e conclusões vazias.
        - Não use caracteres quebrados, símbolos estranhos ou substituições como "a@?o".
        ${instrucoesPtBrExtras()}
    `;

    const partes = [
        {
            nome: "fundamentos e diagnóstico",
            foco: "contexto do bônus, problema que ele resolve, princípios, diagnóstico inicial, erros comuns e exemplos práticos"
        },
        {
            nome: "aplicação e plano de ação",
            foco: "passo a passo, exercícios, checklist, critérios de uso, exemplos de aplicação e próximos passos"
        }
    ];

    let html = "";
    for (let i = 0; i < partes.length; i++) {
        const contexto = montarContextoComplemento(html);
        const promptParte = `
            ${promptBase}

            Gere a parte ${i + 1}/${partes.length} do bônus: ${partes[i].nome}.
            Foco desta parte: ${partes[i].foco}.
            ${i > 0 ? `Resumo da parte anterior para evitar repetição: ${contexto.resumo}` : ""}

            Regras de tamanho:
            - Gere entre 850 e 1100 palavras nesta parte.
            - Não tente fechar o bônus inteiro se ainda houver próxima parte.

            ${regras}
        `;

        const trecho = await chamarGroqTexto(promptParte, {
            temperature: 0.65,
            maxCompletionTokens: 1700,
            origem: `bonus:${tema.id}:${tituloBonus}:parte_${i + 1}`
        });
        assertTextoValido(trecho, `bonus:${tema.id}:${tituloBonus}:parte_${i + 1}`);
        html += `\n${trecho}`;
    }

    html = sanitizarTexto(html.trim());
    assertTextoValido(html, `bonus:${tema.id}:${tituloBonus}`);
    return html;
}

async function montarCapitulosBonus(tema, bonus, fallbackCapitulos = [], options = {}) {
    const htmlBonus = normalizarConteudoBonusParaHtml(extrairHtmlBonus(bonus));
    const forceRegenerateContent = options?.regenerateContent === true;

    if (htmlBonus && !forceRegenerateContent) {
        assertTextoValido(htmlBonus, `bonus_existente:${tema.id}:${bonus?.title || "Bonus"}`);
        return [{
            titulo: String(bonus?.title || "Bonus").trim(),
            html: htmlBonus
        }];
    }

    if (String(bonus?.prompt || "").trim()) {
        const htmlGerado = await gerarConteudoBonusIA(tema, bonus);
        bonus.conteudo = normalizarConteudoBonusParaHtml(htmlGerado);

        return [{
            titulo: String(bonus?.title || "Bonus").trim(),
            html: bonus.conteudo
        }];
    }

    return Array.isArray(fallbackCapitulos) ? fallbackCapitulos : [];
}

function montarPromptImagemBonus(tema, bonus) {
    const contexto = String(bonus?.desc || tema?.subtitulo || '').trim() || 'cena humana, atmosfera elegante, composição cinematográfica e limpa';
    const promptBase = `
        Gere apenas uma ilustração ou fotografia conceitual pura, sem design de capa, sem layout, sem elementos editoriais e sem qualquer texto embutido.
        Crie uma cena visual coerente com o material bônus do e-book "${tema.nome}".
        Interprete o assunto de forma indireta e simbólica, transformando o tema em ambiente, emoção, objetos, luz, postura, contexto e narrativa visual.
        Contexto visual: ${contexto}.
        Estilo: cinematográfico, sofisticado, realista ou semi-realista, composição limpa, foco total na cena, na atmosfera e nos elementos visuais, paleta coerente com ${tema.cor}.
        Evite qualquer coisa que pareça capa de livro, poster, anúncio, manchete, slide, thumbnail, interface, mockup, embalagem ou peça gráfica.
        Represente o conceito apenas por símbolos, pessoas, cenário, objetos, composição e iluminação, sem qualquer texto visível.
    `.trim();

    const restricaoSemTexto = `
        Regras visuais obrigatórias:
        - sem texto
        - sem letras
        - sem palavras
        - sem tipografia
        - sem números
        - sem logotipos
        - sem marcas d'água
        - sem capa de livro
        - sem poster
        - sem headline
        - sem selo
        - sem interface
        - sem qualquer caractere visível
        - imagem puramente visual, cinematográfica e limpa
    `.trim();

    return `${promptBase}. ${restricaoSemTexto}`;
}

async function gerarEbooksBonus(tema, capitulosAcumuladosPT, pastaTema, options = {}) {
    const listaBonus = Array.isArray(tema?.bonus) ? tema.bonus : [];
    if (!listaBonus.length) {
        return [];
    }

    const force = options?.force === true;
    const maxTentativasImagemBonus = 6;
    const resultados = [];

    for (let i = 0; i < listaBonus.length; i++) {
        const bonus = listaBonus[i];

        if (bonus?.feito === true && !force) {
            console.log(` 🎁 Pulando bonus ja concluido: ${bonus.title || `Bonus ${i + 1}`}`);
            continue;
        }

        const tituloBonus = String(bonus?.title || `Bonus ${i + 1}`).trim();
        const promptBonus = montarPromptImagemBonus(tema, bonus);

        console.log(` 🎁 Gerando bonus ${i + 1}/${listaBonus.length}: ${tituloBonus}`);

        let imagemBonus = null;
        let tentativaImagem = 0;

        while (!imagemBonus && tentativaImagem < maxTentativasImagemBonus) {
            tentativaImagem += 1;
            const nomeArquivoBonus = `bonus_${tema.id}_${i + 1}`;
            const imagemGerada = await generateImage(nomeArquivoBonus, promptBonus, POLLINATIONS_KEY);

            if (!imagemGerada) {
                continue;
            }

            const caminhoImagemGerada = path.join('output', imagemGerada);

            try {
                const temTexto = await imagemPareceTerTexto(caminhoImagemGerada);

                if (temTexto) {
                    console.warn(`⚠️ Imagem do bônus com texto detectado. Regenerando (${tentativaImagem}/${maxTentativasImagemBonus}): ${tituloBonus}`);
                    if (fs.existsSync(caminhoImagemGerada)) {
                        fs.unlinkSync(caminhoImagemGerada);
                    }
                    continue;
                }

                imagemBonus = imagemGerada;
            } catch (err) {
                console.error(`❌ Falha ao validar texto na imagem do bônus "${tituloBonus}":`, err.message);
                if (fs.existsSync(caminhoImagemGerada)) {
                    fs.unlinkSync(caminhoImagemGerada);
                }
                throw err;
            }
        }

        if (!imagemBonus) {
            throw new Error(`Nao foi possivel gerar uma imagem sem texto para o bônus "${tituloBonus}" após ${maxTentativasImagemBonus} tentativas.`);
        }

        const temaBonus = {
            ...tema,
            nome: `${tema.nome} - ${tituloBonus}`,
            name: `${tema.name || tema.nome} - ${tituloBonus}`,
            principal: "Material Bonus",
            main: "Bonus Material"
        };
        const capitulosBonus = await montarCapitulosBonus(tema, bonus, capitulosAcumuladosPT, {
            regenerateContent: force
        });

        const resultadoBonus = await gerarPDF(
            temaBonus,
            capitulosBonus,
            "pt",
            pastaTema,
            imagemBonus,
            {
                capaModo: "bonus",
                principalCapa: "Material Bonus",
                tituloCapa: tituloBonus,
                imagemCapaArquivo: imagemBonus
            }
        );

        if (imagemBonus) {
            const origemImagem = path.join('output', imagemBonus);
            const destinoImagem = path.join(pastaTema, imagemBonus);
            try {
                if (fs.existsSync(origemImagem)) {
                    fs.renameSync(origemImagem, destinoImagem);
                }
            } catch (err) {
                console.error("❌ Erro ao mover imagem do bonus:", err.message);
            }
        }

        bonus.arquivos = {
            pdf: resultadoBonus?.pdfFileName || null,
            capa: resultadoBonus?.capaPngFileName || null,
            imagem: imagemBonus || null,
            geradoEm: new Date().toISOString()
        };
        bonus.feito = true;
        bonus.status = force ? "regenerado" : "gerado";

        resultados.push({
            title: tituloBonus,
            pdf: resultadoBonus?.pdfFileName || null,
            capa: resultadoBonus?.capaPngFileName || null
        });
    }

    salvarBonusNoTemasJson(tema.id, listaBonus);
    return resultados;
}

async function gerarSomenteBonusPorId(temaId, options = {}) {
    const temas = readJsonFile('temas.json');
    const tema = temas.find(t => Number(t.id) === Number(temaId));

    if (!tema) {
        throw new Error(`Tema com id ${temaId} nao encontrado em temas.json`);
    }

    console.log(`🎁 Gerando somente os bonus do ID ${tema.id}: ${tema.nome}`);

    const pastaTema = criarPastaTema(tema);
    const progresso = carregarProgressoLocal(tema.id);
    const capitulosAcumuladosPT = Array.isArray(progresso?.pt) ? progresso.pt : [];
    const bonusGerados = await gerarEbooksBonus(tema, capitulosAcumuladosPT, pastaTema, options);

    if (!bonusGerados.length) {
        console.log("⚠️ Nenhum bonus foi gerado. Verifique se ja estavam concluídos ou se faltam conteúdos.");
        return [];
    }

    console.log(`🎁 Bonus processados: ${bonusGerados.map(b => b.title).join(" | ")}`);
    return bonusGerados;
}

async function gerarReferenciasIA(tema, idioma = "pt") {
    const prompt = `
        Aja como um bibliotecário e pesquisador. 
        Gere uma lista de 5 referências bibliográficas (livros, artigos ou sites de autoridade) que dariam suporte ao e-book "${tema.principal} - ${tema.nome}".
        
        REGRAS:
        - O título da seção deve ser "${idioma === 'pt' ? 'Referências' : 'References'}".
        - Use o formato de citação padrão.
        - Para cada item, invente um link fictício mas realista que aponte para domínios como .org, .edu ou .gov.
        - Retorne APENAS o conteúdo em HTML usando <h2> para o título e <ul>/<li> para a lista.
        - Idioma: ${idioma === 'pt' ? 'Português' : 'Inglês'}.
        ${idioma === 'pt' ? instrucoesPtBrExtras() : ''}
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.6,
        });

        return sanitizarTexto(response.choices[0].message.content.replace(/```html|```/g, "").trim());
    } catch (error) {
        console.error("❌ Erro ao gerar referências:", error.message);
        return `<h2>${idioma === 'pt' ? 'Referências' : 'References'}</h2><ul><li>Wikipedia.org</li><li>Britannica.com</li></ul>`;
    }
}

async function gerarSomenteCapaParaTestePorId(temaId, idioma = "pt") {
    const temas = readJsonFile('temas.json');
    const temaBase = temas.find(t => Number(t.id) === Number(temaId));

    if (!temaBase) {
        throw new Error(`Tema com id ${temaId} nao encontrado em temas.json`);
    }

    console.log(`🧪 Gerando SOMENTE a capa de teste para ID ${temaBase.id}: ${temaBase.nome}`);

    const tema = idioma === "en"
        ? { ...temaBase, nome: temaBase.name }
        : temaBase;

    let imagemCapa = null;
    while (!imagemCapa) {
        imagemCapa = await generateImage(temaBase.name, temaBase.prompt_image, POLLINATIONS_KEY);
    }

    const pastaTema = criarPastaTema(temaBase);
    const resultado = await gerarPDF(tema, [], idioma, pastaTema, imagemCapa, { somenteCapa: true });

    if (imagemCapa) {
        const caminhoAntigo = path.join('output', imagemCapa);
        const novoCaminho = path.join(pastaTema, imagemCapa);
        try {
            if (fs.existsSync(caminhoAntigo)) {
                fs.renameSync(caminhoAntigo, novoCaminho);
                console.log(`📸 Imagem base da capa movida para: ${novoCaminho}`);
            }
        } catch (err) {
            console.error("❌ Erro ao mover imagem base da capa de teste:", err.message);
        }
    }

    return resultado;
}

function coletarRelatoriosTextoObjeto(valor, origem = 'root', relatorios = []) {
    if (typeof valor === 'string') {
        relatorios.push(validarCaracteresTexto(valor, origem));
        return relatorios;
    }

    if (Array.isArray(valor)) {
        valor.forEach((item, index) => coletarRelatoriosTextoObjeto(item, `${origem}[${index}]`, relatorios));
        return relatorios;
    }

    if (valor && typeof valor === 'object') {
        Object.entries(valor).forEach(([chave, item]) => {
            coletarRelatoriosTextoObjeto(item, `${origem}.${chave}`, relatorios);
        });
    }

    return relatorios;
}

function validarTextosConfiguracao() {
    const temas = readJsonFile('temas.json');
    const relatorios = coletarRelatoriosTextoObjeto(temas, 'temas');
    salvarRelatorioValidacaoTexto('config', relatorios);

    const erros = relatorios.flatMap(r => r.erros || []);
    if (erros.length) {
        console.error(`❌ Validação encontrou ${erros.length} problema(s) de texto. Veja output/validacao_texto_tema_config.json`);
        erros.slice(0, 10).forEach((erro) => {
            console.error(` - ${erro.codigo} em ${erro.origem}: "${erro.encontrado}" | ${erro.trecho}`);
        });
        throw new Error("temas.json possui caracteres corrompidos.");
    }

    console.log("✅ Validação de textos concluída: nenhum caractere corrompido encontrado em temas.json.");
}

async function processarTema(tema) {
    console.log(`\n🚀 Iniciando processamento do Tema: ${tema.nome} (ID: ${tema.id})`);
    const deveTraduzir = tema.traduzir === true;

    // 1. Tenta carregar progresso anterior
    let progresso = carregarProgressoLocal(tema.id);
    const capitulosAcumuladosPT = progresso.pt;
    const capitulosAcumuladosEN = progresso.en;

    var imagemCapa = null

    while (!imagemCapa) {
        imagemCapa = await generateImage(tema.name, tema.prompt_image, POLLINATIONS_KEY);
    }

    const blueprint = tema.estrutura;
    const totalCapitulos = Math.max(
        Number(blueprint?.totalItens || 0),
        Array.isArray(blueprint?.capitulos) ? blueprint.capitulos.length : 0
    );

    for (let i = 1; i <= totalCapitulos; i++) {
        const capituloConfig = blueprint.capitulos[i - 1];
        if (!Array.isArray(capituloConfig)) {
            throw new Error(`Configuração inválida: tema ${tema.id} informa ${totalCapitulos} capítulos, mas o capítulo ${i} não existe.`);
        }

        const [capituloNome, chapterName, jaConcluido, topico_detalhado, ctd] = capituloConfig;

        // 2. Se o capítulo já está marcado como true no JSON, nós pulamos a geração
        if (jaConcluido && capitulosAcumuladosPT[i - 1]) {
            console.log(` ✅ Pulando (já concluído): ${capituloNome}`);
            continue;
        }

        console.log(`\n ✍️ Gerando capítulo ${i}/${totalCapitulos}: ${capituloNome}`);

        // 3. Gera Português (com a lógica de espera que passamos antes)
        const htmlPT = await executarGeracaoProfunda(tema, capituloNome, false, topico_detalhado, ctd);
        capitulosAcumuladosPT[i - 1] = { titulo: capituloNome, html: htmlPT };

        // 4. Traduz para Inglês (somente se habilitado no tema)
        if (deveTraduzir) {
            console.log(` 🌐 Traduzindo para Inglês...`);
            const htmlEN = await traduzirParaIngles(htmlPT);
            capitulosAcumuladosEN[i - 1] = { titulo: chapterName, html: htmlEN };
        }

        // 5. Salva backup imediato para o caso de queda
        salvarProgressoLocal(tema.id, { pt: capitulosAcumuladosPT, en: capitulosAcumuladosEN });

        // 6. Marca no seu temas.json principal como concluído
        marcarCapituloConcluido(tema.id, i - 1);
    }

    console.log(` 📚 Gerando bibliografia e referências...`);
    // const refsPT = await gerarReferenciasIA(tema, "pt");
    // const refsEN = await gerarReferenciasIA(tema, "en");

    // capitulosAcumuladosPT.push({ titulo: "Referências", html: refsPT });
    // capitulosAcumuladosEN.push({ titulo: "References", html: refsEN });

    // 7. Finalização do PDF
    const pastaTema = criarPastaTema(tema);
    const gerarPdfPt = async (capitulos) => gerarPDF(tema, capitulos, "pt", pastaTema, imagemCapa, {
        exigirMinimoPaginas: false
    });
    const reforcoPT = await reforcarCapitulosAteMinimoPaginas(tema, capitulosAcumuladosPT, gerarPdfPt);
    capitulosAcumuladosPT.splice(0, capitulosAcumuladosPT.length, ...reforcoPT.capitulos);
    salvarProgressoLocal(tema.id, { pt: capitulosAcumuladosPT, en: capitulosAcumuladosEN });

    const resultadoPT = reforcoPT.resultado;
    let resultadoEN = null;
    if (deveTraduzir) {
        resultadoEN = await gerarPDF({ ...tema, nome: tema.name }, capitulosAcumuladosEN, "en", pastaTema, imagemCapa, {
            exigirMinimoPaginas: false
        });
    } else {
        console.log(" ⏭️ Tradução desativada para este tema (traduzir=false). Pulando PDF em inglês.");
    }

    if (imagemCapa) {
        const caminhoAntigo = path.join('output', imagemCapa);
        const novoCaminho = path.join(pastaTema, imagemCapa);

        try {
            if (fs.existsSync(caminhoAntigo)) {
                fs.renameSync(caminhoAntigo, novoCaminho);
                console.log(`📸 Imagem da capa movida para: ${pastaTema}`);
            }
        } catch (err) {
            console.error("❌ Erro ao mover a imagem da capa:", err.message);
        }
    }

    const bonusGerados = await gerarEbooksBonus(tema, capitulosAcumuladosPT, pastaTema);
    if (bonusGerados.length) {
        console.log(` 🎁 Bônus gerados: ${bonusGerados.map(b => b.title).join(" | ")}`);
    }

    const arquivosFinalizados = {
        capaPng: resultadoPT?.capaPngFileName || null,
        capaPngPt: resultadoPT?.capaPngFileName || null,
        capaPngEn: resultadoEN?.capaPngFileName || null,
        capaPngPathRelativo: resultadoPT?.capaPngFileName ? path.join('output', path.basename(pastaTema), resultadoPT.capaPngFileName).replace(/\\/g, '/') : null,
        capaPngPtPathRelativo: resultadoPT?.capaPngFileName ? path.join('output', path.basename(pastaTema), resultadoPT.capaPngFileName).replace(/\\/g, '/') : null,
        capaPngEnPathRelativo: resultadoEN?.capaPngFileName ? path.join('output', path.basename(pastaTema), resultadoEN.capaPngFileName).replace(/\\/g, '/') : null,
        pdfPt: resultadoPT?.pdfFileName || null,
        pdfEn: resultadoEN?.pdfFileName || null,
        paginasPt: resultadoPT?.totalPaginas || null,
        paginasEn: resultadoEN?.totalPaginas || null,
        imagemCapaGerada: imagemCapa || null
    };

    salvarArquivosNoSiteJson(tema.id, pastaTema, arquivosFinalizados);
    atualizarSubirJson(tema, pastaTema, arquivosFinalizados);

    // 8. Limpa o arquivo de backup após concluir tudo
    const backupPath = path.join('output', `progresso_tema_${tema.id}.json`);
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    marcarComoConcluido(tema.id);
    console.log(`\n✔ PDF ${tema.nome} finalizado com sucesso!`);
}

(async () => {
    try {
        const args = process.argv.slice(2);
        const capaIdArg = args.find(a => a.startsWith('--capa-id='));
        const capaIdIndex = args.findIndex(a => a === '--capa-id');
        const bonusIdArg = args.find(a => a.startsWith('--bonus-id='));
        const bonusIdIndex = args.findIndex(a => a === '--bonus-id');
        const idiomaArg = args.find(a => a.startsWith('--idioma='));
        const forcarBonus = args.includes('--forcar-bonus');
        const validarTextos = args.includes('--validar-textos');

        const capaId = capaIdArg
            ? Number(capaIdArg.split('=')[1])
            : (capaIdIndex !== -1 ? Number(args[capaIdIndex + 1]) : null);
        const bonusId = bonusIdArg
            ? Number(bonusIdArg.split('=')[1])
            : (bonusIdIndex !== -1 ? Number(args[bonusIdIndex + 1]) : null);

        const idiomaTeste = idiomaArg ? (idiomaArg.split('=')[1] || 'pt') : 'pt';

        if (validarTextos) {
            validarTextosConfiguracao();
            return;
        }

        if (capaId && !Number.isNaN(capaId)) {
            await gerarSomenteCapaParaTestePorId(capaId, idiomaTeste === 'en' ? 'en' : 'pt');
            console.log(`\n✔ Capa de teste do ID ${capaId} gerada com sucesso (sem marcar capítulos como concluídos).`);
            return;
        }

        if (bonusId && !Number.isNaN(bonusId)) {
            await gerarSomenteBonusPorId(bonusId, { force: forcarBonus });
            console.log(`\n✔ Bonus do ID ${bonusId} processados com sucesso.`);
            return;
        }

        const dados = fs.readFileSync('temas.json', 'utf8');
        let dados_parse = parseJsonSafe(dados);

        console.log(`🚀 Iniciando processamento de ${dados_parse.length} temas...`);

        for (let index = 0; index < dados_parse.length; index++) {
            // Busca sempre o próximo disponível para garantir sincronia com o arquivo físico
            const tema = buscarProximoTema();

            if (!tema) {
                console.log("✅ Todos os temas do arquivo JSON já foram concluídos!");
                break; // Use break para sair do loop corretamente
            } else {
                // O 'await' aqui é a chave: ele trava o loop até o PDF ser finalizado
                await processarTema(tema);
                console.log(`\n--- [${index + 1}/${dados_parse.length}] Tema concluído com sucesso ---\n`);
            }
        }
    } catch (error) {
        console.error("❌ Erro crítico no loop de execução:", error.message);
    }
})();
