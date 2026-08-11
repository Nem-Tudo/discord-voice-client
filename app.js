'use strict';

/**
 * Interface gráfica (NodeGUI / Qt) para o bot de voz.
 * Estilizada com ícones no padrão Discord.
 *
 * Rode com:
 *   npx qode app.js
 */

const {
    QMainWindow,
    QWidget,
    QBoxLayout,
    Direction,
    QLineEdit,
    QPushButton,
    QLabel,
    QTextEdit,
    QIcon,
    QSize,
    WidgetEventTypes
} = require('@nodegui/nodegui');
const path = require('path');

const { createVoiceClient } = require('./src/voice-client.js');

const [, , ARG_TOKEN, ARG_GUILD, ARG_CHANNEL] = process.argv;

// ---------- Caminhos dos Ícones ----------
// Certifique-se de ter esses arquivos na pasta 'assets'
const ASSETS_BASE = path.join(__dirname, 'assets');
const iconMicOn = new QIcon(path.join(ASSETS_BASE, 'mic_on.png'));
const iconMicOff = new QIcon(path.join(ASSETS_BASE, 'mic_off.png'));
const iconDeafenOn = new QIcon(path.join(ASSETS_BASE, 'deafen_on.png'));
const iconDeafenOff = new QIcon(path.join(ASSETS_BASE, 'deafen_off.png'));
const ICON_SIZE = new QSize(20, 20); // Tamanho dos ícones dentro dos botões

// ---------- Janela principal ----------
const win = new QMainWindow();
win.setWindowTitle('Discord Voice');
win.setFixedSize(460, 640);

const central = new QWidget();
central.setObjectName('central');
const rootLayout = new QBoxLayout(Direction.TopToBottom);
rootLayout.setSpacing(10);
rootLayout.setContentsMargins(16, 16, 16, 16);
central.setLayout(rootLayout);

// ---------- Helper de campo de formulário ----------
function makeField(labelText, defaultValue) {
    const wrapper = new QWidget();
    const layout = new QBoxLayout(Direction.TopToBottom);
    layout.setSpacing(4);
    layout.setContentsMargins(0, 0, 0, 0);
    wrapper.setLayout(layout);

    const label = new QLabel();
    label.setText(labelText);
    label.setObjectName('fieldLabel');

    const input = new QLineEdit();
    input.setObjectName('fieldInput');
    input.setPlaceholderText(labelText);
    if (defaultValue) input.setText(defaultValue);

    layout.addWidget(label);
    layout.addWidget(input);

    return { wrapper, input };
}

const tokenField = makeField('Token', ARG_TOKEN);
tokenField.input.setEchoMode(2);
const guildField = makeField('ID do servidor', ARG_GUILD);
const channelField = makeField('ID do canal de voz', ARG_CHANNEL);

rootLayout.addWidget(tokenField.wrapper);
rootLayout.addWidget(guildField.wrapper);
rootLayout.addWidget(channelField.wrapper);

// ---------- Botão conectar ----------
const connectBtn = new QPushButton();
connectBtn.setText('Conectar');
connectBtn.setObjectName('connectBtn');
rootLayout.addWidget(connectBtn);

// ---------- Status ----------
const statusLabel = new QLabel();
statusLabel.setText('Desconectado');
statusLabel.setObjectName('statusLabel');
rootLayout.addWidget(statusLabel);

// ---------- Log ----------
const logLabel = new QLabel();
logLabel.setText('Logs');
logLabel.setObjectName('fieldLabel');
rootLayout.addWidget(logLabel);

const logArea = new QTextEdit();
logArea.setReadOnly(true);
logArea.setObjectName('logArea');
rootLayout.addWidget(logArea, 1);

// ---------- Controles pós-conexão (Ícones) ----------
const controlsWidget = new QWidget();
// Layout horizontal centralizado para os ícones
const controlsLayout = new QBoxLayout(Direction.LeftToRight);
controlsLayout.setSpacing(4);
controlsLayout.setContentsMargins(0, 0, 0, 0);
controlsWidget.setLayout(controlsLayout);

const muteBtn = new QPushButton();
muteBtn.setObjectName('controlIconButton');
muteBtn.setIcon(iconMicOn); // Estado inicial: Ligado
muteBtn.setIconSize(ICON_SIZE);
muteBtn.setToolTip('Mutar/Desmutar Microfone'); // Texto ao passar o mouse

const deafenBtn = new QPushButton();
deafenBtn.setObjectName('controlIconButton');
deafenBtn.setIcon(iconDeafenOff); // Estado inicial: Áudio ligado
deafenBtn.setIconSize(ICON_SIZE);
deafenBtn.setToolTip('Ensurdecer/Reativar Áudio');

const disconnectBtn = new QPushButton();
disconnectBtn.setText('Desconectar');
disconnectBtn.setObjectName('disconnectBtn');
// Opcional: Adicionar ícone de 'sair' no disconnect tbm
// disconnectBtn.setIcon(new QIcon(path.join(ASSETS_BASE, 'logout.svg')));

controlsLayout.addWidget(muteBtn);
controlsLayout.addWidget(deafenBtn);
controlsLayout.addStretch(1); // Empurra os ícones pra esquerda, desconectar pra direita
controlsLayout.addWidget(disconnectBtn);

rootLayout.addWidget(controlsWidget);
controlsWidget.hide();

win.setCentralWidget(central);

