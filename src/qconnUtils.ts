import { FileService, SInfoService, LauncherService, OpenFlags, Permissions } from 'qconn';

export interface FileInfo {
    name: string;
    permissions: number;
}

export async function listDir(path: string, host: string, port: number): Promise<FileInfo[]> {
    const fileService = await FileService.connect(host, port);
    try {
        const fileList = await fileService.list(path);

        let fileInfos: FileInfo[] = [];
        for (const file of fileList) {
            const fd = await fileService.open(path + '/' + file, OpenFlags.O_RDONLY);
            try {
                const stat = await fileService.stat(fd);
                fileInfos.push({ name: file, permissions: stat.mode });
            }
            finally {
                await fileService.close(fd);
            }
        }
        return fileInfos;
    } catch (error: unknown) {
        throw new Error(`Unable to list ${path} on ${host}:${port}: ${error}`);
    } finally {
        await fileService.disconnect();
    }
}

export type ReadCallback = (progress: number) => void;

export async function readFile(path: string, host: string, port: number, callback?: ReadCallback): Promise<Buffer> {
    const fileService = await FileService.connect(host, port);
    try {
        const fd = await fileService.open(path, OpenFlags.O_RDONLY);
        try {
            const fileSize = (await fileService.stat(fd)).size;
            let chunks: Buffer[] = [];
            let chunkSize = 1024*2;
            for (let i = 0; i < fileSize / chunkSize; i++) {
                const offset = i*chunkSize;
                chunks.push(await fileService.read(fd, chunkSize, offset));
                if (callback) {
                    if (offset % (1024*128) === 0) {
                        callback(offset * 100 / fileSize);
                    }
                }
            }
            return Buffer.concat(chunks);
        } finally {
            await fileService.close(fd);
        }
    } catch (error) {
        throw new Error(`Unable to read ${path} on ${host}:${port}: ${error}`);
    } finally {
        await fileService.disconnect();
    }
}

export async function fetchProcesses(host: string, port: number): Promise<Map<number, string>> {
    const psService = await SInfoService.connect(host, port);
    try {
        const pids = await psService.getPids();
        let outPids = new Map<number, string>();
        for (const pid of pids) {
            outPids.set(pid[0], pid[1].path);
        }
        return outPids;
    } catch (error) {
        throw new Error(`Unable to fetch processes on ${host}:${port}`);
    } finally {
        await psService.disconnect();
    }
}

export async function mkDir(path: string, host: string, port: number): Promise<void> {
    const fileService = await FileService.connect(host, port);
    try {
        await fileService.open(path, OpenFlags.O_CREAT | OpenFlags.O_WRONLY, Permissions.S_IFDIR | Permissions.S_IRUSR | Permissions.S_IWUSR | Permissions.S_IRGRP | Permissions.S_IWGRP | Permissions.S_IROTH | Permissions.S_IWOTH);
    } catch (error) {
        throw new Error(`Unable to make dir on ${host}:${port}`);
    } finally {
        await fileService.disconnect();
    }
}

export async function deleteFile(path: string, host: string, port: number): Promise<void> {
    const fileService = await FileService.connect(host, port);
    try {
        await fileService.delete(path);
    } catch (error) {
        throw new Error(`Unable to delete file on ${host}:${port}`);
    } finally {
        await fileService.disconnect();
    }
}

async function fileExists(service: FileService, path: string): Promise<boolean> {
    try {
        const fd = await service.open(path, OpenFlags.O_RDONLY);
        await service.close(fd);
        return true;
    } catch (error: unknown) {
        return false;
    }
}

export async function writeFile(fileData: Buffer, path: string, create: boolean, overwrite: boolean, host: string, port: number): Promise<void> {
    const fileService = await FileService.connect(host, port);
    try {
        const defaultPermissions = Permissions.S_IRGRP | Permissions.S_IROTH | Permissions.S_IRUSR | Permissions.S_IWUSR;
        if (await fileExists(fileService, path)) {
            if (create && !overwrite) {
                throw new Error("File exists, and we don't want to overwrite");
            }
            const fd = await fileService.open(path, OpenFlags.O_WRONLY | (overwrite ? OpenFlags.O_TRUNC : 0), defaultPermissions);
            try {
                await fileService.write(fd, fileData);
            } catch (error: unknown) {
                throw new Error(`Cannot write to ${host}:${port}${path}: ${error}`);
            } finally {
                await fileService.close(fd);
            }
            return;
        } else {
            if (!create) {
                throw new Error(`File ${host}:${port}${path} doesn't exist and we were not instructed to create one`);
            }
            const fd = await fileService.open(path, OpenFlags.O_WRONLY | (create ? OpenFlags.O_CREAT : 0) | (create ? OpenFlags.O_TRUNC : 0), defaultPermissions);
            try {
                await fileService.write(fd, fileData);
            } catch (error: unknown) {
                throw new Error(`Cannot write to ${host}:${port}${path}: ${error}`);
            } finally {
                await fileService.close(fd);
            }
            return;
        };
    } finally {
        fileService.disconnect();
    }
}

export async function executeCommand(host: string, port: number, command: string, args?: string[]): Promise<string> {
    const executeService = await LauncherService.connect(host, port);
    try {
        return await executeService.execute(command, args);
    } finally {
        executeService.disconnect();
    }
}
