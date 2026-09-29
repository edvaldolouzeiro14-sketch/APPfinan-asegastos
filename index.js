require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db;

// Inicialização do Banco SQLite
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

// Inicialização da API do Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Inicialização do Cliente do WhatsApp (com configurações para ambiente de nuvem/Render)
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// Evento de geração do QR Code no terminal
client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR Code abaixo pelo WhatsApp (no log do servidor):');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Porquim IA está online!');
});

// Processamento de Mensagens
client.on('message', async (msg) => {
    // Ignora mensagens de grupos e status
    if (msg.from.endsWith('@g.us') || msg.isStatus) return;

    try {
        const userId = msg.from;
        const textoMsg = msg.body;

        // Consulta os últimos 5 lançamentos do usuário
        const ultimosGastos = await db.all(
            'SELECT tipo, valor, categoria, descricao, data FROM transacoes WHERE usuario = ? ORDER BY id DESC LIMIT 5',
            [userId]
        );

        // Consulta soma total de entradas e saídas do mês atual
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

        // Gravando transação no banco de dados local caso haja instrução REGISTRO|
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

// Inicializa o banco de dados e depois o cliente do WhatsApp
initDb().then(() => client.initialize());
