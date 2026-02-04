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

if (!GROQ_KEY) {
    console.error("❌ ERRO FATAL: A variável GROQ_API_KEY (Groq) não foi encontrada no arquivo .env!");
    process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_KEY });

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
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });

        const cleanContent = response.choices[0].message.content.replace(/```json|```/g, "").trim();
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
    const file = (idioma == "pt")?'backup-html-pt.txt':'backup-html-en.txt';

    const backup = path.join(caminhoTema, file);

    fs.writeFileSync(backup, conteudo, 'utf8');
}

function buscarProximoTema() {
    const data = fs.readFileSync('temas.json', 'utf8');
    let busca_temas = JSON.parse(data);

    const proximo = busca_temas.find(t => t.feito === false);

    if (!proximo) {
        console.log("Todos os PDFs já foram gerados!");
        return null;
    }

    return proximo;
}

function marcarComoConcluido(id) {
    const data = fs.readFileSync('temas.json', 'utf8');
    let dados_temas = JSON.parse(data);

    const index = dados_temas.findIndex(t => t.id === id);

    if (index !== -1) {
        dados_temas[index].feito = true;

        fs.writeFileSync('temas.json', JSON.stringify(dados_temas, null, 2), 'utf8');
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
    `;

    const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
    });

    try {
        const cleanContent = response.choices[0].message.content.replace(/```json|```/g, "").trim();
        
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error("Erro ao parsear estrutura detalhada, usando fallback.");
        
        return [temaNome, "Conceitos Fundamentais", "Aplicações Práticas", "Conclusão Detalhada"];
    }
}

async function escreverTopicoProfundo(temaPrincipal, subtema, topicoEspecifico) {
    const prompt = topicoEspecifico 
        ? `Você está escrevendo uma seção de um e-book profissional sobre "${temaPrincipal} - ${subtema}". Foque EXCLUSIVAMENTE em escrever sobre o subtópico: "${topicoEspecifico}". REGRAS: - Seja técnico, profundo e praga informações práticas. - Mínimo de 600 palavras. - Use HTML (<h2>, <p>, <ul>, <code>).`
        : `Você está escrevendo uma seção de um e-book profissional sobre "${temaPrincipal} - ${subtema}". Foque EXCLUSIVAMENTE em escrever sobre esse capítulo. REGRAS: - Seja técnico, profundo e traga informações práticas. - Mínimo de 600 palavras. - Use HTML (<h2>, <p>, <ul>, <code>).`;

    let sucesso = false;
    let resultado = "";

    while (!sucesso) {
        try {
            const response = await groq.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.8,
            });

            resultado = response.choices[0].message.content;
            sucesso = true; // Sai do loop se der certo
        } catch (error) {
            if (error.status === 429) {
                // Extrai o tempo de espera da mensagem ou usa um padrão de 60 segundos
                console.log(`\n⏳ [RATE LIMIT] Limite atingido no capítulo: ${topicoEspecifico || subtema}`);
                
                // Pega o tempo sugerido pelo erro (retry-after) ou espera 90 segundos por segurança
                const tempoEsperaSegundos = error.headers && error.headers['retry-after'] 
                    ? parseInt(error.headers['retry-after']) + 5 
                    : 90;

                console.warn(`🕒 Aguardando ${tempoEsperaSegundos} segundos para liberar tokens... Não feche o terminal.`);
                
                // Faz o script "dormir"
                await new Promise(resolve => setTimeout(resolve, tempoEsperaSegundos * 1000));
                
                console.log("🚀 Retomando geração...");
            } else {
                // Se for outro erro (ex: internet caida), tenta de novo em 10s
                console.error("❌ Erro de conexão ou API:", error.message);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }

    return resultado;
}

async function traduzirParaIngles(conteudo) {
    const prompt = `Traduza o seguinte conteúdo HTML para o Inglês, mantendo todas as tags HTML e estilos intactos: \n\n${conteudo} e quero apenas a tradução "pura", sem colocar nenhuma frase em português no início, quero só a parte em inglês!`;
    const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
    });
    return response.choices[0].message.content.replace(/```html|```/g, "").trim();
}

function rgbFromHex(hex) {
    if (!hex || typeof hex !== 'string') return rgb(0.8, 0.8, 0.2);

    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    return rgb(r, g, b);
}

async function generateImage(titulo, prompt, HF_TOKEN) {
    const hf = new HfInference(HF_TOKEN);
    
    try {
        const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;
        
        console.log(`🚀 Tentando gerar via Serverless API: ${titulo}...`);

        // const blob = await hf.textToImage({
        //     model: "stabilityai/stable-diffusion-xl-base-1.0",
        //     inputs: prompt,
        //     provider: "hf-inference"
        // });

        const response = await fetch(
            "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0",
            {
                method: "POST",
                headers: {
                "Authorization": "Bearer CLOUDFLARE_API_TOKEN",
                "Content-Type": "application/json"
                },
                body: JSON.stringify({ prompt })
            }
        );

        console.log(response);

        const buffer = Buffer.from(await response.arrayBuffer());

        if (!fs.existsSync('output')) fs.mkdirSync('output');
        fs.writeFileSync(`output/${fileName}`, buffer);
        
        console.log(`✅ Sucesso! Arquivo: output/${fileName}`);

        return fileName;
    } catch (error) {
        console.error("❌ Erro:", error.message);
    }
}

async function gerarImagem(titulo, promptImagem) {
    const fileName = `${titulo.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`;
    const promptCurto = encodeURIComponent(promptImagem.substring(0, 500));
    
    const apis = [
        {
            nome: "Pixart AI",
            url: `https://pixart.pollinations.ai/prompt/${promptCurto}?width=1024&height=1024`
        },
        {
            nome: "Unsplash (Fallback Real)",
            // Se as IAs falharem, busca uma imagem real excelente baseada no título
            url: `https://source.unsplash.com/1024x1024/?${encodeURIComponent(titulo)},technology`
        },
        {
            nome: "Pollinations AI 2",
            url: `https://image.pollinations.ai/prompt/${promptCurto}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000)}`
        }
    ];

    for (const api of apis) {
        try {
            console.log(`🎨 Tentando gerar via ${api.nome}...`);
            
            const response = await axios({
                method: 'get',
                url: api.url,
                responseType: 'arraybuffer',
                timeout: 30000, // 30 segundos por tentativa
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });

            if (response.data && response.data.byteLength > 0) {
                if (!fs.existsSync('output')) fs.mkdirSync('output');
                fs.writeFileSync(`output/${fileName}`, response.data);
                console.log(`✅ Sucesso via ${api.nome}: output/${fileName}`);
                return fileName;
            }
        } catch (error) {
            console.warn(`⚠️ ${api.nome} falhou (Status: ${error.response?.status || 'Timeout'})...`);
            // Continua para a próxima iteração do loop
        }
    }

    console.error("❌ Todas as APIs de imagem falharam.");
    return null;
}

