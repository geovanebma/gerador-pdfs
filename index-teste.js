import fs from "fs";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { Groq } from 'groq-sdk';
import path from "path";
import axios from "axios";
import { PDFDocument, rgb } from 'pdf-lib';
import { HfInference } from "@huggingface/inference";

// async function generateImage(titulo) {
//     const hf = new HfInference("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");
    
//     try {
//         const fileName = `${titulo.toLowerCase().replace(/\s+/g, '-')}.png`;
//         const prompt = `${titulo}`;

//         console.log(`🚀 Tentando gerar via Serverless API: ${titulo}...`);

//         const blob = await hf.textToImage({
//             // FLUX é mais moderno e costuma falhar menos que o SDXL antigo
//             model: "black-forest-labs/FLUX.1-schnell", 
//             inputs: prompt,
//             // Sem a linha 'provider' aqui para evitar o erro HTTP
//         });

//         const buffer = Buffer.from(await blob.arrayBuffer());

//         if (!fs.existsSync('output')) fs.mkdirSync('output');
//         fs.writeFileSync(`output/${fileName}`, buffer);
        
//         console.log(`✅ Sucesso! Arquivo: output/${fileName}`);
//     } catch (error) {
//         // Se der erro 503, o modelo está "acordando". Tente de novo em 20 segundos.
//         console.error("❌ Erro:", error.message);
//     }
// }

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

