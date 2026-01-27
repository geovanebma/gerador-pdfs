import fs from "fs";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import puppeteer from "puppeteer";
import { Groq } from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import { PDFDocument } from 'pdf-lib';

dotenv.config();

// --- CONFIGURAÇÕES E CONSTANTES ---
const CONFIG = {
    GROQ_KEY: process.env.GROQ_API_KEY,
    GEMINI_KEY: process.env.GEMINI_API_KEY,
    PROGRESS_FILE: "progress.json",
    OUTPUT_DIR: "output",
    TOTAL_RECEITAS: 1,
    TEMAS: [
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
    ]
};

// Validação Inicial
if (!CONFIG.GROQ_KEY || !CONFIG.GEMINI_KEY) {
    console.error("❌ ERRO: Verifique suas chaves de API no arquivo .env");
    process.exit(1);
}

// Inicialização de Clientes
const groq = new Groq({ apiKey: CONFIG.GROQ_KEY });
const ai = new GoogleGenAI({ apiKey: CONFIG.GEMINI_KEY });

// --- UTILITÁRIOS ---
const utils = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    
    limparNomeArquivo: (texto) => texto.replace(/[^a-z0-9]/gi, "_").toLowerCase(),

    extrairTitulo: (html) => {
        const match = html.match(/<h[1-3]>(.*?)<\/h[1-3]>/i) || html.match(/<p>Título\s*<br\s*\/?>\s*(.*?)<\/p>/i);
        return match ? match[1].trim() : `Receita_${Date.now()}`;
    },

    carregarProgresso: () => {
        if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG.PROGRESS_FILE, "utf8"));
        }
        return {};
    },

    salvarProgresso: (progresso) => {
        fs.writeFileSync(CONFIG.PROGRESS_FILE, JSON.stringify(progresso, null, 2));
    },

    limparArquivosTemporarios: (arquivos) => {
        arquivos.forEach(file => {
            const p = path.join(CONFIG.OUTPUT_DIR, file);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        });
    }
};

// --- SERVIÇOS DE IA ---
const AIService = {
    async gerarTexto(temaNome, numero, existentes) {
        const tiposUsados = existentes.map(r => r.titulo.toLowerCase().split(" ")[0]);
        const prompt = `Crie uma receita ORIGINAL para o e-book: "Vamos de Receitas – ${temaNome}". 
        Evite: ${tiposUsados.join(", ")}. Formato HTML (h1 para título, h2 para seções).`;

        try {
            const completion = await groq.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.8,
            });
            const html = completion.choices[0].message.content;
            return { html, titulo: utils.extrairTitulo(html) };
        } catch (e) {
            console.error("Erro Groq:", e.message);
            return null;
        }
    },

    async gerarImagem(titulo) {
        try {
            const fileName = `${utils.limparNomeArquivo(titulo)}.png`;
            const response = await axios.post("http://127.0.0.1:7860/sdapi/v1/txt2img", {
                prompt: `Professional food photography of ${titulo}, high resolution, studio lighting`,
                steps: 15
            });
            fs.writeFileSync(path.join(CONFIG.OUTPUT_DIR, fileName), Buffer.from(response.data.images[0], "base64"));
            return fileName;
        } catch (e) {
            console.warn("⚠️ Stable Diffusion offline. Usando placeholder.");
            return "placeholder.png";
        }
    }
};

// --- MOTOR DE PDF ---
const PDFEngine = {
    async gerarDeHtml(html, outputPath) {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.pdf({ path: outputPath, format: "A4", printBackground: true });
        await browser.close();
    },

    async mesclarPdfs(caminhos, saida) {
        const pdfFinal = await PDFDocument.create();
        for (const p of caminhos) {
            const bytes = fs.readFileSync(p);
            const pdf = await PDFDocument.load(bytes);
            const paginas = await pdfFinal.copyPages(pdf, pdf.getPageIndices());
            paginas.forEach(pg => pdfFinal.addPage(pg));
        }
        fs.writeFileSync(saida, await pdfFinal.save());
        caminhos.forEach(p => fs.unlinkSync(p)); // Deleta temporários
    }
};

