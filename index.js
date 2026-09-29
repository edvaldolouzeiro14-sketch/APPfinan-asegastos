require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const axios = require('axios'); // Para enviar mensagens de volta para a API

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Configuração do Banco de Dados
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

// 1. PÁGINA HTML COMPLETA (Dashboard / Painel de Conexão)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Porquim IA - Painel WhatsApp</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background: #f0f2f5; margin: 0; padding: 40px 20px; }
                .container { max-width: 450px; margin: 0 auto; background: white; padding: 30px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                h2 { color: #333; margin-top: 0; }
                .qr-box { margin: 20px 0; min-height: 250px; display: flex; align-items: center; justify-content: center; background: #fafafa; border: 2px dashed #ddd; border-radius: 12px; }
                img { max-width: 240px; border-radius: 8px; }
                .status { font-weight: bold; padding: 8px 16px; border-radius: 20px; display: inline-block; margin-bottom: 15px; }
                .status.online { background: #e6f4ea; color: #137333; }
                .status.offline { background: #feefae; color: #b06000; }
                button { background-color: #0d6efd; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; cursor: pointer; transition: 0.2s; }
                button:hover { background-color: #0b5ed7; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>🐷 Porquim IA - Webhook</h2>
                <div id="status-badge" class="status offline">Status: Desconectado</div>
                <div class="qr-box" id="qr-container">
                    <p>Clique abaixo para gerar o QR Code</p>
                </div>
                <button onclick="gerarQrCode()">Gerar QR Code</button>
            </div>

            <script>
                async function gerarQrCode() {
                    const qrContainer = document.getElementById('qr-container');
                    qrContainer.innerHTML = '<p>Carregando QR Code...</p>';
                    
                    try {
                        // Exemplo puxando da rota da API
                        const response = await fetch('/api/get-qrcode');
                        const data = await response.json();

                        if (data.qrcode) {
                            qrContainer.innerHTML = \`<img src="\${data.qrcode}" alt="QR Code WhatsApp" />\`;
                        } else if (data.connected) {
                            document.getElementById('status-badge').className = 'status online';
                            document.getElementById('status-badge').innerText = 'Status: Online e Conectado!';
                            qrContainer.innerHTML = '<p>✅ Aparelho já está conectado!</p>';
                        }
                    } catch (err) {
                        qrContainer.innerHTML = '<p style="color:red">Erro ao conectar com a API</p>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// 2. ROTA DE WEBHOOK (Recebe as mensagens via POST do serviço da API)
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Responde imediatamente HTTP 200 para a API não reenviar

    try {
        // Exemplo de payload vindo da Evolution API / Z-API
        const body = req.body;
        const textoMsg = body.data?.message?.conversation || body.message?.text;
        const from = body.data?.key?.remoteJid || body.phone;

        if (!textoMsg || !from || from.includes('@g.us')) return;

        // Consulta últimos gastos e resumo
        const ultimosGastos = await db.all(
            'SELECT tipo, valor, categoria, descricao, data FROM transacoes WHERE usuario = ? ORDER BY id DESC LIMIT 5',
            [from]
        );

        const resumoMes = await db.get(
            `SELECT 
                SUM(CASE WHEN tipo = 'saida' THEN valor ELSE 0 END) as total_saidas,
                SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END) as total_entradas
             FROM transacoes 
             WHERE usuario = ? AND strftime('%Y-%m', data) = strftime('%Y-%m', 'now')`,
            [from]
        );

        const promptContexto = `
Você é o "Porquim IA", assistente virtual carismático e especialista em finanças pessoais.
Usuário atual: ${from}

DADOS LOCAIS DO USUÁRIO:
- Resumo deste mês: Total Entradas = R$ ${resumoMes?.total_entradas || 0}, Total Saídas = R$ ${resumoMes?.total_saidas || 0}
- Últimos registros: ${JSON.stringify(ultimosGastos)}

REGRAS DE RESPOSTA:
1. Seja sempre amigável, direto e use emojis (🐷, 💰, 📊).
2. Se o usuário estiver registrando um gasto ou ganho, você DEVE incluir ao FINAL da resposta a linha de instrução exatamente neste formato:
REGISTRO|[entrada/saida]|[valor_numerico]|[categoria]|[descricao]
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
                    [from, tipo, parseFloat(valor), categoria, descricao]
                );
            }
        }

        // Envia a resposta de volta usando a API externa (Evolution API / Z-API)
        /* 
        await axios.post('URL_DA_API_EXTERNA/message/sendText', {
            number: from,
            text: respostaTexto
        }); 
        */

    } catch (error) {
        console.error('Erro no Webhook:', error);
    }
});

initDb().then(() => {
    app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
});
