require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

let qrCodeImage = null;

// Rota principal: Exibe o QR Code em HTML
app.get('/', (req, res) => {
    if (qrCodeImage) {
        res.send(`
            <!DOCTYPE html>
            <html lang="pt-br">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Porquim IA - QR Code</title>
                <style>
                    body { font-family: sans-serif; text-align: center; background: #f4f4f9; padding-top: 50px; }
                    .card { background: white; padding: 20px; display: inline-block; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
                    img { width: 280px; height: 280px; }
                </style>
                <meta http-equiv="refresh" content="15">
            </head>
            <body>
                <div class="card">
                    <h2>🐷 Porquim IA - Conectar WhatsApp</h2>
                    <p>Abra o WhatsApp no celular > Aparelhos Conectados > Conectar um aparelho</p>
                    <img src="${qrCodeImage}" alt="QR Code WhatsApp" />
                    <p style="font-size: 12px; color: #666;">A página atualiza automaticamente a cada 15 segundos.</p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="pt-br">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="refresh" content="5">
                <title>Porquim IA</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding-top: 50px; }
                </style>
            </head>
            <body>
                <h2>🐷 Porquim IA está online e pronto para uso!</h2>
                <p>Se você acabou de conectar, o serviço já está pronto para receber mensagens.</p>
            </body>
            </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor Web rodando na porta ${PORT}`);
});

let db;

async function initDb() {
    db = await open({
        filename: path.join(__dirname, 'dados_porquim.db'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS transacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT,
            tipo TEXT,
            valor REAL,
            categoria TEXT,
            descricao TEXT,
            data DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('🗄️ Banco de Dados SQLite conectado com sucesso!');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Função aprimorada para buscar dinamicamente qualquer pasta do Chrome baixada no Render
function getExecutablePath() {
    const baseDirs = [
        '/opt/render/project/src/.cache/puppeteer/chrome',
        '/opt/render/.cache/puppeteer/chrome'
    ];

    for (const baseDir of baseDirs) {
        if (fs.existsSync(baseDir)) {
            const versions = fs.readdirSync(baseDir);
            for (const ver of versions) {
                const chromePath = path.join(baseDir, ver, 'chrome-linux64', 'chrome');
                if (fs.existsSync(chromePath)) {
                    console.log(`🔍 Chrome encontrado em: ${chromePath}`);
                    return chromePath;
                }
            }
        }
    }

    const systemPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];

    for (const sysPath of systemPaths) {
        if (fs.existsSync(sysPath)) {
            console.log(`🔍 Chrome do sistema encontrado em: ${sysPath}`);
            return sysPath;
        }
    }

    return undefined;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        executablePath: getExecutablePath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--unhandled-rejections=strict',
            '--disable-extensions'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('📱 Novo QR Code gerado! Acesse pela URL da sua aplicação no navegador.');
    qrCodeImage = await QRCode.toDataURL(qr);
});

client.on('ready', () => {
    console.log('✅ Porquim IA está online!');
    qrCodeImage = null;
});

client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us') || msg.isStatus) return;

    try {
        const userId = msg.from;
        const textoMsg = msg.body;

        const ultimosGastos = await db.all(
            'SELECT tipo, valor, categoria, descricao, data FROM transacoes WHERE usuario = ? ORDER BY id DESC LIMIT 5',
            [userId]
        );

        const resumoMes = await db.get(
            `SELECT 
                SUM(CASE WHEN tipo = 'saida' THEN valor ELSE 0 END) as total_saidas,
                SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END) as total_entradas
             FROM transacoes 
             WHERE usuario = ? AND strftime('%Y-%m', data) = strftime('%Y-%m', 'now')`,
            [userId]
        );

        const promptContexto = `
Você é o "Porquim IA", assistente virtual carismático e especialista em finanças pessoais.
Usuário atual: ${userId}

DADOS LOCAIS DO USUÁRIO:
- Resumo deste mês: Total Entradas = R$ ${resumoMes?.total_entradas || 0}, Total Saídas = R$ ${resumoMes?.total_saidas || 0}
- Últimos registros: ${JSON.stringify(ultimosGastos)}

REGRAS DE RESPOSTA:
1. Seja sempre amigável, direto e use emojis (🐷, 💰, 📊).
2. Se o usuário estiver registrando um gasto ou ganho, você DEVE incluir ao FINAL da resposta a linha de instrução exatamente neste formato:
REGISTRO|[entrada/saida]|[valor_numerico]|[categoria]|[descricao]

Exemplo para "gastei 20 no almoço":
Muito bem! Anotei seu gasto de R$ 20,00 na categoria Alimentação. 🐷
REGISTRO|saida|20.00|Alimentação|almoço
`;

        const model = genAI.getGenerativeModel({ 
            model: 'gemini-1.5-flash',
            systemInstruction: promptContexto
        });

        const result = await model.generateContent(textoMsg);
        let respostaTexto = result.response.text();

        if (respostaTexto.includes('REGISTRO|')) {
            const linhas = respostaTexto.split('\n');
            const linhaComando = linhas.find(l => l.startsWith('REGISTRO|'));
            respostaTexto = linhas.filter(l => !l.startsWith('REGISTRO|')).join('\n').trim();

            if (linhaComando) {
                const [, tipo, valor, categoria, descricao] = linhaComando.split('|');
                await db.run(
                    'INSERT INTO transacoes (usuario, tipo, valor, categoria, descricao) VALUES (?, ?, ?, ?, ?)',
                    [userId, tipo, parseFloat(valor), categoria, descricao]
                );
            }
        }

        await msg.reply(respostaTexto);

    } catch (error) {
        console.error('Erro na mensagem:', error);
        await msg.reply('🐷 Ops, tive um pequeno problema técnico. Pode repetir?');
    }
});

initDb().then(() => client.initialize());
