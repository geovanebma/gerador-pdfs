import { pdf } from 'pdf-to-img';
import fs from 'fs';

async function converter() {
    const caminhoPdf = 'C:/Users/Geovane TI/Downloads/vamos-de-receitas-sobremesas-e-doces.pdf';

    try {
        console.log('Iniciando conversão estável...');
        
        let contador = 1;
        const documento = await pdf(caminhoPdf, { scale: 2 }); // scale 2 aumenta a qualidade

        for await (const imagem of documento) {
            const nomeArquivo = `pagina_${contador}.png`;
            fs.writeFileSync(nomeArquivo, imagem);
            console.log(`✅ ${nomeArquivo} gerada!`);
            contador++;
        }

        console.log('\n--- Finalizado com sucesso! ---');
    } catch (error) {
        console.error('❌ Erro durante a conversão:', error.message);
    }
}

converter();