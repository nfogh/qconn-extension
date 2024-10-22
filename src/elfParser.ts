import * as fs from 'fs/promises';
import { BufferReader } from 'node-bufferreader';
import * as path from 'path';

async function fileExists(path: string) : Promise<boolean>
{
    try {
        await fs.stat(path);
        return true;
    } catch {
        return false;
    }
}

enum Endianess {
    Little,
    Big
}

export enum Type {
    None = 0,
    Rel = 1,
    Exec = 2,
    Dyn = 3,
    Core = 4,
    LOOS = 0xfe00,
    HIOS = 0xfeff,
    LOPROC = 0xff00,
    HIPROC = 0xffff
};

interface Section {
    nameOffset: number;
    type: number;
    flags: number | bigint;
    addr: number | bigint;
    offset: number | bigint;
    size: number | bigint;
    link: number;
    info: number;
    addralign: number | bigint;
    entsize: number | bigint;
}

interface ProgramHeader {
    type: number;
    flags: number;
    offset: number | bigint;
    vaddr: number | bigint;
    paddr: number | bigint;
    filesz: number | bigint;
    memsz: number | bigint;
    align: number | bigint;
}

interface NoteHeader {
    name: number;
    desc: number;
    type: number;
};

interface LinkMapEntry {
    loadBase: number | bigint;
    soName: string;
    path: string;
    buildid: string;
};

function readNullTerminatedString(buffer: Buffer, offset: number): string {
    let str = "";
    let c = 0;
    do {
        c = buffer.readInt8(offset);
        if (c !== 0) {
            str = str + String.fromCharCode(c);
        }
        offset = offset + 1;
    } while ((c !== 0) && (offset < buffer.length));

    return str;
}

function roundUpToMultiple(num: number, mul: number): number {
    return Math.ceil(num / mul) * mul;
}


export class ElfFileReader {
    endianess: Endianess = Endianess.Little;
    numBits: number = 32;
    shoff: number | bigint = 0;
    shnum: number = 0;
    shentsize: number = 0;
    shstrndx: number = 0;
    phnum: number = 0;
    phoff: number | bigint = 0;
    machine: number = -1;
    osabi: number = -1;
    abiversion: number = -1;
    type: Type = Type.None;

    readUInt16(reader: BufferReader) {
        return this.endianess === Endianess.Little ? reader.readUInt16LE() : reader.readUInt16BE();
    }

    readUInt32(reader: BufferReader) {
        return this.endianess === Endianess.Little ? reader.readUInt32LE() : reader.readUInt32BE();
    }

    readNativeUInt(reader: BufferReader): number | bigint {
        if (this.endianess === Endianess.Little) {
            return this.numBits === 32 ? reader.readUInt32LE() : reader.readBigUInt64LE();
        } else {
            return this.numBits === 32 ? reader.readUInt32BE() : reader.readBigUInt64BE();
        }
    }

