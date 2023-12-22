import * as vscode from 'vscode';
import * as fileservice from 'qconn/out/fileservice';
import { Mutex } from 'async-mutex';

function toFileType(flags: number): vscode.FileType {
	if ((flags & fileservice.Permissions.S_IFMT) === fileservice.Permissions.S_IFDIR) {
		return vscode.FileType.Directory;
	} else if ((flags & fileservice.Permissions.S_IFMT) === fileservice.Permissions.S_IFLNK) {
		return vscode.FileType.SymbolicLink;
	} else if ((flags & fileservice.Permissions.S_IFMT) === fileservice.Permissions.S_IFREG) {
		return vscode.FileType.File;
	} else {
		return vscode.FileType.Unknown;
	}
}

function hostOf(authority: string): string {
	return authority.split(":")[0];
}

function portOf(authority: string): number {
	const parts = authority.split(":");
	if (parts.length === 2) {
		try {
			return parseInt(parts[1]);
		} catch {
			throw new Error(`Authority has invalid port part: ${authority}`);
		}
	} else {
		return 8000; // No port part. Assume default port
	}
}

// Used to make sure that only one operation is performed at a time on a given service
interface SynchronizedService {
	service: fileservice.FileService;
	mutex: Mutex;
}

export class QConnFileSystemProvider implements vscode.FileSystemProvider {
	// Holds a map from an authority to a service and a mutex to synchronize access to it
	private services: Map<string, SynchronizedService> = new Map();

	// Gets a service for a given authority, creating it if it doesn't exist
	async getService(authority: string): Promise<SynchronizedService> {
		const service = this.services.get(authority);
		if (service === undefined) {
			const mutex = new Mutex();
			const service = await fileservice.FileService.connect(hostOf(authority), portOf(authority));
			this.services.set(authority, { service, mutex });
			return { service, mutex };
		}
		return service;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		return syncService.mutex.runExclusive(async () => {
			try {
				const fd = await service.open(uri.path, fileservice.OpenFlags.O_RDONLY);
				const stat = await service.stat(fd);
				await service.close(fd);
				return {
					type: toFileType(stat.mode),
					ctime: stat.ctime * 1000,
					mtime: stat.mtime * 1000,
					size: stat.size
				};
			}
			catch (error: unknown) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		});
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		return syncService.mutex.runExclusive(async () => {
			try {
				const fileNames = await service.list(uri.path);
				let fileInfo: [string, vscode.FileType][] = [];
				for (const fileName of fileNames) {
					const fd = await service.open(uri.path + "/" + fileName, fileservice.OpenFlags.O_RDONLY);
					const stat = await service.stat(fd);
					await service.close(fd);
					fileInfo.push([fileName, toFileType(stat.mode)]);
				}
				return fileInfo;
			}
			catch (error: unknown) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		});
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		return syncService.mutex.runExclusive(async () => {
			try {
				const fd = await service.open(uri.path, fileservice.OpenFlags.O_RDONLY);
				try {
					const data = await service.readAll(fd);
					return data;
				} finally {
					await service.close(fd);
				}
			} catch (error: unknown) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		});
	}