// --- TEMPLATES HTML (Separados para organização) ---
const Templates = {
    layoutBase: (conteudo, cor) => `
        <html>
        <head>
            <style>
                body { font-family: 'Roboto', sans-serif; margin: 0; padding: 0; }
                .recipe-container { display: flex; padding: 1cm; page-break-after: always; }
                .recipe-content { width: 55%; }
                .recipe-image img { width: 100%; border: 4px solid ${cor}; border-radius: 8px; }
                h1, h2 { color: ${cor}; }
            </style>
        </head>
        <body>${conteudo}</body>
        </html>
    `,
    capa: (tema, imagem) => `
        <div style="text-align: center; padding: 50px; border-top: 10px solid ${tema.cor};">
            <h1 style="font-size: 3em;">Vamos de Receitas</h1>
            <h2 style="font-size: 2em; color: ${tema.cor}">${tema.nome}</h2>
            <img src="./output/${imagem}" style="width: 80%; border-radius: 15px; margin-top: 20px;">
        </div>
        <div style="page-break-after: always;"></div>
    `
};

// --- FLUXO PRINCIPAL ---
async function processarEbook(tema) {
    const progressoGlobal = utils.carregarProgresso();
    let receitas = progressoGlobal[tema.nome] || [];

    console.log(`\n📖 Iniciando Tema: ${tema.nome}`);

    while (receitas.length < CONFIG.TOTAL_RECEITAS) {
        const num = receitas.length + 1;
        const result = await AIService.gerarTexto(tema.nome, num, receitas);

        if (result) {
            const imgPath = await AIService.gerarImagem(result.titulo);
            receitas.push({ ...result, imagem: imgPath });
            
            progressoGlobal[tema.nome] = receitas;
            utils.salvarProgresso(progressoGlobal);
            
            console.log(`✅ [${num}/${CONFIG.TOTAL_RECEITAS}] ${result.titulo}`);
            if (num < CONFIG.TOTAL_RECEITAS) await utils.sleep(5000);
        }
    }

    // Geração de PDFs
    const caminhosTemporarios = [];
    const baseNome = utils.limparNomeArquivo(tema.nome);

    // 1. Capa e Intro
    const capaPath = `output/capa_${baseNome}.pdf`;
    await PDFEngine.gerarDeHtml(Templates.capa(tema, receitas[0].imagem), capaPath);
    caminhosTemporarios.push(capaPath);

    // 2. Receitas
    const receitasHtml = receitas.map(r => `
        <div class="recipe-container">
            <div class="recipe-content">${r.html}</div>
            <div class="recipe-image"><img src="./output/${r.imagem}"></div>
        </div>
    `).join('');
    
    const receitasPath = `output/receitas_${baseNome}.pdf`;
    await PDFEngine.gerarDeHtml(Templates.layoutBase(receitasHtml, tema.cor), receitasPath);
    caminhosTemporarios.push(receitasPath);

    // Mesclar Final
    const finalPath = `output/EBOOK_${baseNome}.pdf`;
    await PDFEngine.mesclarPdfs(caminhosTemporarios, finalPath);

    // Limpeza
    utils.limparArquivosTemporarios(receitas.map(r => r.imagem));
    delete progressoGlobal[tema.nome];
    utils.salvarProgresso(progressoGlobal);
    
    console.log(`✨ E-book concluído: ${finalPath}`);
}

(async () => {
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) fs.mkdirSync(CONFIG.OUTPUT_DIR);
    
    for (const tema of CONFIG.TEMAS) {
        await processarEbook(tema);
        console.log("Waiting for next ebook...");
        await utils.sleep(30000);
    }
})();