    public async getHeaders(path: string): Promise<void> {
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);
        }
        finally {
            handle.close();
        }
    }

    public async getCommentSection(path: string): Promise<string | undefined> {
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);
            const sections = await this.readSections(handle);
            return sections.get('.comment')?.toString('utf8');
        } finally {
            handle.close();
        }
    }

    public async getLinkMap(path: string): Promise<LinkMapEntry[]> {
        let linkMapEntries: LinkMapEntry[] = [];
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);

            const headerSize = this.numBits === 32 ? 0x20 : 0x38;
            const buffer = Buffer.alloc(headerSize);

            let programHeaders: ProgramHeader[] = [];
            for (let i = 0; i < this.phnum; i++) {
                await handle.read(buffer, 0, headerSize, Number(this.phoff) + i * headerSize);
                const reader = new BufferReader(buffer);

                const type = this.readUInt32(reader);
                let flags: number = 0;
                if (this.numBits === 64) {
                    flags = this.readUInt32(reader);
                }
                const offset = this.readNativeUInt(reader);
                const vaddr = this.readNativeUInt(reader);
                const paddr = this.readNativeUInt(reader);
                const filesz = this.readNativeUInt(reader);
                const memsz = this.readNativeUInt(reader);
                if (this.numBits === 32) {
                    flags = this.readUInt32(reader);
                }
                const align = this.readNativeUInt(reader);

                programHeaders.push({
                    type: type,
                    flags: flags,
                    offset: offset,
                    vaddr: vaddr,
                    paddr: paddr,
                    filesz: filesz,
                    memsz: memsz,
                    align: align
                });
            }

            const noteHeaders = programHeaders.filter(header => header.type === 0x4);

            if (noteHeaders.length !== 1) {
                return linkMapEntries;
            }

            const notesData = Buffer.alloc(Number(noteHeaders[0].filesz));
            await handle.read(notesData, 0, notesData.length, Number(noteHeaders[0].offset));

            const notesDataReader = new BufferReader(notesData);

            while (notesDataReader.offset !== notesData.length) {

                const noteNameSize = this.readUInt32(notesDataReader);
                const noteDescriptionSize = this.readUInt32(notesDataReader);
                const noteType = this.readUInt32(notesDataReader);
                //const noteLength = 12 + roundUpToMultiple(noteNameSize, 4) + roundUpToMultiple(noteDescriptionSize, 4);

                const noteName = notesDataReader.readBuffer(noteNameSize - 1).toString('utf8');
                notesDataReader.skip(1);
                const noteData = notesDataReader.readBuffer(noteDescriptionSize);
                const QNT_LINK_MAP = 11;
                if ((noteName === 'QNX') && (noteType === QNT_LINK_MAP)) {
                    // QNT_LINK_MAP
                    const linkMapReader = new BufferReader(noteData);
                    linkMapReader.skip(4);
                    const linkMapStringTableOffset = this.readUInt32(linkMapReader);
                    const linkMapStringTableSize = this.readUInt32(linkMapReader);
                    const linkMapBuildIdsSize = this.readUInt32(linkMapReader);
                    linkMapReader.skip(72);

                    // Load build IDs
                    const buildIdOffset = roundUpToMultiple(32 + linkMapStringTableOffset + linkMapStringTableSize, 4);
                    let buildIdReader = new BufferReader(noteData.subarray(buildIdOffset, buildIdOffset + linkMapBuildIdsSize));
                    let buildIds: string[] = [];
                    while (buildIdReader.offset !== linkMapBuildIdsSize) {
                        buildIdReader.skip(4);
                        const buildId = buildIdReader.readBuffer(16).toString('hex');
                        buildIds.push(buildId);
                    }

                    let index = 0;
                    const extraDataSize = 40;
                    const headerSize = 32;
                    while (linkMapReader.offset < linkMapStringTableOffset + headerSize - extraDataSize) {
                        const loadBase = this.readNativeUInt(linkMapReader);
                        const soNameStringTableOffset = Number(this.readNativeUInt(linkMapReader));
                        linkMapReader.skip(40);
                        const pathStringTableOffset = Number(this.readNativeUInt(linkMapReader));
                        //                        linkMapReader.skip(32);
                        const soName = readNullTerminatedString(noteData, 32 + linkMapStringTableOffset + soNameStringTableOffset);
                        const path = readNullTerminatedString(noteData, 32 + linkMapStringTableOffset + pathStringTableOffset);

                        linkMapEntries.push({
                            loadBase: loadBase,
                            soName: soName,
                            path: path,
                            buildid: buildIds[index]
                        });
                        index++;
                    }
                }
            }
        }
        finally {
            handle.close();
        }

        return linkMapEntries;
    }

    private async readElfHeader(fileHandle: fs.FileHandle) : Promise<void>
    {
        const headerBuffer = Buffer.alloc(6);
        await fileHandle.read(headerBuffer, 0, 6);
        let reader = new BufferReader(headerBuffer);

        const magic = reader.readUInt32BE();
        if (magic !== 0x7F454C46) {
            throw new Error("Header incorrect");
        }
        this.numBits = reader.readInt8() === 1 ? 32 : 64;
        this.endianess = reader.readInt8() === 1 ? Endianess.Little : Endianess.Big;

        const remainingHeaderBytes = this.numBits === 32 ? 46 : 58;
        let buffer = Buffer.alloc(remainingHeaderBytes);
        await fileHandle.read(buffer, 0, remainingHeaderBytes);
        reader = new BufferReader(buffer);

        const version = reader.readInt8();
        this.osabi = reader.readUInt8();
        this.abiversion = reader.readInt8();
        reader.skip(7);
        this.type = this.readUInt16(reader);
        this.machine = this.readUInt16(reader);
        const elfversion = this.readUInt32(reader);

        const entry = this.readNativeUInt(reader);
        this.phoff = this.readNativeUInt(reader);
        this.shoff = this.readNativeUInt(reader);
        const flags = this.readUInt32(reader);
        const ehsize = this.readUInt16(reader);
        const phentsize = this.readUInt16(reader);
        this.phnum = this.readUInt16(reader);
        this.shentsize = this.readUInt16(reader);
        this.shnum = this.readUInt16(reader);
        this.shstrndx = this.readUInt16(reader);
    }

    public async getBuildID(path: string) {
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);

            const sections = await this.readSections(handle);

            return sections.get(".note.gnu.build-id")?.subarray(16, 32).toString('hex');
        }
        finally {
            handle.close();
        }
    }

    async readSections(fileHandle: fs.FileHandle): Promise<Map<string, Buffer>>
    {
        if (this.shnum === 0) {
            return new Map<string, Buffer>();
        }

        const sectionSize = this.numBits === 32 ? 0x28 : 0x40;
        let buffer = Buffer.alloc(sectionSize);

        let elfSections: Section[] = [];
        for (let i = 0; i < this.shnum; i++) {
            await fileHandle.read(buffer, 0, sectionSize, Number(this.shoff) + i * sectionSize);
            const reader = new BufferReader(buffer);

            const nameOffset = this.readUInt32(reader);
            const type = this.readUInt32(reader);
            const flags = this.readNativeUInt(reader);
            const addr = this.readNativeUInt(reader);
            const offset = this.readNativeUInt(reader);
            const size = this.readNativeUInt(reader);
            const link = this.readUInt32(reader);
            const info = this.readUInt32(reader);
            const addralign = this.readNativeUInt(reader);
            const entsize = this.readNativeUInt(reader);
            elfSections.push({
                nameOffset: nameOffset,
                type: type,
                flags: flags,
                addr: addr,
                offset: offset,
                size: size,
                link: link,
                info: info,
                addralign: addralign,
                entsize: entsize
            });
        }

        const stringsection = elfSections[this.shstrndx];

        const stringBuffer = Buffer.alloc(Number(stringsection.size));
        await fileHandle.read(stringBuffer, 0, Number(stringsection.size), Number(stringsection.offset));

        let sections: Map<string, Buffer> = new Map<string, Buffer>();
        for (let section of elfSections) {
            const sectionBuffer = Buffer.alloc(Number(section.size));
            fileHandle.read(sectionBuffer, 0, sectionBuffer.length, Number(section.offset));
            const sectionName = readNullTerminatedString(stringBuffer, section.nameOffset);
            sections.set(sectionName, sectionBuffer);
        }

        return sections;
    }

    public async getInterp(path: string): Promise<string | undefined> {
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);
            const sections = await this.readSections(handle);
            const interpBuffer = sections.get(".interp");
            if (interpBuffer) {
                return readNullTerminatedString(interpBuffer, 0);
            } else {
                return undefined;
            }
        }
        finally {
            handle.close();
        }
    }

    public async hasDebugInfo(elfPath: string): Promise<boolean> {
        const handle = await fs.open(elfPath, "r");
        try {
            await this.readElfHeader(handle);
            const sections = await this.readSections(handle);
            const debugLinkSection = sections.get(".gnu_debuglink");
            if (debugLinkSection) {
                const debugLink = readNullTerminatedString(debugLinkSection,0);
                if (await fileExists(path.join(path.dirname(elfPath), debugLink))) {
                    return true;
                }
            }
            return [...sections.keys()].some(key => key.includes(".debug"));
        } catch {
            return false;
        }
        finally {
            handle.close();
        }
    }

    public async getNeededLibs(path: string): Promise<string[] | undefined> {
        const handle = await fs.open(path, "r");
        try {
            await this.readElfHeader(handle);
            const sections = await this.readSections(handle);

            const dynamicStringSection = sections.get(".dynstr");
            const dynamicSection = sections.get(".dynamic");

            if (!dynamicStringSection || !dynamicSection) {
                return undefined;
            }

            let libs: string[] = [];
            let dynamicReader = new BufferReader(dynamicSection);
            const dt_needed = 1;
            let dynType: number | bigint = -1;
            while (Number(dynType) !== 0) {
                dynType = this.readNativeUInt(dynamicReader);
                const val_ptr = this.readNativeUInt(dynamicReader);
                if (Number(dynType) === dt_needed) {
                    const soName = readNullTerminatedString(dynamicStringSection, Number(val_ptr));
                    libs.push(soName);
                }
            };

            return libs;
        }
        finally {
            handle.close();
        }
    }
}
