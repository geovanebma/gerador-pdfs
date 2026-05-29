import fs from "fs";
import path from "path";

const RELATORIO_PATH = path.join("output", "validacao_texto_tema_config.json");

function pareceMojibake(texto) {
    return typeof texto === "string" && /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF\u20AC\u201A-\u201E]|�)/u.test(texto);
}

function tentarCorrigirMojibake(texto) {
    if (!pareceMojibake(texto)) return texto;

    try {
        const corrigido = Buffer.from(texto, "latin1").toString("utf8");
        if (!pareceMojibake(corrigido)) return corrigido;
    } catch {
        // Segue para a correcao pontual.
    }

    const mapa = {
        "\u00C3\u00A1": "á",
        "\u00C3\u00A0": "à",
        "\u00C3\u00A2": "â",
        "\u00C3\u00A3": "ã",
        "\u00C3\u00A9": "é",
        "\u00C3\u00AA": "ê",
        "\u00C3\u00AD": "í",
        "\u00C3\u00B3": "ó",
        "\u00C3\u00B4": "ô",
        "\u00C3\u00B5": "õ",
        "\u00C3\u00BA": "ú",
        "\u00C3\u00A7": "ç",
        "\u00C3\u0081": "Á",
        "\u00C3\u0080": "À",
        "\u00C3\u0082": "Â",
        "\u00C3\u0083": "Ã",
        "\u00C3\u0089": "É",
        "\u00C3\u008A": "Ê",
        "\u00C3\u008D": "Í",
        "\u00C3\u0093": "Ó",
        "\u00C3\u0094": "Ô",
        "\u00C3\u0095": "Õ",
        "\u00C3\u009A": "Ú",
        "\u00C3\u0087": "Ç",
        "\u00C2\u00A0": " ",
        "\u00C2\u00B0": "°",
        "\u00C2\u00BA": "º",
        "\u00C2\u00AA": "ª",
        "\u00E2\u0080\u0093": "-",
        "\u00E2\u0080\u0094": "-",
        "\u00E2\u0080\u0098": "'",
        "\u00E2\u0080\u0099": "'",
        "\u00E2\u0080\u009C": "\"",
        "\u00E2\u0080\u009D": "\"",
        "\u00E2\u0080\u00A6": "...",
        "\u00E2\u0080\u0091": "-",
        "\u00E2\u0080\u00AF": " ",
        "\u00E2\u0089\u00A5": ">=",
        "\u00E2\u009C\u0094": "OK"
    };

    let parcial = texto;
    Object.entries(mapa).forEach(([quebrado, correto]) => {
        parcial = parcial.split(quebrado).join(correto);
    });

    return parcial;
}

function sanitizarTexto(texto) {
    if (typeof texto !== "string") return texto;
    return tentarCorrigirMojibake(texto)
        .replace(/^\uFEFF/, "")
        .replace(/\u00A0/g, " ")
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
        .replace(/[\u2013\u2014\u2212]/g, "-")
        .replace(/\u2026/g, "...")
        .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function contexto(texto, index, tamanho = 45) {
    return texto.slice(Math.max(0, index - tamanho), index + tamanho).replace(/\s+/g, " ").trim();
}

function validarTexto(texto, origem) {
    const s = sanitizarTexto(texto);
    const erros = [];
    const testar = (regex, codigo, mensagem) => {
        for (const match of s.matchAll(regex)) {
            erros.push({
                origem,
                codigo,
                mensagem,
                encontrado: match[0],
                trecho: contexto(s, match.index || 0)
            });
        }
    };

    testar(/\uFFFD/gu, "CARACTERE_SUBSTITUICAO", "Caractere quebrado encontrado.");
    testar(/(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF\u20AC\u201A-\u201E])/gu, "MOJIBAKE", "Texto com provavel UTF-8 lido/escrito como Latin-1.");
    testar(/[A-Za-zÀ-ÿ][@?]*\?[@?]*[A-Za-zÀ-ÿ]/gu, "PALAVRA_CORROMPIDA", "Palavra com ? no meio. E-mails com @ sao permitidos.");
    testar(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "CONTROLE_INVISIVEL", "Caractere de controle invisivel.");

    return { origem, ok: erros.length === 0, total_erros: erros.length, erros };
}

function caminhar(valor, origem, relatorios) {
    if (typeof valor === "string") {
        relatorios.push(validarTexto(valor, origem));
        return;
    }

    if (Array.isArray(valor)) {
        valor.forEach((item, index) => caminhar(item, `${origem}[${index}]`, relatorios));
        return;
    }

    if (valor && typeof valor === "object") {
        Object.entries(valor).forEach(([chave, item]) => caminhar(item, `${origem}.${chave}`, relatorios));
    }
}

function main() {
    const temas = JSON.parse(fs.readFileSync("temas.json", "utf8").replace(/^\uFEFF/, ""));
    const relatorios = [];
    caminhar(temas, "temas", relatorios);

    const erros = relatorios.flatMap(item => item.erros);
    const payload = {
        ok: erros.length === 0,
        total_erros: erros.length,
        gerado_em: new Date().toISOString(),
        legenda: {
            CARACTERE_SUBSTITUICAO: "Apareceu o caractere de substituicao �.",
            MOJIBAKE: "Apareceu texto como Ã§, Ã£, â€™ ou Â no lugar de acentos/pontuacao.",
            PALAVRA_CORROMPIDA: "Apareceu @ ou ? dentro de palavra, como a@?o.",
            CONTROLE_INVISIVEL: "Apareceu caractere invisivel que nao deveria ir ao PDF."
        },
        relatorios
    };

    if (!fs.existsSync("output")) fs.mkdirSync("output", { recursive: true });
    fs.writeFileSync(RELATORIO_PATH, JSON.stringify(payload, null, 2), "utf8");

    if (erros.length) {
        console.error(`Validacao encontrou ${erros.length} problema(s). Veja ${RELATORIO_PATH}`);
        erros.slice(0, 10).forEach(erro => {
            console.error(`- ${erro.codigo} em ${erro.origem}: ${erro.encontrado} | ${erro.trecho}`);
        });
        process.exit(1);
    }

    console.log(`Validacao ok. Relatorio: ${RELATORIO_PATH}`);
}

main();
