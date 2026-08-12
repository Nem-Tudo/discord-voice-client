import React, { useEffect, useRef, useState } from 'react';

function LogsApp() {
    const [logs, setLogs] = useState([]);
    const logAreaRef = useRef(null);

    useEffect(() => {
        const unsubscribe = window.discordVoice.onLog((line) => {
            setLogs((previous) => [...previous, line]);
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const el = logAreaRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [logs]);

    return (
        <main className="logs-window">
            <header className="logs-window-header">
                <h1>LOGS</h1>
                <button
                    type="button"
                    className="secondary-button"
                    title="Limpar logs"
                    onClick={() => setLogs([])}
                >
                    Limpar
                </button>
            </header>

            <pre ref={logAreaRef} className="log-area logs-window-area">
                {logs.length ? logs.join('\n') : 'Vazio... Igual o coração dela'}
            </pre>
        </main>
    );
}

export default LogsApp;