async function gerarIntroducaoDinamica(tema, conteudosAcumulados) {
    const listaTitulos = conteudosAcumulados.map((c, i) => `${i + 1}. ${c.titulo}`).join(", ");

    var prompt = `
        Aja como um editor de e-books profissional.
        Crie uma introdução envolvente e inspiradora para o e-book: "${tema.principal} - ${tema.nome}".
        
        O e-book contém os seguintes tópicos: ${listaTitulos}.
        
        REGRAS:
        - Use uma linguagem calorosa e profissional.
        - Mencione a importância do tema "${tema.nome}" para o leitor.
        - O texto deve ter entre 3 e 4 parágrafos.
        - Retorne APENAS o conteúdo em HTML (usando tags <p>).
        - Não use <h1>, pois o título "Introdução" já existe no template.
        - Termine com uma frase de incentivo.
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8,
        });

        var resp = response.choices[0].message.content.replace(/```html|```/g, "").trim();
        return resp;
    } catch (error) {
        console.error("❌ Erro ao gerar introdução:", error.message);
        return `<p>Bem-vindo ao guia ${tema.nome}. Este material foi preparado para transformar sua experiência com ${tema.principal}.</p>`;
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

async function gerarPDF(tema, capitulosAcumulados, idioma = "pt", pastaTema, imagemCapa) {
    const corTema = tema.cor;
    const corFonte = tema.cor_fonte;
    const principalCapa = (idioma == "pt") ? tema.principal : tema.main;
    const tituloCapa = (idioma == "pt") ? tema.nome : tema.name;
    const icone = tema.icone;
    const sufixo = idioma === "en" ? "english" : "portugues";
    const nomeArquivo = `${tema.nome.replace(/[:*?"<>|/\\]/g, '-')}-${sufixo}`;
    const outputPath = path.join(pastaTema, nomeArquivo);
    const caminhosTemporarios = [];
    const dadosParaIndice = [];
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
    </style>`

    console.log(" 📄 Calculando páginas dos tópicos individualmente...");

    let paginaAtualAcumulada = 1;

    for (let i = 0; i < capitulosAcumulados.length; i++) {
        const topico = capitulosAcumulados[i];
        const pathTemp = `output/_temp_r${i}.pdf`;

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

        if(idioma == "pt"){
            fullHtmlPT += htmlTopicoIndividual
        }else{
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

    const htmlCapa = `
            <div class="cover-full" style="width:100%; background-color:${corTema};">
                <div style="position:relative; width:100%; height:350px; overflow:hidden;">
                    <img src="fundo-capa.png"style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;">
                    <div style="position:absolute;top:0;left:0;right:0;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;z-index:2;">
                        <${estiloPrincipal.tag} class="cover-script" style="margin-top:-15px; font-size:${estiloPrincipal.fontSize} !important; color:#333; font-family: 'Kaushan Script', cursive; line-height: 1.1;">
                            ${principalCapa}
                        </${estiloPrincipal.tag}>
                        
                        <${estiloTitulo.tag} style="font-size:${estiloTitulo.fontSize} !important; color:#FFF; font-family: 'Roboto', sans-serif; padding:5px 20px; border-radius:50px; background-color:#333; margin-top:-15px; display: inline-block; max-width: 90%;">
                            ${tituloCapa}
                        </${estiloTitulo.tag}>
                        <i class="bi ${icone}" style="font-size:20px;color:#333;border-radius:50px;padding:5px 40px;margin-top:-30px;background-color:#FFF;"></i>
                    </div>
                </div>
                <div style="position:relative;margin-top:100px;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 32px;">
                        <div style="height: 1px; width: 96px; background: linear-gradient(to right, transparent, #FFF);"></div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background-color: #FFF;"></div>
                        <div style="height: 1px; width: 128px; background-color: #FFF;"></div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background-color: #FFF;"></div>
                        <div style="height: 1px; width: 96px; background: linear-gradient(to left, transparent, #FFF);"></div>
                    </div>
                    <div style="position: relative;">
                        <div style="position: absolute; top: -16px; bottom: -16px; left: -16px; right: -16px; border-radius: 8px; background-color: #FFF; opacity: 0.3;"></div>
                        <div style="position: absolute; top: -8px; bottom: -8px; left: -8px; right: -8px; background-color: white; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"></div>
                        <div style="position: relative; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);">
                            <img src="./output/${imagemCapa}" style="width: 100%; height: 384px; object-fit: cover; display: block;">
                            <div style="position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.2), transparent);"></div>
                        </div>
                        <div style="position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); padding: 12px 32px; border-radius: 9999px; shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); background-color: #333; white-space: nowrap;">
                            <p style="text-align: center; font-size: 14px; letter-spacing: 0.1em; color: #FFF; margin: 0; font-weight: bold;">
                                ${(idioma == "pt") ? "UMA COLEÇÃO ESPECIAL" : "A SPECIAL COLLECTION"}
                            </p>
                        </div>
                    </div>
                    <div style="margin-top: 48px; padding-left: 48px; padding-right: 48px; padding-bottom: 32px; display: flex; align-items: center; justify-content: space-between;">
                        <div style="flex: 1; height: 1px; background: linear-gradient(to right, #d1d5db, transparent);"></div>
                        <div style="padding: 0 32px;">
                            <div style="width: 80px; height: 80px; border-radius: 50%; background-color: #FFF; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
                                <img src="img/realizart-logo.png" style="width: 40px; height: 40px;" alt="Logo">
                            </div>
                        </div>
                        <div style="flex: 1; height: 1px; background: linear-gradient(to left, #d1d5db, transparent);"></div>
                    </div>
                    <div style="height: 12px; color:${corFonte}; background: linear-gradient(to right, ${corTema}, #888, ${corTema});"></div>
                </div>
            </div>
        </div>
        <div class="page-break" style="page-break-after: always;"></div>
    `;

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

    
    if(idioma == "pt"){
        fullHtmlPT = `<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>`+`<html><head>${css}</head><body>${htmlIndiceFinal}</body></html>`+`<html><head>${css}</head><body>${htmlIntroducao}</body></html>`+fullHtmlPT
        salvarBackupHTML(pastaTema, fullHtmlPT, 'pt');
        
        fs.writeFileSync(
            path.join(pastaTema, 'conteudo-pt.html'),
            fullHtmlPT
        );
    }else{
        fullHtmlEN = `<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>`+`<html><head>${css}</head><body>${htmlIndiceFinal}</body></html>`+`<html><head>${css}</head><body>${htmlIntroducao}</body></html>`+fullHtmlEN
        salvarBackupHTML(pastaTema, fullHtmlEN, 'en');
        
        fs.writeFileSync(
            path.join(pastaTema, 'conteudo-en.html'),
            fullHtmlEN
        );
    }

    const capaPdfPath = `output/_temp_capa.pdf`;
    await gerarPdfSimples(`<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>`, capaPdfPath);

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

    [capaPdfPath, introPdfPath, indicePdfPath, ...caminhosTemporarios].forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

async function executarGeracaoProfunda(tema, capituloNome, precisaSubtopicos) {
    let htmlCapitulo = `<h1>${capituloNome}</h1>`;

    if (precisaSubtopicos) {
        console.log(`  ✍️ Planejando subtópicos para: ${capituloNome}`);
        const subtopicos = await planejarEstruturaDetalhada(tema.principal + " " + tema.nome, capituloNome);

        for (const sub of subtopicos) {
            console.log(`    > Escrevendo profundamente: ${sub}`);
            const trecho = await escreverTopicoProfundo(tema.principal + " " + tema.nome, capituloNome, sub);
            htmlCapitulo += trecho;
        }
    } else {
        console.log(`    > Escrevendo capítulo direto: ${capituloNome}`);
        const trecho = await escreverTopicoProfundo(tema.principal + " " + tema.nome, capituloNome);
        htmlCapitulo += trecho;
    }

    return htmlCapitulo;
}

// Salva o progresso atual do tema para não perder dados se o script cair
function salvarProgressoLocal(temaId, dados) {
    const backupPath = path.join('output', `progresso_tema_${temaId}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(dados, null, 2));
}

// Carrega o progresso se ele existir
function carregarProgressoLocal(temaId) {
    const backupPath = path.join('output', `progresso_tema_${temaId}.json`);
    if (fs.existsSync(backupPath)) {
        return JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    }
    return { pt: [], en: [] };
}

// Atualiza o arquivo temas.json marcando o capítulo como concluído (true)
function marcarCapituloConcluido(temaId, indiceCapitulo) {
    const temasPath = './temas.json'; // Ajuste o caminho se necessário
    const temas = JSON.parse(fs.readFileSync(temasPath, 'utf8'));
    
    const temaIndex = temas.findIndex(t => t.id === temaId);
    if (temaIndex !== -1) {
        temas[temaIndex].estrutura.capitulos[indiceCapitulo][2] = true;
        fs.writeFileSync(temasPath, JSON.stringify(temas, null, 2));
    }
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
    `;

    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.6,
        });

        return response.choices[0].message.content.replace(/```html|```/g, "").trim();
    } catch (error) {
        console.error("❌ Erro ao gerar referências:", error.message);
        return `<h2>${idioma === 'pt' ? 'Referências' : 'References'}</h2><ul><li>Wikipedia.org</li><li>Britannica.com</li></ul>`;
    }
}

async function processarTema(tema) {
    console.log(`\n🚀 Iniciando processamento do Tema: ${tema.nome} (ID: ${tema.id})`);
    
    // 1. Tenta carregar progresso anterior
    let progresso = carregarProgressoLocal(tema.id);
    const capitulosAcumuladosPT = progresso.pt;
    const capitulosAcumuladosEN = progresso.en;

    var imagemCapa = null

    while (!imagemCapa) {
        // imagemCapa = await gerarImagem(tema.name, tema.prompt_image);
        imagemCapa = await generateImage(tema.name, tema.prompt_image, HF_TOKEN);
    }

    const blueprint = tema.estrutura;

    for (let i = 1; i <= blueprint.totalItens; i++) {
        const [capituloNome, chapterName, jaConcluido] = blueprint.capitulos[i - 1];

        // 2. Se o capítulo já está marcado como true no JSON, nós pulamos a geração
        if (jaConcluido && capitulosAcumuladosPT[i-1]) {
            console.log(` ✅ Pulando (já concluído): ${capituloNome}`);
            continue; 
        }

        console.log(`\n ✍️ Gerando capítulo ${i}/${blueprint.totalItens}: ${capituloNome}`);

        // 3. Gera Português (com a lógica de espera que passamos antes)
        const htmlPT = await executarGeracaoProfunda(tema, capituloNome, false);
        capitulosAcumuladosPT[i-1] = { titulo: capituloNome, html: htmlPT };

        // 4. Traduz para Inglês
        console.log(` 🌐 Traduzindo para Inglês...`);
        const htmlEN = await traduzirParaIngles(htmlPT);
        capitulosAcumuladosEN[i-1] = { titulo: chapterName, html: htmlEN };

        // 5. Salva backup imediato para o caso de queda
        salvarProgressoLocal(tema.id, { pt: capitulosAcumuladosPT, en: capitulosAcumuladosEN });
        
        // 6. Marca no seu temas.json principal como concluído
        marcarCapituloConcluido(tema.id, i - 1);
    }

    console.log(` 📚 Gerando bibliografia e referências...`);
    const refsPT = await gerarReferenciasIA(tema, "pt");
    const refsEN = await gerarReferenciasIA(tema, "en");

    capitulosAcumuladosPT.push({ titulo: "Referências", html: refsPT });
    capitulosAcumuladosEN.push({ titulo: "References", html: refsEN });

    // 7. Finalização do PDF
    const pastaTema = criarPastaTema(tema);
    await gerarPDF(tema, capitulosAcumuladosPT, "pt", pastaTema, imagemCapa);
    await gerarPDF({ ...tema, nome: tema.name }, capitulosAcumuladosEN, "en", pastaTema, imagemCapa);

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

    // 8. Limpa o arquivo de backup após concluir tudo
    const backupPath = path.join('output', `progresso_tema_${tema.id}.json`);
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    marcarComoConcluido(tema.id);
    console.log(`\n✔ PDF ${tema.nome} finalizado com sucesso!`);
}

(async () => {
    try {
        const dados = fs.readFileSync('temas.json', 'utf8');
        let dados_parse = JSON.parse(dados);

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