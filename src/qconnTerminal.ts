import * as vscode from 'vscode';
import * as net from 'net';

type CallbackType = (data: Buffer, error: any | undefined) => void;

class PacketizedSocket {
    private socket: net.Socket;
    private endOfPacket: Buffer | number = Buffer.alloc(0);
    private callback: CallbackType | undefined;
    private receiveBuffer: Buffer = Buffer.alloc(0);

    constructor(socket: net.Socket) {
        this.socket = socket;
        this.socket.on('data', (data) => {
            this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
            this.handleData();
        });
        this.socket.on('close', () => { this.handleClose(); });
        this.socket.on('error', (error) => { this.handleError(error); });
    }

    private handleData() {
        if (this.endOfPacket instanceof Buffer) {
            const index = this.receiveBuffer.indexOf(this.endOfPacket);
            if (index !== -1) {
                if (this.callback) {
                    const endOfPacketIndex = index + this.endOfPacket.length;
                    const packet = Buffer.from(this.receiveBuffer.subarray(0, endOfPacketIndex));
                    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(endOfPacketIndex));
                    this.callback(packet, undefined);
                    this.callback = undefined;
                }
            }
        } else if (typeof this.endOfPacket === "number") {
            if (this.receiveBuffer.length >= this.endOfPacket) {
                if (this.callback) {
                    const packet = Buffer.from(this.receiveBuffer.subarray(0, this.endOfPacket));
                    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(this.endOfPacket));
                    this.callback(packet, undefined);
                    this.callback = undefined;
                }
            }
        } else {
            throw new Error("endOfPacket is not of Buffer or number type");
        }
    }

    async waitForClose(): Promise<Buffer> {
        return new Promise<Buffer>((resolve) => {
            this.callback = (data, error) => {
                if (error instanceof Error && error.message === "Socket closed") {
                    resolve(data);
                }
            };
        });
    }

    private handleClose() {
        if (this.callback) {
            this.callback(this.receiveBuffer, Error("Socket closed"));
        }
    }

    private handleError(error: any) {
        if (this.callback) {
            this.callback(this.receiveBuffer, Error("Socket error" + error.description));
        }
    }

    public write(buffer: Buffer | string) {
        this.socket.write(buffer);
    }

    async read(endOfPacket: string | Buffer | number, timeout: number = 50000): Promise<Buffer> {
        if (typeof endOfPacket === "string") {
            this.endOfPacket = Buffer.from(endOfPacket);
        } else {
            this.endOfPacket = endOfPacket;
        }
        if (this.callback) {
            throw new Error("A request is already pending");
        }

        return new Promise<Buffer>((resolve, reject) => {
            var timer = setTimeout(() => {
                this.callback = undefined;
                reject("Timeout");
            }, timeout);
            this.callback = (data, error) => {
                clearTimeout(timer);
                if (error) {
                    reject(error);
                } else {
                    resolve(data);
                }
            };
            this.handleData();
        });
    }
}

export async function createQConnTerminal(host: string, port: number) {
    const writeEmitter = new vscode.EventEmitter<string>();
    const onDidClose = new vscode.EventEmitter<number>();
    const socket = net.createConnection({ host: host, port: port }, () => {
        const pty = {
            onDidWrite: writeEmitter.event,
            onDidClose: onDidClose.event,
            open: async () => {
                writeEmitter.fire(`Connecting to ${host}...\r\n`);
                var client = new PacketizedSocket(socket);
                await client.read("QCONN\r\n");
                await client.read(Buffer.from([0xff, 0xfd, 0x22]));
                client.write("service launcher\r\n");
                await client.read("OK\r\n");
                client.write("start/flags run /bin/sh /bin/sh -i\r\n");
                await client.read("have full job control\n");
                writeEmitter.fire(`Connected to ${host}\r\n`);
                socket.on("data", (data) => {
                    writeEmitter.fire(data.toString("utf8").replace(/\r\n|\n/g, '\r\n'));
                });
                socket.on("close", () => {
                    writeEmitter.fire("Remote side closed the connection\r\n");
                    onDidClose.fire(0);
                });
            },
            close: () => {
                socket.write("exit\r\n", () => { socket.end(); });
            },
            handleInput: (data: string) => {
                socket.write(data.replace("\r", "\r\n"));
            }
        };
        const terminal = vscode.window.createTerminal({ name: `QNX@${host}`, pty });
        terminal.show();
    });
}
