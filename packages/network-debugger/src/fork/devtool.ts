import open, { apps } from 'open'
import { type ChildProcess } from 'child_process'
import { RequestHeaderPipe } from './pipe'
import { log } from '../utils'
import { Server, WebSocket } from 'ws'
import {
  DebuggerJSON,
  IS_DEV_MODE,
  REMOTE_DEBUGGER_ID,
  RequestDetail,
  REMOTE_DEBUGGER_PORT
} from '../common'

export interface DevtoolServerInitOptions {
  port: number
}

const frameId = '517.528'
const loaderId = '517.529'

export const toMimeType = (contentType: string) => {
  return contentType.split(';')[0] || 'text/plain'
}

export class DevtoolServer {
  private server: Server
  private port: number
  private browser: ChildProcess | null = null
  private socket: Promise<[WebSocket]>
  private timestamp = 0
  private startTime = Date.now()

  private listeners: ((error: unknown | null, message?: any) => void)[] = []
  constructor(props: DevtoolServerInitOptions) {
    const { port } = props
    this.port = port
    this.server = new Server({ port })
    const { server } = this

    server.on('listening', () => {
      log(`devtool server is listening on port ${port}`)
      this.open()
    })

    this.socket = new Promise<[WebSocket]>((resolve) => {
      server.on('connection', (socket) => {
        this.socket.then((l) => {
          l[0] = socket
        })
        log('devtool connected')
        socket.on('message', (message) => {
          const msg = JSON.parse(message.toString())
          this.listeners.forEach((listener) => listener(null, msg))
        })
        socket.on('close', () => {
          log('devtool closed')
        })
        socket.on('error', (error) => {
          this.listeners.forEach((listener) => listener(error))
        })
        resolve([socket] satisfies [WebSocket])
      })
    })
  }

  private updateTimestamp() {
    this.timestamp = (Date.now() - this.startTime) / 1000
  }

  public async open() {
    const url = `devtools://devtools/bundled/inspector.html?ws=localhost:${this.port}`

    // if (IS_DEV_MODE) {
    //   log(`In dev mode, open chrome devtool manually: ${url}`)
    //   return
    // }

    const getRemoteJSON = async () =>
      (await fetch(`http://127.0.0.1:${REMOTE_DEBUGGER_PORT}/json`)).json() as unknown as Promise<
        DebuggerJSON[]
      >

    const manageDebuggerWs = (socketUrl: string, command: 'open' | 'close') => {
      const debuggerWs = new WebSocket(socketUrl)
      debuggerWs.on('open', () => {
        const navigateCommand =
          command === 'open'
            ? { id: 1, method: 'Page.navigate', params: { url } }
            : { id: 1, method: 'Page.close' }

        debuggerWs.send(JSON.stringify(navigateCommand))

        debuggerWs.close()
      })
    }

    try {
      const dbHistoryJson = await getRemoteJSON()
      const idx = dbHistoryJson.findIndex((e) => e.url === url)
      if (idx !== -1) {
        console.log('chrome devtool restarting')
        console.log(dbHistoryJson)
        manageDebuggerWs(dbHistoryJson[idx].webSocketDebuggerUrl, 'close')
      }
    } catch (error) {
      console.log('\nchrome devtool starting')
    } finally {
      const pro = await open(url, {
        app: {
          name: apps.chrome,
          arguments: [
            process.platform !== 'darwin' ? `--remote-debugging-port=${REMOTE_DEBUGGER_PORT}` : ''
          ]
        }
      })

      if (process.platform !== 'darwin') {
        const json = await new Promise<DebuggerJSON[]>((resolve) => {
          let stop = setInterval(async () => {
            try {
              resolve(await getRemoteJSON())
              clearInterval(stop)
            } catch {
              console.log('waiting for chrome to open')
            }
          }, 500)
        })
        console.log(json)
        const { webSocketDebuggerUrl } = json[0]
        manageDebuggerWs(webSocketDebuggerUrl, 'open')
      }

      console.log('opened in chrome or click here to open chrome devtool: ', url)
      this.browser = pro
      return pro
    }
  }

  public close() {
    this.server.close()
    this.browser && this.browser.kill()
  }

  async send(message: any) {
    const [socket] = await this.socket
    return socket.send(JSON.stringify(message))
  }

  public on(listener: (error: unknown | null, message?: any) => void) {
    this.listeners.push(listener)
  }

  async requestWillBeSent(request: RequestDetail) {
    this.updateTimestamp()

    const headerPipe = new RequestHeaderPipe(request.requestHeaders)
    const contentType = headerPipe.getHeader('content-type')

    return this.send({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: request.id,
        frameId,
        loaderId,
        request: {
          url: request.url,
          method: request.method,
          headers: request.requestHeaders,
          initialPriority: 'High',
          mixedContentType: 'none',
          ...(request.requestData
            ? {
                postData: contentType?.includes('application/json')
                  ? JSON.stringify(request.requestData)
                  : request.requestData
              }
            : {})
        },
        timestamp: this.timestamp,
        wallTime: request.requestStartTime,
        initiator: request.initiator,
        type: 'Fetch'
      }
    })
  }

  async responseReceived(request: RequestDetail) {
    this.updateTimestamp()
    const headers = new RequestHeaderPipe(request.responseHeaders)

    const contentType = headers.getHeader('content-type') || 'text/plain; charset=utf-8'

    const type = (() => {
      if (/image/.test(contentType)) {
        return 'Image'
      }
      if (/javascript/.test(contentType)) {
        return 'Script'
      }
      if (/css/.test(contentType)) {
        return 'Stylesheet'
      }
      if (/html/.test(contentType)) {
        return 'Document'
      }
      return 'Other'
    })()

    this.send({
      method: 'Network.responseReceived',
      params: {
        requestId: request.id,
        frameId,
        loaderId,
        timestamp: this.timestamp,
        type,
        response: {
          url: request.url,
          status: request.responseStatusCode,
          statusText: request.responseStatusCode === 200 ? 'OK' : '',
          headers: request.responseHeaders,
          connectionReused: false,
          encodedDataLength: request.responseInfo.encodedDataLength,
          charset: 'utf-8',
          mimeType: toMimeType(contentType)
        }
      }
    })

    this.updateTimestamp()
    this.send({
      method: 'Network.dataReceived',
      params: {
        requestId: request.id,
        timestamp: this.timestamp,
        dataLength: request.responseInfo.dataLength,
        encodedDataLength: request.responseInfo.encodedDataLength
      }
    })

    this.updateTimestamp()
    this.send({
      method: 'Network.loadingFinished',
      params: {
        requestId: request.id,
        timestamp: this.timestamp,
        encodedDataLength: request.responseInfo.encodedDataLength
      }
    })
  }
}
