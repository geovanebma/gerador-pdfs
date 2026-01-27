import fs from "fs";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { Groq } from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import path from "path";
import axios from "axios";
import { PDFDocument, rgb } from 'pdf-lib'; //

const RESETAR_TEMA = true;

dotenv.config();

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) {
    console.error("❌ ERRO FATAL: A variável GROQ_API_KEY (Groq) não foi encontrada no arquivo .env!");
    process.exit(1);
}
const groq = new Groq({ apiKey: GROQ_KEY });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("❌ ERRO FATAL: A variável GEMINI_API_KEY (Gemini) não foi encontrada no arquivo .env!");
    console.error("É necessária para a geração de imagens!");
    process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const PROGRESS_FILE = "progress.json";
const NUMERO_TOTAL_RECEITAS = 1;

const temas = [
    { nome: "Sobremesas e Doces", cor: "#E6EE9C" },
    { nome: "Salgados e Lanches", cor: "#DCE775" },
    { nome: "Brasileira", cor: "#D4E157" },
    { nome: "Vegetarianas", cor: "#CDDC39" },
    { nome: "Internacional", cor: "#C0CA33" },
    { nome: "Naturais", cor: "#AFB42B" },
    { nome: "Carnes e Churrasco", cor: "#9E9D24" },
    { nome: "Dieta Low Carb", cor: "#827717" },
    { nome: "Bebidas", cor: "#6D6F12" },
    { nome: "Cozinha Rápida", cor: "#4E5B0B" }
];

function carregarProgresso() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            const data = fs.readFileSync(PROGRESS_FILE, "utf8");
            return JSON.parse(data);
        }
    } catch (e) {
        console.warn("⚠️ Não foi possível carregar o progresso existente. Iniciando do zero.");
    }
    return {};
}

function salvarProgresso(progresso) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progresso, null, 2), "utf8");
}

function limparProgresso(progresso, temaNome) {
    delete progresso[temaNome];
    salvarProgresso(progresso);
}

function extractRecipeTitle(htmlContent) {
    const match = htmlContent.match(/<h[1-3]>(.*?)<\/h[1-3]>/i) || htmlContent.match(/<p>Título\s*<br\s*\/?>\s*(.*?)<\/p>/i);
    if (match && match[1]) {
        return match[1].trim();
    }

    return htmlContent.split('\n')[0].replace(/<\/?p>/gi, '').trim() || `Receita Sem Título`;
}

function limparArquivos(arquivos) {
    console.log(` 🗑️ Limpando ${arquivos.length} arquivos de imagem gerados...`);
    for (const file of arquivos) {
        const filePath = path.join('output', file);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.error(` ❌ Erro ao deletar arquivo ${file}:`, e.message);
        }
    }
}

function extrairTipoPrato(titulo) {
    return titulo.toLowerCase().split(" ").slice(0, 2).join(" ");
}

function tiposJaUsados(receitas) {
    const set = new Set();
    for (const r of receitas) {
        set.add(extrairTipoPrato(r.titulo));
    }
    return Array.from(set);
}

