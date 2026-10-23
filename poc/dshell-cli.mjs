#!/usr/bin/env node
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const socketPath = process.env.DSHELL_SOCKET ?? join(home, 'run', 'dshell.sock')
const [command = 'list', sessionId, ...textParts] = process.argv.slice(2)

function fail(message) {
  console.error(`dshell: ${message}`)
  process.exitCode = 1
}

function send(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`)
}

function printEvent(event) {
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const text = (data.message?.content ?? data.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    console.log(`[user] ${text}`)
    return
  }
  if (event.type === 'assistant/message') {
    const message = data.message ?? data
    const text = (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    console.log(`[assistant] ${text}`)
    return
  }
  if (event.type === 'tool/call') {
    console.log(`[tool] ${data.name ?? data.toolName ?? 'call'} ${JSON.stringify(data.arguments ?? {})}`)
    return
  }
  if (event.type === 'tool/result') {
    console.log(`[tool-result] ${data.isError ? 'error' : 'ok'}`)
    return
  }
  if (event.type === 'approval/asked') {
    console.log(`[approval] ${data.toolName ?? 'tool'} ${data.reason ?? ''}`)
    return
  }
  if (event.type === 'turn/end') {
    console.log(`[turn-end] ${JSON.stringify(data.reason ?? {})}`)
    return
  }
  console.log(`[event] ${event.type}`)
}

const socket = connect(socketPath)
socket.setEncoding('utf8')
socket.on('connect', () => send(socket, { type: 'hello' }))

const lines = createInterface({ input: socket })
let welcomed = false

lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    fail(`invalid server line: ${line}`)
    return
  }

  if (message.type === 'welcome') {
    welcomed = true
    console.log(`[connected] protocol=${message.protocol} socket=${message.socketPath}`)
    for (const item of message.sessions ?? []) {
      console.log(`[session] ${item.sessionId} live=${item.live} cwd=${item.cwd ?? ''}`)
    }
    if (command === 'list') {
      socket.end()
    } else if (command === 'attach') {
      if (!sessionId) {
        fail('attach requires a sessionId')
        socket.end()
        return
      }
      send(socket, { type: 'attach', sessionId })
    } else if (command === 'prompt') {
      if (!sessionId || textParts.length === 0) {
        fail('prompt requires <sessionId> <text...>')
        socket.end()
        return
      }
      send(socket, { type: 'prompt', sessionId, text: textParts.join(' ') })
    } else {
      fail(`unknown command: ${command}`)
      socket.end()
    }
    return
  }

  if (message.type === 'sessions') {
    for (const item of message.sessions ?? []) {
      console.log(`[session] ${item.sessionId} live=${item.live} cwd=${item.cwd ?? ''}`)
    }
    socket.end()
    return
  }

  if (message.type === 'attached') {
    console.log(`[attached] ${message.sessionId} cursor=${message.cursor} events=${message.events?.length ?? 0}`)
    for (const event of message.events ?? []) printEvent(event)
    if (command === 'attach') {
      console.log('[attached] listening; press Ctrl-C to exit')
    }
    return
  }

  if (message.type === 'accepted') {
    console.log(`[accepted] requestId=${message.requestId} mode=${message.mode}`)
    return
  }

  if (message.type === 'event') {
    printEvent(message.event)
    if (message.event?.type === 'turn/end') socket.end()
    return
  }

  if (message.type === 'stream') {
    const frame = message.frame
    if (frame?.type === 'chunk') {
      const text = frame.chunk?.text ?? frame.text ?? ''
      if (text) process.stdout.write(text)
    }
    return
  }

  if (message.type === 'status') {
    console.log(`[status] ${message.status}`)
    return
  }

  if (message.type === 'error') {
    fail(`${message.code}: ${message.message}`)
    socket.end()
    return
  }
})

socket.on('error', (error) => {
  fail(`cannot connect to ${socketPath}: ${error.message}`)
})

socket.on('close', () => {
  if (!welcomed) fail(`no welcome from ${socketPath}`)
})
