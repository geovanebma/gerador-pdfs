import fs from "fs";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { Groq } from 'groq-sdk';
import path from "path";
import axios from "axios";
import { PDFDocument, rgb } from 'pdf-lib';
import { HfInference } from "@huggingface/inference";

export async function cadastrarNaHotmart(caminhoPasta, arquivo, idioma, nomeTema) {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();

    try {
        // 1. Acessa a página de novo produto
        await page.goto('https://app.hotmart.com/products/add/4/info', { waitUntil: 'networkidle2' });

        console.log("⚠️ Verifique se o login é necessário...");
        // Aqui o script aguarda você estar na tela correta caso precise logar manualmente
        await page.waitForSelector('input[name="name"]', { timeout: 60000 });

        // 2. Preenche o Nome do Produto (Usando o nome da pasta como base)
        await page.type('input[name="name"]', nomeTema);

        // 3. Preenche a Descrição (Exemplo genérico, você pode carregar de um txt se quiser)
        const descricao = `E-book completo sobre ${nomeTema}. Versões em Português e Inglês inclusas.`;
        await page.type('textarea[name="description"]', descricao);

        const config = {
            idiomaValue: (idioma === 'portugues') ? "PT_BR" : "EN",
            paisValue: (idioma === 'portugues') ? "1" : "3" // 1 = Brasil, 3 = EUA
        };

        await page.evaluate((cfg) => {
            // Função auxiliar para forçar a atualização do componente da Hotmart
            const forceUpdate = (selector, val) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.setAttribute('value', val);
                    // Dispara eventos que os componentes costumam ouvir para validar o formulário
                    el.dispatchEvent(new CustomEvent('change', { bubbles: true }));
                    el.dispatchEvent(new CustomEvent('hotChange', { detail: { value: val }, bubbles: true }));
                }
            };

            // Seleciona o Idioma (O primeiro hot-select da página costuma ser o idioma)
            // Usamos o placeholder ou ID para garantir o alvo correto
            forceUpdate('hot-select[placeholder*="idioma"]', cfg.idiomaValue);

            // Seleciona o País (O hot-select com ID country ou placeholder de país)
            forceUpdate('hot-select#country', cfg.paisValue);
            // Caso o ID mude, tentamos pelo placeholder que você enviou:
            forceUpdate('hot-select[placeholder*="país"]', cfg.paisValue);

        }, config);

        // 4. Seleciona Idioma (Português)
        // O seletor depende de como o componente de busca da Hotmart abre
        console.log("🔧 Preenchendo campos básicos...");

        /* NOTA TÉCNICA: A Hotmart usa componentes customizados. 
           Muitas vezes você precisará clicar no elemento antes de digitar.
        */

        // 5. Upload dos arquivos (Isso geralmente é feito na aba 'Área de Membros' ou 'Arquivos')
        // Se for um produto do tipo "Arquivo Digital", você precisará navegar até a etapa de precificação e conteúdo.

        console.log("✅ Dados iniciais preenchidos. Prossiga com a precificação.");

    } catch (error) {
        console.error("❌ Erro na automação Hotmart:", error);
    }
}

// Configurações
const PASTA_OUTPUT = './output';
const INTERVALO_MINUTOS = 5; // Defina aqui o tempo
const PASTAS_PROCESSADAS = new Set(); // Para não repetir a mesma pasta

async function verificarNovasPastas() {
    console.log(`\n🔍 Verificando novas pastas em: ${PASTA_OUTPUT} [${new Date().toLocaleTimeString()}]`);

    try {
        if (!fs.existsSync(PASTA_OUTPUT)) {
            console.warn("⚠️ A pasta 'output' ainda não existe.");
            return;
        }

        // Lê o conteúdo da pasta output
        const itens = fs.readdirSync(PASTA_OUTPUT);

        for (const item of itens) {
            const caminhoCompleto = path.join(PASTA_OUTPUT, item);

            // Verifica se é uma pasta e se já não a processamos nesta sessão
            if (fs.lstatSync(caminhoCompleto).isDirectory() && !PASTAS_PROCESSADAS.has(item) && item !== 'backup') {

                console.log(`📂 Nova pasta detectada: ${item}`);

                // Procura os arquivos específicos
                const arquivosNaPasta = fs.readdirSync(caminhoCompleto);
                const temPortugues = arquivosNaPasta.find(f => f.endsWith('portugues.pdf') && !f.startsWith('CAPA-'));
                const temEnglish = arquivosNaPasta.find(f => f.endsWith('english.pdf') && !f.startsWith('CAPA-'));

                if (temPortugues) {
                    console.log(`   ✅ Achou: ${temPortugues}`);
                    console.log(`   🚀 Iniciando cadastro na Hotmart para: ${item}`);
                    await cadastrarNaHotmart(caminhoCompleto, temPortugues, 'portugues', item);
                }

                // if (temEnglish) {
                //     console.log(`   ✅ Achou: ${temEnglish}`);
                //     console.log(`   🚀 Iniciando cadastro na Hotmart para: ${item}`);
                //     await cadastrarNaHotmart(caminhoCompleto, temEnglish, 'english', item);
                // }

                if (!temPortugues && !temEnglish) {
                    console.log(`   ❌ Nenhum PDF final encontrado ainda nesta pasta.`);
                } else {
                    // Se achou os arquivos, marca como processada para não avisar de novo
                    PASTAS_PROCESSADAS.add(item);
                }
            }
        }
    } catch (error) {
        console.error("❌ Erro ao escanear pastas:", error.message);
    }
}

// Inicia o monitoramento
console.log(`🚀 Monitor iniciado. Verificando a cada ${INTERVALO_MINUTOS} minutos...`);
verificarNovasPastas();
setInterval(verificarNovasPastas, INTERVALO_MINUTOS * 60 * 1000);