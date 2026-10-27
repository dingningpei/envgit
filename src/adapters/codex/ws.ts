/**
 * Just enough of a WebSocket server (RFC 6455) for Codex's exec-server client: one JSON-RPC message
 * per text frame, fragments reassembled, ping answered, close echoed. Loopback only.
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface WsConnection {
  send(text: string): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
  close(): void
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 256 << 20

/** Accepts upgrades on `path` only (a secret, since the URL is the only credential Codex sends). */
export async function listenWs(path: string, onConnection: (c: WsConnection) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_q, r) => r.writeHead(404).end())
  const sockets = new Set<Socket>()
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const key = req.headers['sec-websocket-key']
    if (req.url !== path || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.setNoDelay(true)
    onConnection(connection(socket))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}${path}`,
    // server.close's callback can wait forever on an upgraded socket whose peer left without a close
    // frame, so destroy them all and stop listening without waiting for it.
    close: async () => {
      for (const s of sockets) s.destroy()
      server.closeAllConnections()
      server.close()
    },
  }
}

function connection(socket: Socket): WsConnection {
  const onMessage: ((t: string) => void)[] = []
  const onClose: (() => void)[] = []
  let buf = Buffer.alloc(0)
  let parts: Buffer[] = []
  let partsLen = 0
  let closed = false
  const frame = (op: number, payload: Buffer) => {
    if (closed || socket.destroyed) return
    const n = payload.length
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    if (n >= 126 && n < 65536) (head[0] = 0x80 | op, head[1] = 126, head.writeUInt16BE(n, 2))
    if (n >= 65536) (head[0] = 0x80 | op, head[1] = 127, head.writeBigUInt64BE(BigInt(n), 2))
    socket.write(Buffer.concat([head, payload]))
  }
  const finish = () => {
    if (closed) return
    closed = true
    socket.destroy()
    for (const f of onClose) f()
  }
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0]! & 0x80) !== 0
      const op = buf[0]! & 0x0f
      const masked = (buf[1]! & 0x80) !== 0
      let len = buf[1]! & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      if (len > MAX_MESSAGE) return finish()
      const mask = masked ? buf.subarray(off, off + 4) : undefined
      if (masked) off += 4
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      buf = buf.subarray(off + len)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
      if (op === 0x8) {
        frame(0x8, payload.subarray(0, 2))
        return finish()
      }
      if (op === 0x9) frame(0xa, payload)
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        parts.push(payload)
        partsLen += payload.length
        if (partsLen > MAX_MESSAGE) return finish()
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          partsLen = 0
          for (const f of onMessage) f(text)
        }
      }
    }
  })
  socket.on('close', finish)
  socket.on('error', finish)
  return {
    send: text => frame(0x1, Buffer.from(text, 'utf8')),
    onMessage: f => void onMessage.push(f),
    onClose: f => void onClose.push(f),
    close: () => (frame(0x8, Buffer.from([0x03, 0xe8])), socket.end()),
  }
}