async function gerarImagem(titulo, tema, receitaResult) {
    const fileName = `${titulo.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.png`;

    const promptImagem = `Ultra realistic food photography of the following dish: ${titulo}`;

    const encodedPrompt = encodeURIComponent(promptImagem);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1000)}`;

    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000});
        fs.writeFileSync(`output/${fileName}`, response.data);
        return fileName;
    } catch (error) {
        console.error("❌ Erro na Pollinations AI:", error.message);
        return null;
    }
}

async function gerarUmaReceita(temaNome, numeroReceita, receitasExistentes) {

    const tiposBloqueados = tiposJaUsados(receitasExistentes);
    const prompt = `
        Crie UMA receita ORIGINAL para o e-book:
        "Vamos de Receitas – ${temaNome}"

        ⚠️ REGRAS OBRIGATÓRIAS:
        - NÃO repita tipos de prato já usados
        - NÃO crie variações do mesmo prato
        - Se já existir "quiche", NÃO gere nenhuma quiche
        - Varie entre: saladas, pratos quentes, sopas, bowls, massas, refogados, grelhados, assados, etc

        Tipos de pratos que JÁ FORAM USADOS:
        ${tiposBloqueados.join(", ") || "nenhum ainda"}

        Esta é a receita número ${numeroReceita} de 20.

        FORMATO OBRIGATÓRIO (HTML):
        <h1>Título da Receita</h1>
        <p><b>Tempo de preparo:</b>...</p>
        <p><b>Rendimento:</b>...</p>
        <h2>Ingredientes:</h2>
        <ul class='recipe-section'>...</ul>
        <h2>Modo de preparo:</h2>
        <ol class='recipe-section'>...</ol>
        <p><b>Dicas extras:</b>...</p>

        - Linguagem brasileira
        - Receita simples e realista
        - NÃO explique as regras
    `;

    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(` Tentativa ${attempt}/${MAX_RETRIES} para Receita ${numeroReceita} de ${temaNome}...`);

            const response = await groq.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.8,
            });

            const htmlContent = response.choices[0].message.content;
            const titulo = extractRecipeTitle(htmlContent);

            const tipoNovo = extrairTipoPrato(titulo);
            const tiposUsados = tiposJaUsados(receitasExistentes);

            if (tiposUsados.includes(tipoNovo)) {
                console.warn(`🔁 Tipo repetido (${tipoNovo}). Gerando outra receita...`);
                return null;
            }

            return { html: htmlContent, titulo: titulo };

        } catch (error) {
            if (error.status === 503 || error.status === 429) {
                if (attempt < MAX_RETRIES) {
                    const delay = Math.pow(2, attempt) * 10000;
                    console.warn(` ⚠️ Erro de API Groq (503/429). Aguardando ${delay / 1000}s antes de tentar novamente.`);
                    await sleep(delay);
                } else {
                    console.error(` ❌ ERRO FATAL: Falha ao gerar Receita ${numeroReceita} após ${MAX_RETRIES} tentativas.`);
                    return null;
                }
            } else {
                console.error(` ❌ ERRO Desconhecido Groq ao gerar Receita ${numeroReceita}:`, error.message);
                return null;
            }
        }
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

    await page.pdf({
        path: outputPath,
        format: "A4",
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();
    fs.unlinkSync(tempHtmlPath);
}

async function gerarPDF(tema, receitasAcumuladas) {
    const corTema = tema.cor;
    const tituloPrincipal = tema.nome;
    const nomeArquivo = `vamos-de-receitas-${tema.nome.toLowerCase().replace(/ /g, "-")}`;
    const caminhosTemporarios = [];
    const dadosParaIndice = [];

    let paginaAtual = 1;
    const css = `
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
            @import url('https://fonts.googleapis.com/css2?family=Kaushan+Script&display=swap');
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

            // @page {
            //     size: A4;
            //     // margin: 25mm 20mm 25mm 20mm;
            //     margin: 0;
            //     // @bottom-right {
            //     //     content: counter(page);
            //     // }
            // }

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

            .recipe-section li {
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
                padding: 50px;
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
                right: 1cm;
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
            
            /* Detalhes da Receita */
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
                margin: 20mm 15mm 25mm 15mm; 
            }

        body {
            margin: 0;
            padding: 0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
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
        </style>
    `;

    const cssCapa = `
        <style>
        @page:first {
            margin: 0;
        }
        </style>
    `;

    console.log(" 📄 Calculando páginas das receitas individualmente...");

    let paginaAtualRelativa = 1;
    let paginaAtualAcumulada = 1;

    for (let i = 0; i < receitasAcumuladas.length; i++) {
        const receita = receitasAcumuladas[i];
        const pathTemp = `output/_temp_r${i}.pdf`;

        const htmlReceitaIndividual = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head><meta charset="UTF-8"><link rel="stylesheet" url="index.css"/></head>
            <body>
                <div class="recipe-page">
                    <div class="recipe-container">
                        <div class="recipe-content">${receita.html}</div>
                        // <div class="recipe-image">
                        //     <img src="./output/${receita.imagem}" style="border: 4px solid ${corTema};">
                        // </div>
                    </div>
                </div>
            </body>
            </html>`;

        await gerarPdfSimples(htmlReceitaIndividual, pathTemp);

        const bytes = fs.readFileSync(pathTemp);
        const pdfDoc = await PDFDocument.load(bytes);
        const qtd = pdfDoc.getPageCount();

        dadosParaIndice.push({
            titulo: receita.titulo,
            pagina: paginaAtualAcumulada
        });

        paginaAtualAcumulada += qtd;

        caminhosTemporarios.push(pathTemp);
    }

    const htmlIndiceFinal = `
        <section class="indice-page">
            <h1 class="indice-titulo" style="color: ${corTema}">Índice</h1>
            <div class="indice-lista">
                ${dadosParaIndice.map((item, index) => `
                    <div class="indice-item">
                        <span class="indice-nome">${index + 1}. ${item.titulo}</span>
                        <span class="indice-pontilhado"></span>
                        <span class="indice-pagina">Pág. ${item.pagina}</span>
                    </div>
                `).join('')}
            </div>
        </section>`;

    let imagemCapa = "";

    const receitasComImagens = receitasAcumuladas.map((r, index) => {
        if (imagemCapa == "") {
            imagemCapa = r.imagem;
        } else {
            if (imagemCapa.length > r.imagem.length) {
                imagemCapa = r.imagem
            }
        }

        return `
                <div class="recipe-page" style="margin: 0 !important;">
                        <div class="recipe-container">
                            <div class="recipe-content">
                                ${r.html}
                            </div>
                            <div class="recipe-image">
                                <img src="./output/${r.imagem}" alt="${r.titulo}" style="border: 4px solid ${corTema};">
                            </div>
                        </div>
                        <div class="page-break"></div>
                    </div>
                </div>
            `;
    }).join('');

    const htmlCapa = `
        <div class="cover-full">
            <div style="width: 100%;">
                <div style="position: relative; padding-top: 64px; padding-bottom: 48px; padding-left: 48px; padding-right: 48px;">
                    <div style="position: absolute; top: 0; left: 0; right: 0; background-color: ${corTema};">
                        <h1 style="text-align: center; margin-bottom: 12px; font-family: 'Kaushan Script', cursive; font-size: 3rem; color: #FFF; letter-spacing: 0.02em;">
                            Vamos de receitas
                        </h1>
                        <h2 style="text-align: center; font-size: 3rem; margin-bottom: 24px; color: #FFF; letter-spacing: 0.03em;">
                            ${tituloPrincipal}
                        </h2>
                    </div>
                </div>
                <div style="position:relative;margin-top:200px;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 32px;">
                        <div style="height: 1px; width: 96px; background: linear-gradient(to right, transparent, ${corTema});"></div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background-color: ${corTema};"></div>
                        <div style="height: 1px; width: 128px; background-color: ${corTema};"></div>
                        <div style="width: 8px; height: 8px; border-radius: 50%; background-color: ${corTema};"></div>
                        <div style="height: 1px; width: 96px; background: linear-gradient(to left, transparent, ${corTema});"></div>
                    </div>
                    <div style="padding-left: 48px; padding-right: 48px; padding-bottom: 48px;">
                        <div style="position: relative;">
                            <div style="position: absolute; top: -16px; bottom: -16px; left: -16px; right: -16px; border-radius: 8px; background-color: ${corTema}; opacity: 0.3;"></div>
                            <div style="position: absolute; top: -8px; bottom: -8px; left: -8px; right: -8px; background-color: white; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"></div>

                            <div style="position: relative; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);">
                                <img src="./output/${imagemCapa}" alt="Receita" style="width: 100%; height: 384px; object-fit: cover; display: block;">
                                <div style="position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.2), transparent);"></div>
                            </div>

                            <div style="position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); padding: 12px 32px; border-radius: 9999px; shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); background-color: ${corTema}; white-space: nowrap;">
                                <p style="text-align: center; font-size: 14px; letter-spacing: 0.1em; color: #FFF; margin: 0; font-weight: bold;">
                                    UMA COLEÇÃO ESPECIAL
                                </p>
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 48px; padding-left: 48px; padding-right: 48px; padding-bottom: 32px; display: flex; align-items: center; justify-content: space-between;">
                        <div style="flex: 1; height: 1px; background: linear-gradient(to right, #d1d5db, transparent);"></div>
                        <div style="padding: 0 32px;">
                            <div style="width: 80px; height: 80px; border-radius: 50%; background-color: ${corTema}; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
                                <img src="img/realizart-logo.png" style="width: 40px; height: 40px;" alt="Logo">
                            </div>
                        </div>
                        <div style="flex: 1; height: 1px; background: linear-gradient(to left, #d1d5db, transparent);"></div>
                    </div>
                    <div style="height: 12px; background: linear-gradient(to right, ${corTema}, #888, ${corTema});"></div>
                </div>
            </div>
        </div>
        <div class="page-break" style="page-break-after: always;"></div>
    `;

    const htmlIntroducao = `
        <div class="introduction-page">
            <h1>Introdução</h1>
            <p>Seja bem-vindo(a) ao seu novo guia de receitas! Nós, da Realizart, estamos entusiasmados em compartilhar esta coleção especial de pratos deliciosos e práticos. Este E-book é dedicado a ${tema.nome}, trazendo ${NUMERO_TOTAL_RECEITAS} opções que prometem surpreender seu paladar.</p>
            <p>Preparamos cada receita com carinho e pensamos em cada detalhe, desde o tempo de preparo até as dicas extras. Desejamos que cada página seja uma inspiração para novas experiências na sua cozinha. Bom apetite!</p>
            <p class="signature">Com carinho, a equipe Realizart.</p>
        </div>
        <div class="page-break"></div>
    `;

    const indicePdfPath = `output/_temp_indice.pdf`;
    await gerarPdfSimples(`<html><head><link rel="stylesheet" url="index.css"/></head><body>${htmlIndiceFinal}</body></html>`, indicePdfPath);

    const htmlCapaIntro = `<html><head><link rel="stylesheet" url="index.css"/><link rel="stylesheet" url="index-capa.css"/></head><body>${htmlCapa}${htmlIntroducao}</body></html>`;
    const capaIntroPdfPath = `output/_temp_capa_intro.pdf`;
    await gerarPdfSimples(htmlCapaIntro, capaIntroPdfPath);

    const pdfFinalPath = `output/${nomeArquivo}.pdf`;

    async function juntarPdfs(paths, outputPath, corTema) {
        const pdfFinal = await PDFDocument.create();
        const fonteEstilizada = await pdfFinal.embedFont('Helvetica-Bold');
        const corParaDesenho = rgbFromHex(corTema); // 

        let contadorPaginaReceita = 1;

        for (let i = 0; i < paths.length; i++) {
            const pdfPath = paths[i];
            if (fs.existsSync(pdfPath)) {
                const bytes = fs.readFileSync(pdfPath);
                const pdf = await PDFDocument.load(bytes);
                const pages = await pdfFinal.copyPages(pdf, pdf.getPageIndices());

                pages.forEach((page) => {
                    if (i > 1) {
                        const { width, height } = page.getSize();

                        page.drawRectangle({
                            x: width - 40,
                            y: 30,
                            width: 25,
                            height: 25,
                            color: corParaDesenho,
                            opacity: 1,
                        });

                        page.drawText(`${contadorPaginaReceita}`, {
                            x: width - 33,
                            y: 38,
                            size: 12,
                            font: fonteEstilizada,
                            color: rgb(0.2, 0.2, 0.2), // 
                        });

                        contadorPaginaReceita++;
                    }
                    pdfFinal.addPage(page);
                });
            }
        }
        const pdfBytes = await pdfFinal.save();
        fs.writeFileSync(outputPath, pdfBytes);
    }

    function rgbFromHex(hex) {
        if (!hex || typeof hex !== 'string') return rgb(0.8, 0.8, 0.2); // 
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return rgb(r, g, b);
    }

    await juntarPdfs(
        [capaIntroPdfPath, indicePdfPath, ...caminhosTemporarios],
        pdfFinalPath,
        corTema
    );

    [capaIntroPdfPath, indicePdfPath, ...caminhosTemporarios].forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