	/**
	 * Write data to a file, replacing its entire contents.
	 *
	 * @param uri The uri of the file.
	 * @param content The new content of the file.
	 * @param options Defines if missing files should or must be created.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when `uri` doesn't exist and `create` is not set.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when the parent of `uri` doesn't exist and `create` is set, e.g. no mkdirp-logic required.
	 * @throws {@linkcode FileSystemError.FileExists FileExists} when `uri` already exists, `create` is set but `overwrite` is not set.
	 * @throws {@linkcode FileSystemError.NoPermissions NoPermissions} when permissions aren't sufficient.
	 */
	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		return syncService.mutex.runExclusive(async () => {
			const defaultPermissions = fileservice.Permissions.S_IRGRP | fileservice.Permissions.S_IROTH | fileservice.Permissions.S_IRUSR | fileservice.Permissions.S_IWUSR;
			if (await this.fileExists(service, uri.path)) {
				// File exists
				if (options.create && !options.overwrite) {
					throw vscode.FileSystemError.NoPermissions(uri);
				}

				const fd = await service.open(uri.path, fileservice.OpenFlags.O_WRONLY | (options.overwrite ? fileservice.OpenFlags.O_TRUNC : 0), defaultPermissions);
				try {
					await service.write(fd, Buffer.from(content));
				} finally {
					await service.close(fd);
				}
				return;
			} else {
				if (!options.create) {
					throw vscode.FileSystemError.FileExists(uri);
				}
				const fd = await service.open(uri.path, fileservice.OpenFlags.O_WRONLY | (options.create ? fileservice.OpenFlags.O_CREAT : 0) | (options.create ? fileservice.OpenFlags.O_TRUNC : 0), defaultPermissions);
				try {
					await service.write(fd, Buffer.from(content));
				} finally {
					await service.close(fd);
				}
				return;
			};
		});
	}


	private async fileExists(service: fileservice.FileService, path: string): Promise<boolean> {
		try {
			const fd = await service.open(path, fileservice.OpenFlags.O_RDONLY);
			await service.close(fd);
			return true;
		} catch (error: unknown) {
			return false;
		}
	}

	/**
	 * Rename a file or folder.
	 *
	 * @param oldUri The existing file.
	 * @param newUri The new location.
	 * @param options Defines if existing files should be overwritten.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when `oldUri` doesn't exist.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when parent of `newUri` doesn't exist, e.g. no mkdirp-logic required.
	 * @throws {@linkcode FileSystemError.FileExists FileExists} when `newUri` exists and when the `overwrite` option is not `true`.
	 * @throws {@linkcode FileSystemError.NoPermissions NoPermissions} when permissions aren't sufficient.
	 */
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (oldUri.authority !== newUri.authority) {
			throw vscode.FileSystemError.NoPermissions("Files must recide on same host");
		}

		const syncService = await this.getService(oldUri.authority);
		const service = syncService.service;
		syncService.mutex.runExclusive(async () => {
			if (! await this.fileExists(service, oldUri.path)) {
				throw vscode.FileSystemError.FileNotFound(oldUri);
			}
			if (await this.fileExists(service, newUri.path)) {
				if (!options.overwrite) {
					throw vscode.FileSystemError.FileExists(newUri);
				} else {
					try {
						await service.delete(newUri.path);
						await service.move(oldUri.path, newUri.path);
					} catch (error: unknown) {
						throw vscode.FileSystemError.NoPermissions(newUri);
					}
				}
			} else {
				try {
					service.move(oldUri.path, newUri.path);
				} catch (error: unknown) {
					throw vscode.FileSystemError.NoPermissions(newUri);
				}
			}
		});
	}

	/**
	 * Delete a file.
	 *
	 * @param uri The resource that is to be deleted.
	 * @param options Defines if deletion of folders is recursive.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when `uri` doesn't exist.
	 * @throws {@linkcode FileSystemError.NoPermissions NoPermissions} when permissions aren't sufficient.
	 */
	async delete(uri: vscode.Uri): Promise<void> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		syncService.mutex.runExclusive(async () => {
			try {
				await service.delete(uri.path);
			}
			catch (error: unknown) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		});
	}

	/**
	 * Create a new directory (Note, that new files are created via `write`-calls).
	 *
	 * @param uri The uri of the new folder.
	 * @throws {@linkcode FileSystemError.FileNotFound FileNotFound} when the parent of `uri` doesn't exist, e.g. no mkdirp-logic required.
	 * @throws {@linkcode FileSystemError.FileExists FileExists} when `uri` already exists.
	 * @throws {@linkcode FileSystemError.NoPermissions NoPermissions} when permissions aren't sufficient.
	 */
	async createDirectory(uri: vscode.Uri): Promise<void> {
		const syncService = await this.getService(uri.authority);
		const service = syncService.service;
		syncService.mutex.runExclusive(async () => {
			if (await this.fileExists(service, uri.path)) {
				throw vscode.FileSystemError.FileExists(uri);
			}

			try {
				await service.open(uri.path, fileservice.OpenFlags.O_CREAT | fileservice.OpenFlags.O_WRONLY, fileservice.Permissions.S_IFDIR | fileservice.Permissions.S_IRUSR | fileservice.Permissions.S_IWUSR | fileservice.Permissions.S_IRGRP | fileservice.Permissions.S_IWGRP | fileservice.Permissions.S_IROTH | fileservice.Permissions.S_IWOTH);
			} catch (error: unknown) {
				throw vscode.FileSystemError.FileExists(uri);
			};
		});
	}

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}
}