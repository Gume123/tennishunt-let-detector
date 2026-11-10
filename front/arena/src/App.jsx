import { useCallback, useEffect, useRef, useState } from "react";
import './index.css'
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8000/ws/frontend`;
const SOUND_URL = "/let.mp3"; // coloque o arquivo em /public/let_sound.mp3
const LOCK_MS = 2000; // duração do alerta e do bloqueio dos botões

const CONNECTION_LABEL = {
  connecting: "Conectando ao servidor…",
  open: "Servidor conectado",
  closed: "Servidor offline, tentando de novo…",
};

export default function App() {
  const [started, setStarted] = useState(false);
  const [audioStatus, setAudioStatus] = useState("idle"); // idle | loading | ready | error
  const [connection, setConnection] = useState("connecting");
  const [sensorOnline, setSensorOnline] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [players, setPlayers] = useState([
    { name: "Jogador A", score: 0 },
    { name: "Jogador B", score: 0 },
  ]);

  // Refs: valores que o WebSocket precisa ler sem recriar a conexão.
  const startedRef = useRef(false);
  const audioCtxRef = useRef(null);
  const audioBufferRef = useRef(null);
  const lockTimerRef = useRef(null);

  // ---------- Áudio ----------
  // Chamado DENTRO do clique em "Iniciar Partida" (gesto do usuário).
  const unlockAudio = useCallback(async () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("AudioContext não suportado");

      const ctx = audioCtxRef.current ?? new Ctx();
      audioCtxRef.current = ctx;
      await ctx.resume();

      // Toca 1 amostra silenciosa: garante o desbloqueio no iOS/Safari.
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);

      // Baixa e decodifica o som uma única vez; depois a reprodução é instantânea.
      setAudioStatus("loading");
      const res = await fetch(SOUND_URL);
      if (!res.ok) throw new Error(`Falha ao carregar ${SOUND_URL}`);
      const data = await res.arrayBuffer();
      audioBufferRef.current = await ctx.decodeAudioData(data);
      setAudioStatus("ready");
    } catch (err) {
      console.error("Áudio indisponível:", err);
      setAudioStatus("error");
    }
  }, []);

  const playLetSound = useCallback(() => {
    const ctx = audioCtxRef.current;
    const buffer = audioBufferRef.current;
    if (!ctx || !buffer) return;
    if (ctx.state === "suspended") ctx.resume(); // o navegador pode suspender em segundo plano
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
  }, []);

  // ---------- Evento de LET ----------
  const handleLet = useCallback(() => {
    if (!startedRef.current) return; // ignora até a partida começar
    setInterrupted(true);
    playLetSound();
    clearTimeout(lockTimerRef.current); // um novo "let" reinicia a contagem
    lockTimerRef.current = setTimeout(() => setInterrupted(false), LOCK_MS);
  }, [playLetSound]);

  // ---------- WebSocket com reconexão ----------
  useEffect(() => {
    let ws;
    let retry = 0;
    let timer;
    let cancelled = false;

    const connect = () => {
      setConnection("connecting");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        retry = 0;
        setConnection("open");
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.event === "let") handleLet(msg);
        else if (msg.event === "sensor_status") setSensorOnline(Boolean(msg.connected));
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnection("closed");
        setSensorOnline(false);
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [handleLet]);

  // Limpeza geral ao desmontar.
  useEffect(
    () => () => {
      clearTimeout(lockTimerRef.current);
      audioCtxRef.current?.close();
    },
    []
  );

  // ---------- Ações ----------
  const startMatch = () => {
    startedRef.current = true;
    setStarted(true);
    unlockAudio(); // precisa rodar dentro do handler de clique
  };

  const changeScore = (index, delta) => {
    if (interrupted) return;
    setPlayers((prev) =>
      prev.map((p, i) => (i === index ? { ...p, score: Math.max(0, p.score + delta) } : p))
    );
  };

  const resetScores = () => setPlayers((prev) => prev.map((p) => ({ ...p, score: 0 })));

  // ---------- Tela inicial ----------
  if (!started) {
    return (
      <main className="min-h-screen bg-[#0d3b66] text-white grid place-items-center p-6 font-['Barlow',system-ui,sans-serif]">
        <div className="max-w-md w-full text-center">
          <h1 className="font-['Barlow_Condensed',system-ui,sans-serif] text-5xl sm:text-6xl font-bold tracking-tight">
            Smart Tennis Arena
          </h1>
          <p className="mt-4 text-lg text-white/80">
            Toque para começar. Isso libera o som do alerta de LET neste navegador.
          </p>
          <button
            onClick={startMatch}
            className="mt-10 w-full rounded-2xl bg-[#ff8a1f] px-8 py-6 text-2xl font-bold text-[#1a1208]
                       hover:bg-[#ff9d44] active:scale-[0.98] focus-visible:outline focus-visible:outline-4
                       focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            Iniciar Partida
          </button>
        </div>
      </main>
    );
  }

  // ---------- Placar ----------
  return (
    <main className="min-h-screen bg-[#0d3b66] text-white flex flex-col font-['Barlow',system-ui,sans-serif]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm sm:text-base">
        <div className="flex flex-wrap gap-x-6 gap-y-1" role="status">
          <StatusDot ok={connection === "open"} label={CONNECTION_LABEL[connection]} />
          <StatusDot
            ok={sensorOnline}
            label={sensorOnline ? "Sensor conectado" : "Sensor desconectado"}
          />
          {audioStatus === "error" && (
            <span className="font-semibold text-[#ffd166]">
              Som indisponível: verifique o arquivo let_sound.mp3
            </span>
          )}
        </div>
        <button
          onClick={resetScores}
          disabled={interrupted}
          className="rounded-lg border-2 border-white/70 px-4 py-2 font-semibold hover:bg-white/10
                     disabled:opacity-40 focus-visible:outline focus-visible:outline-4 focus-visible:outline-white"
        >
          Zerar placar
        </button>
      </header>

      {/* Duas metades separadas pela "rede" */}
      <section className="flex-1 grid grid-cols-1 md:grid-cols-2 md:divide-x-4 divide-y-4 md:divide-y-0 divide-white/90 border-y-4 border-white/90">
        {players.map((player, i) => (
          <div key={player.name} className="flex flex-col items-center justify-center gap-6 p-6">
            <h2 className="font-['Barlow_Condensed',system-ui,sans-serif] text-3xl sm:text-4xl font-semibold">
              {player.name}
            </h2>
            <p
              aria-live="polite"
              aria-label={`${player.name}: ${player.score} pontos`}
              className="font-['Barlow_Condensed',system-ui,sans-serif] text-[9rem] sm:text-[12rem] leading-none font-bold tabular-nums"
            >
              {player.score}
            </p>
            <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
              <ScoreButton
                label={`Remover ponto de ${player.name}`}
                onClick={() => changeScore(i, -1)}
                disabled={interrupted}
                variant="minus"
              >
                −1
              </ScoreButton>
              <ScoreButton
                label={`Adicionar ponto para ${player.name}`}
                onClick={() => changeScore(i, +1)}
                disabled={interrupted}
                variant="plus"
              >
                +1
              </ScoreButton>
            </div>
          </div>
        ))}
      </section>

      {/* Alerta de LET */}
      {interrupted && (
        <div
          role="alert"
          className="fixed inset-0 z-50 grid place-items-center bg-red-600 text-white motion-safe:animate-pulse"
        >
          <div className="text-center px-6">
            <p className="font-['Barlow_Condensed',system-ui,sans-serif] text-[8rem] sm:text-[14rem] leading-none font-bold">
              LET!
            </p>
            <p className="mt-2 text-2xl sm:text-3xl font-semibold">
              Ponto interrompido. Placar bloqueado por um instante.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function StatusDot({ ok, label }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-3 w-3 rounded-full ${ok ? "bg-emerald-400" : "bg-white/40 ring-2 ring-white/70"}`}
      />
      {label}
    </span>
  );
}

function ScoreButton({ children, label, onClick, disabled, variant }) {
  const palette =
    variant === "plus"
      ? "bg-[#ff8a1f] text-[#1a1208] hover:bg-[#ff9d44]"
      : "bg-white/15 text-white border-2 border-white/70 hover:bg-white/25";
  return (
    <button
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`${palette} min-h-24 rounded-2xl text-5xl font-bold active:scale-[0.97]
                  disabled:opacity-40 disabled:cursor-not-allowed
                  focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-white`}
    >
      {children}
    </button>
  );
}