(async () => {
    if (!fs.existsSync('output')) {
        fs.mkdirSync('output');
    }

    const progressoGlobal = carregarProgresso();

    for (const tema of temas) {
        const temaNome = tema.nome;

        let receitasAcumuladas;

        if (RESETAR_TEMA) {
            console.log(` 🔄 RESET ATIVADO — ignorando progresso salvo para ${temaNome}`);
            receitasAcumuladas = [];
            limparProgresso(progressoGlobal, temaNome);

            if (progressoGlobal[temaNome]) {
                const imagensAntigas = progressoGlobal[temaNome].map(r => r.imagem);
                limparArquivos(imagensAntigas);
            }
        } else {
            receitasAcumuladas = progressoGlobal[temaNome] || [];
        }

        const receitasIniciais = receitasAcumuladas.length;

        if (receitasIniciais === NUMERO_TOTAL_RECEITAS) {
            console.log(`\n--- E-BOOK: ${temaNome} JÁ CONCLUÍDO NO PROGRESSO. Pulando. ---`);
            continue;
        }

        console.log(`\n--- INICIANDO E-BOOK: ${temaNome} ---`);
        console.log(` 🔎 Encontrado ${receitasIniciais} receitas salvas. Continuaremos da Receita ${receitasIniciais + 1}.`);

        let imagensGeradasNestaSessao = [];

        for (let i = receitasIniciais + 1; i <= NUMERO_TOTAL_RECEITAS; i++) {

            let receitaResult = null;

            while (!receitaResult) {
                receitaResult = await gerarUmaReceita(temaNome, i, receitasAcumuladas);
            }

            if (receitaResult) {
                const { html, titulo } = receitaResult;
                let fileName = null;
                let tentativasImagem = 0;

                // 🔄 LOOP DE TENTATIVA DA IMAGEM
                // Ele não sai deste loop enquanto fileName for null
                while (!fileName) {
                    tentativasImagem++;
                    console.log(` 🎨 Tentando gerar imagem para "${titulo}" (Tentativa ${tentativasImagem})...`);
                    
                    fileName = await gerarImagem(titulo, tema, receitaResult);

                    if (!fileName) {
                        console.warn(` ⚠️ Falha na imagem da receita ${i}. Tentando novamente em 5 segundos...`);
                        await sleep(5000); // Pequena pausa para não sobrecarregar a API
                    }
                }

                const receitaCompleta = {
                    titulo,
                    html,
                    imagem: fileName || "placeholder.png"
                };

                receitasAcumuladas.push(receitaCompleta);

                if (fileName) {
                    imagensGeradasNestaSessao.push(fileName);
                    console.log(` ✅ Receita ${i}/${NUMERO_TOTAL_RECEITAS} gerada com imagem`);
                } else {
                    console.log(` ⚠️ Receita ${i}/${NUMERO_TOTAL_RECEITAS} sem imagem`);
                }
            } else {
                console.warn(` 🟡 Pulando Receita ${i} devido a falha fatal de API. Parando o processamento do tema.`);
                break;
            }

            if (i < NUMERO_TOTAL_RECEITAS) {
                console.log(` 💤 Pausa de 10 segundos antes da próxima receita (${i + 1})...`);
                await sleep(10000);
            }
        }

        if (receitasAcumuladas.length === NUMERO_TOTAL_RECEITAS) {
            console.log(`\n📦 Gerando PDF final para ${temaNome}...`);

            await gerarPDF(tema, receitasAcumuladas);

            console.log(`\n✔ E-BOOK FINALIZADO: ${temaNome}`);

            limparProgresso(progressoGlobal, temaNome);

            const todosOsArquivosDoTema = receitasAcumuladas.map(r => r.imagem);
            limparArquivos(todosOsArquivosDoTema);

        } else if (receitasAcumuladas.length > 0) {
            console.log(` ⏸️ Tema interrompido. ${receitasAcumuladas.length}/${NUMERO_TOTAL_RECEITAS} receitas salvas no progresso. Continue rodando para finalizar.`);
        } else {
            console.error(`\n❌ FALHA: Nenhuma receita foi gerada para ${temaNome}. PDF não criado.`);
        }

        console.log(`\n-- PAUSA LONGA -- Aguardando 60 segundos antes de iniciar o próximo tema.`);
        await sleep(60000);
    }
})();