async function gerarCapaSomente(tema, idioma = "pt", pastaTema, imagemCapa) {
    const corTema = tema.cor;
    const corFonte = tema.cor_fonte;
    const principalCapa = (idioma == "pt") ? tema.principal : tema.main;
    const tituloCapa = (idioma == "pt") ? tema.nome : tema.name;
    const icone = tema.icone;
    
    // Nome do arquivo focado apenas na capa
    const sufixo = idioma === "en" ? "english" : "portugues";
    const nomeArquivoCapa = `CAPA-${tema.nome.replace(/[:*?"<>|/\\]/g, '-')}-${sufixo}.pdf`;
    const outputPath = path.join(pastaTema, nomeArquivoCapa);

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

    const htmlCapa = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8">${cssCapa}</head>
        <body>
            <div class="cover-full" style="background-color:${corTema};">
                <div style="position:relative; width:100%; height:350px; overflow:hidden;">
                    <img src="fundo-capa.png" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;">
                    <div style="position:absolute;top:0;left:0;right:0;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;z-index:2;">
                        <h2 class="cover-script" style="margin-top:-5px; font-size:3rem;color:#333;">
                            ${principalCapa}
                        </h2>
                        <h3 style="font-size:2.5rem;color:#FFF; font-family: 'Roboto', sans-serif;padding:5px 20px;border-radius:50px;background-color:#333;margin-top:-40px;">
                            ${tituloCapa}
                        </h3>
                        <i class="bi ${icone}" style="font-size:20px;color:#333;border-radius:50px;padding:5px 40px;margin-top:-50px;background-color:#FFF;"></i>
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
                    <div style="position: relative; width: 80%; margin: 0 auto;">
                        <div style="position: absolute; top: -16px; bottom: -16px; left: -16px; right: -16px; border-radius: 8px; background-color: #FFF; opacity: 0.3;"></div>
                        <div style="position: absolute; top: -8px; bottom: -8px; left: -8px; right: -8px; background-color: white; border-radius: 8px;"></div>
                        <div style="position: relative; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);">
                            <img src="./output/${imagemCapa}" style="width: 100%; height: 384px; object-fit: cover; display: block;">
                        </div>
                        <div style="position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); padding: 12px 32px; border-radius: 9999px; background-color: #333; white-space: nowrap; z-index: 10;">
                            <p style="text-align: center; font-size: 14px; letter-spacing: 0.1em; color: #FFF; margin: 0; font-weight: bold;">
                                ${(idioma == "pt") ? "UMA COLEÇÃO ESPECIAL" : "A SPECIAL COLLECTION"}
                            </p>
                        </div>
                    </div>
                    <div style="margin-top: 60px; display: flex; align-items: center; justify-content: center;">
                         <div style="width: 80px; height: 80px; border-radius: 50%; background-color: #FFF; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
                              <img src="img/realizart-logo.png" style="width: 40px; height: 40px;" alt="Logo">
                         </div>
                    </div>
                </div>
                <div style="position: absolute; bottom: 0; width: 100%; height: 12px; background: linear-gradient(to right, ${corTema}, #888, ${corTema});"></div>
            </div>
        </body>
        </html>`;

    console.log(`🎨 Gerando apenas a capa: ${nomeArquivoCapa}`);
    
    // Gera o PDF e salva no caminho final (outputPath)
    await gerarPdfSimples(`<html><head>${css}${cssCapa}</head><body>${htmlCapa}</body></html>`, outputPath);
    
    console.log(`✅ Capa salva em: ${outputPath}`);
    return outputPath;
}

var tema = {
    "id": 2,
    "principal": "Vamos de Desenvolvimento de Software",
    "main": "Let's talk about Software Development",
    "nome": "Dominando o Terminal Linux & Bash",
    "name": "Mastering Linux Terminal & Bash",
    "prompt_image": "A high-end cinematic digital art of a professional developer's workspace at night. A large, sleek monitor displays a sophisticated Linux terminal with glowing green and cyan code. The lighting is moody, dominated by deep blues and neon accents, reflecting off a polished dark desk. Intricate digital particles and data streams flow in the background, symbolizing high-speed computation and mastery. Ultra-realistic, 8k resolution, futuristic aesthetic, no text or words.",
    "cor": "#19334C",
    "cor_fonte": "#FFFFFF",
    "subtitulo": "O guia definitivo para produtividade máxima e automação de sistemas",
    "estrutura": {
      "capitulos": [
        [
          "A Filosofia Unix: Tudo é Arquivo",
          "The Unix Philosophy: Everything is a File",
          true
        ],
        [
          "Anatomia do Shell: Como o Terminal se Comunica com o Kernel",
          "Shell Anatomy: How the Terminal Communicates with the Kernel",
          true
        ],
        [
          "Navegação de Elite: Atalhos e Comandos de Movimentação",
          "Elite Navigation: Shortcuts and Movement Commands",
          true
        ],
        [
          "Gestão de Arquivos e Diretórios via CLI",
          "File and Directory Management via CLI",
          true
        ],
        [
          "Permissões de Usuário e Grupos: O Poder do Chmod e Chown",
          "User Permissions and Groups: The Power of Chmod and Chown",
          true
        ],
        [
          "Editores de Texto de Terminal: A Guerra entre Vim e Nano",
          "Terminal Text Editors: The War between Vim and Nano",
          true
        ],
        [
          "Pipes e Redirecionamentos: Encadeando a Inteligência dos Comandos",
          "Pipes and Redirection: Chaining Command Intelligence",
          true
        ],
        [
          "Filtros Poderosos: Manipulação de Texto com Grep, Sed e Awk",
          "Powerful Filters: Text Manipulation with Grep, Sed, and Awk",
          true
        ],
        [
          "Gestão de Processos: Monitorando e Finalizando Tarefas",
          "Process Management: Monitoring and Killing Tasks",
          true
        ],
        [
          "O Sistema de Arquivos Linux: Hierarquia e Montagem",
          "The Linux File System: Hierarchy and Mounting",
          true
        ],
        [
          "Redes no Terminal: Diagnóstico e Transferência de Dados",
          "Networking on the Terminal: Diagnosis and Data Transfer",
          true
        ],
        [
          "SSH e Acesso Remoto: Administrando Servidores com Segurança",
          "SSH and Remote Access: Securely Managing Servers",
          true
        ],
        [
          "Introdução ao Bash Scripting: Automatizando o Repetitivo",
          "Introduction to Bash Scripting: Automating the Repetitive",
          true
        ],
        [
          "Variáveis e Estruturas de Dados em Scripts Bash",
          "Variables and Data Structures in Bash Scripts",
          true
        ],
        [
          "Lógica de Programação no Shell: If, Case e Loops",
          "Programming Logic in the Shell: If, Case, and Loops",
          true
        ],
        [
          "Funções e Modularização de Scripts Profissionais",
          "Functions and Modularization of Professional Scripts",
          true
        ],
        [
          "Agendamento de Tarefas com Cron e Anacron",
          "Task Scheduling with Cron and Anacron",
          true
        ],
        [
          "Gestão de Pacotes e Repositórios: Apt, Yum e Pacman",
          "Package and Repository Management: Apt, Yum, and Pacman",
          true
        ],
        [
          "Customização Extrema: Aliases, Funções de Shell e .bashrc",
          "Extreme Customization: Aliases, Shell Functions, and .bashrc",
          true
        ],
        [
          "Segurança no Terminal: Hardening e Melhores Práticas",
          "Terminal Security: Hardening and Best Practices",
          true
        ]
      ],
      "totalItens": 20,
      "estiloExibicao": "tecnico-terminal"
    },
    "icone": "bi-terminal-fill",
    "feito": true
  }

gerarCapaSomente(tema, "en", 'output', 'mastering linux terminal & bash.png')

// generateImage("Understanding Programming");