// ---------- Estilo Atualizado ----------
central.setStyleSheet(`
  #central { background-color: #313338; }
  #fieldLabel { color: #b5bac1; font-size: 11px; font-weight: bold; }
  #fieldInput {
    background-color: #1e1f22;
    color: #f2f3f5;
    border-radius: 4px;
    padding: 8px;
    border: 1px solid #1e1f22;
    font-size: 13px;
  }
  #fieldInput:focus { border: 1px solid #00a8fc; }
  
  #connectBtn {
    background-color: #23a55a;
    color: white;
    font-weight: bold;
    padding: 10px;
    border-radius: 6px;
    font-size: 14px;
  }
  #connectBtn:hover { background-color: #1f9153; }
  #connectBtn:disabled { background-color: #4a4d52; color: #949ba4; }
  
  #statusLabel { color: #949ba4; font-size: 12px; font-style: italic; }
  
  #logArea {
    background-color: #1e1f22;
    color: #dbdee1;
    border-radius: 4px;
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 11px;
    border: 1px solid #1e1f22;
    padding: 4px;
  }

  /* Estilo dos Botões de Ícone (Mute/Deafen) */
  #controlIconButton {
    background-color: transparent; /* Fundo transparente por padrão */
    border: none;
    padding: 6px;
    border-radius: 5px;
  }
  #controlIconButton:hover {
    background-color: #4e5058; /* Fundo cinza ao passar o mouse */
  }
  #controlIconButton:pressed {
    background-color: #6d6f78;
  }

  #disconnectBtn {
    background-color: #da373c;
    color: white;
    font-weight: bold;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    border: none;
  }
  #disconnectBtn:hover { background-color: #a12d2f; }
`);

// ---------- Lógica de Estado ----------

let client = null;
let muted = false;
let deafened = false;

function log(msg) {
    const time = new Date().toLocaleTimeString('pt-BR');
    logArea.append(`[${time}] ${msg}`);
}

/**
 * Atualiza os ícones dos botões baseados no estado atual
 */
function updateButtonIcons() {
    muteBtn.setIcon(muted ? iconMicOff : iconMicOn);
    deafenBtn.setIcon(deafenBtn ? iconDeafenOn : iconDeafenOff);
}

function setConnectedUI(connected) {
    tokenField.input.setEnabled(!connected);
    guildField.input.setEnabled(!connected);
    channelField.input.setEnabled(!connected);
    connectBtn.setEnabled(!connected);
    connectBtn.setText(connected ? 'Conectado' : 'Conectar');

    controlsWidget.setVisible(connected);
    statusLabel.setText(connected ? 'Conectado à call' : 'Desconectado');

    if (connected) {
        // Garante que os ícones começam corretos ao conectar
        updateButtonIcons();
    }
}

// ---------- Eventos dos Botões ----------

connectBtn.addEventListener('clicked', () => {
    const token = tokenField.input.text().trim();
    const guildId = guildField.input.text().trim();
    const channelId = channelField.input.text().trim();

    if (!token || !guildId || !channelId) {
        log('Preencha token, ID do servidor e ID do canal antes de conectar.');
        return;
    }

    connectBtn.setEnabled(false);
    connectBtn.setText('Conectando...');
    statusLabel.setText('Conectando...');

    client = createVoiceClient({
        token,
        guildId,
        channelId,
        onLog: log,
        onReady: () => setConnectedUI(true),
        onDisconnected: (reason) => {
            log(`Desconectado (${reason})`);
            setConnectedUI(false);

            // Reseta estados locais
            muted = false;
            deafened = false;
            client = null;
        },
    });

    client.connect();
});

// Evento Mute: Apenas inverte o próprio estado
muteBtn.addEventListener('clicked', () => {
    if (!client) return;
    muted = !muted;

    client.setMute(muted);

    // Atualiza apenas o ícone do mic
    muteBtn.setIcon(muted ? iconMicOff : iconMicOn);
    log(muted ? 'Microfone mutado' : 'Microfone desmutado');
});

// Evento Deafen: Lógica especial solicitada
deafenBtn.addEventListener('clicked', () => {
    if (!client) return;

    deafened = !deafened; // Inverte o estado de 'ensurdecer'

    if (deafened) {
        // Se ativou o ensurdecer: Mutar mic é obrigatório no Discord
        muted = true;

        muteBtn.setIcon(iconMicOff); // Atualiza UI do mic
        deafenBtn.setIcon(iconDeafenOn); // Atualiza UI do fone

        // O client.setDeafen(true) no voice-client já trata o selfMute=true
        client.setDeafen(true);

        log('Áudio ensurdecido (mic mutado junto)');
    } else {
        // Se desativou o ensurdecer (Reativar Áudio): 
        // DESMUTAR o mic junto, como solicitado.
        muted = false;

        muteBtn.setIcon(iconMicOn); // Atualiza UI do mic
        deafenBtn.setIcon(iconDeafenOff); // Atualiza UI do fone

        // Precisamos avisar o Discord de ambas as mudanças.
        client.setDeafen(false);
        client.setMute(false); // <--- Mandatório enviar o unmute explicitamente

        log('Áudio reativado (mic desmutado junto)');
    }
});

disconnectBtn.addEventListener('clicked', () => {
    if (!client) return;
    client.disconnect();
});

// 1. Quando o usuário clica no "X" da janela
win.addEventListener(WidgetEventTypes.Close, () => {
    if (client) {
        client.disconnect(); // Tira o bot da call
    }
});

// 2. Quando o usuário fecha pelo terminal (Ctrl + C)
process.on('SIGINT', () => {
    if (client) {
        client.disconnect();
    }
    // Dá um tempinho minúsculo para o WebSocket enviar a mensagem de saída pro Discord
    setTimeout(() => process.exit(0), 100);
});


win.show();
global.win = win; // evita garbage collection da janela