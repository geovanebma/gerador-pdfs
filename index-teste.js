import fs from "fs";
import { HfInference } from "@huggingface/inference";


async function generateImage(titulo) {
    const hf = new HfInference("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");
    
    try {
        const fileName = `${titulo.toLowerCase().replace(/\s+/g, '-')}.png`;
        const prompt = `${titulo}`;

        console.log(`🚀 Tentando gerar via Serverless API: ${titulo}...`);

        const blob = await hf.textToImage({
            // FLUX é mais moderno e costuma falhar menos que o SDXL antigo
            model: "black-forest-labs/FLUX.1-schnell", 
            inputs: prompt,
            // Sem a linha 'provider' aqui para evitar o erro HTTP
        });

        const buffer = Buffer.from(await blob.arrayBuffer());

        if (!fs.existsSync('output')) fs.mkdirSync('output');
        fs.writeFileSync(`output/${fileName}`, buffer);
        
        console.log(`✅ Sucesso! Arquivo: output/${fileName}`);
    } catch (error) {
        // Se der erro 503, o modelo está "acordando". Tente de novo em 20 segundos.
        console.error("❌ Erro:", error.message);
    }
}

generateImage("Understanding Programming");