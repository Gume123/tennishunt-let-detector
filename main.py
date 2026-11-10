"""
Smart Tennis Arena - Hub (FastAPI)

Entradas de eventos do sensor:
  - USB serial (padrão): o servidor lê a porta do ESP32 e repassa os JSON
  - WebSocket /ws/arduino (opcional): continua funcionando, caso volte a usar Wi-Fi

Saída:
  - WebSocket /ws/frontend: o React escuta os eventos em tempo real

Rodar:
  pip install fastapi "uvicorn[standard]" pyserial
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Variáveis de ambiente:
  SERIAL_PORT  "auto" (padrão), "off" para desligar, ou a porta (COM3, /dev/ttyUSB0...)
  SERIAL_BAUD  padrão 115200 (igual ao Serial.begin do firmware)
"""

import asyncio
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import serial
from serial.tools import list_ports
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("arena-hub")

SERIAL_PORT = os.getenv("SERIAL_PORT", "auto")
SERIAL_BAUD = int(os.getenv("SERIAL_BAUD", "115200"))

# Fabricantes comuns de conversores USB-serial em placas ESP32
USB_SERIAL_VIDS = {
    0x10C4,  # Silicon Labs CP210x
    0x1A86,  # WCH CH340/CH9102
    0x0403,  # FTDI
    0x303A,  # Espressif (USB nativo)
    0x2341,  # Arduino (UNO R4 WiFi, etc.)
    0x2A03,  # Arduino.org
}


class Hub:
    """Guarda as conexões ativas e faz o broadcast para os front-ends."""

    def __init__(self) -> None:
        self.frontends: set[WebSocket] = set()
        self.arduinos: set[WebSocket] = set()  # sensores via WebSocket
        self.serial_connected = False  # sensor via USB

    @property
    def sensor_online(self) -> bool:
        return self.serial_connected or len(self.arduinos) > 0

    async def broadcast(self, message: dict) -> None:
        targets = list(self.frontends)
        if not targets:
            return
        results = await asyncio.gather(
            *(ws.send_json(message) for ws in targets), return_exceptions=True
        )
        for ws, result in zip(targets, results):
            if isinstance(result, Exception):
                self.frontends.discard(ws)

    async def broadcast_sensor_status(self) -> None:
        await self.broadcast({"event": "sensor_status", "connected": self.sensor_online})

    async def set_serial_connected(self, value: bool) -> None:
        if self.serial_connected != value:
            self.serial_connected = value
            await self.broadcast_sensor_status()

    async def handle_sensor_message(self, raw: str) -> None:
        """Valida uma mensagem do sensor (serial ou WebSocket) e faz o broadcast."""
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("JSON inválido do sensor: %r", raw)
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("event"), str):
            log.warning("Mensagem sem campo 'event': %r", payload)
            return
        log.info("Evento recebido: %s", payload)
        await self.broadcast(payload)


hub = Hub()


# ---------------------- Leitor da porta serial (USB) ----------------------
def find_serial_port() -> str | None:
    for p in list_ports.comports():
        if p.vid in USB_SERIAL_VIDS:
            return p.device
    return None


def serial_worker(loop: asyncio.AbstractEventLoop, stop: threading.Event) -> None:
    """Thread que lê a serial e entrega as linhas JSON ao loop do asyncio.
    Se o cabo for desconectado, tenta reconectar sozinha."""

    def submit(coro) -> None:
        if not loop.is_closed():
            asyncio.run_coroutine_threadsafe(coro, loop)

    while not stop.is_set():
        port = find_serial_port() if SERIAL_PORT == "auto" else SERIAL_PORT
        if not port:
            stop.wait(2)
            continue
        try:
            # Abrir a porta reinicia a maioria das placas ESP32 (normal).
            with serial.Serial(port, SERIAL_BAUD, timeout=1) as ser:
                log.info("Serial aberta em %s @ %d", port, SERIAL_BAUD)
                submit(hub.set_serial_connected(True))
                while not stop.is_set():
                    line = ser.readline().decode("utf-8", errors="ignore").strip()
                    # Só linhas JSON viram evento; logs de debug do firmware são ignorados.
                    if line.startswith("{"):
                        submit(hub.handle_sensor_message(line))
        except (serial.SerialException, OSError) as exc:
            log.warning("Serial indisponível (%s): %s", port, exc)
        finally:
            submit(hub.set_serial_connected(False))
        stop.wait(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()
    if SERIAL_PORT.lower() != "off":
        loop = asyncio.get_running_loop()
        threading.Thread(target=serial_worker, args=(loop, stop), daemon=True).start()
    yield
    stop.set()


app = FastAPI(title="Smart Tennis Arena Hub", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "frontends": len(hub.frontends),
        "sensor_online": hub.sensor_online,
        "serial_connected": hub.serial_connected,
    }


@app.get("/serial/ports")
async def serial_ports() -> list[dict]:
    return [
        {
            "device": p.device,
            "description": p.description,
            "vid": f"{p.vid:#06x}" if p.vid else None,
            "pid": f"{p.pid:#06x}" if p.pid else None,
        }
        for p in list_ports.comports()
    ]


@app.post("/simulate/let")
async def simulate_let() -> dict:
    """Dispara um 'let' falso, útil para testar o front sem o hardware."""
    await hub.broadcast({"event": "let", "timestamp": int(time.time() * 1000), "simulated": True})
    return {"sent_to": len(hub.frontends)}


@app.websocket("/ws/frontend")
async def frontend_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.frontends.add(ws)
    log.info("Front-end conectado (%d ativos)", len(hub.frontends))
    await ws.send_json({"event": "sensor_status", "connected": hub.sensor_online})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.frontends.discard(ws)
        log.info("Front-end desconectado (%d ativos)", len(hub.frontends))


@app.websocket("/ws/arduino")
async def arduino_endpoint(ws: WebSocket) -> None:
    """Opcional: sensor via Wi-Fi."""
    await ws.accept()
    hub.arduinos.add(ws)
    await hub.broadcast_sensor_status()
    try:
        while True:
            await hub.handle_sensor_message(await ws.receive_text())
    except WebSocketDisconnect:
        pass
    finally:
        hub.arduinos.discard(ws)
        await hub.broadcast_sensor_status()