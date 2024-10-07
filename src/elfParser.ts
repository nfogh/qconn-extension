import * as fs from 'fs/promises';
import { BufferReader } from 'node-bufferreader';

enum Endianess {
    Little,
    Big
}

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
    } while (c !== 0);

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

    public async getLinkMap(path: string): Promise<LinkMapEntry[]> {
        let linkMapEntries: LinkMapEntry[] = [];
        const handle = await fs.open(path, "r");
        try {
            const headerBuffer = Buffer.alloc(6);
            await handle.read(headerBuffer, 0, 6);
            let reader = new BufferReader(headerBuffer);

            const magic = reader.readUInt32BE();
            if (magic !== 0x7F454C46) {
                throw new Error("Header incorrect");
            }
            this.numBits = reader.readInt8() === 1 ? 32 : 64;
            this.endianess = reader.readInt8() === 1 ? Endianess.Little : Endianess.Big;

            const remainingHeaderBytes = this.numBits === 32 ? 46 : 58;
            let buffer = Buffer.alloc(remainingHeaderBytes);
            await handle.read(buffer, 0, remainingHeaderBytes);
            reader = new BufferReader(buffer);

            const version = reader.readInt8();
            const osabi = reader.readUInt8();
            const abiversion = reader.readInt8();
            reader.skip(7);
            const type = this.readUInt16(reader);
            const machine = this.readUInt16(reader);
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

            const headerSize = this.numBits === 32 ? 0x20 : 0x38;
            buffer = Buffer.alloc(headerSize);

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

    public async getBuildID(path: string) {
        const handle = await fs.open(path, "r");
        try {
            const headerBuffer = Buffer.alloc(6);
            await handle.read(headerBuffer, 0, 6);
            let reader = new BufferReader(headerBuffer);

            const magic = reader.readUInt32BE();
            if (magic !== 0x7F454C46) {
                throw new Error("Header incorrect");
            }
            this.numBits = reader.readInt8() === 1 ? 32 : 64;
            this.endianess = reader.readInt8() === 1 ? Endianess.Little : Endianess.Big;

            const remainingHeaderBytes = this.numBits === 32 ? 46 : 58;
            let buffer = Buffer.alloc(remainingHeaderBytes);
            await handle.read(buffer, 0, remainingHeaderBytes);
            reader = new BufferReader(buffer);

            const version = reader.readInt8();
            const osabi = reader.readUInt8();
            const abiversion = reader.readInt8();
            reader.skip(7);
            const type = this.readUInt16(reader);
            const machine = this.readUInt16(reader);
            const elfversion = this.readUInt32(reader);

            const entry = this.readNativeUInt(reader);
            const phoff = this.readNativeUInt(reader);
            this.shoff = this.readNativeUInt(reader);
            const flags = this.readUInt32(reader);
            const ehsize = this.readUInt16(reader);
            const phentsize = this.readUInt16(reader);
            const phnum = this.readUInt16(reader);
            this.shentsize = this.readUInt16(reader);
            this.shnum = this.readUInt16(reader);
            this.shstrndx = this.readUInt16(reader);

            const sectionSize = this.numBits === 32 ? 0x28 : 0x40;
            buffer = Buffer.alloc(sectionSize);

            let elfSections: Section[] = [];
            for (let i = 0; i < this.shnum; i++) {
                await handle.read(buffer, 0, sectionSize, Number(this.shoff) + i * sectionSize);
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
            await handle.read(stringBuffer, 0, Number(stringsection.size), Number(stringsection.offset));

            let sections: Map<string, Buffer> = new Map<string, Buffer>();
            for (let section of elfSections) {
                const sectionBuffer = Buffer.alloc(Number(section.size));
                handle.read(sectionBuffer, 0, sectionBuffer.length, Number(section.offset));
                const sectionName = readNullTerminatedString(stringBuffer, section.nameOffset);
                sections.set(sectionName, sectionBuffer);
            }

            return sections.get(".note.gnu.build-id")?.subarray(16, 32).toString('hex');
        }
        finally {
            handle.close();
        }
    }

    public async getNeededLibs(path: string): Promise<string[] | undefined> {
        const handle = await fs.open(path, "r");
        try {
            const headerBuffer = Buffer.alloc(6);
            await handle.read(headerBuffer, 0, 6);
            let reader = new BufferReader(headerBuffer);

            const magic = reader.readUInt32BE();
            if (magic !== 0x7F454C46) {
                throw new Error("Header incorrect");
            }
            this.numBits = reader.readInt8() === 1 ? 32 : 64;
            this.endianess = reader.readInt8() === 1 ? Endianess.Little : Endianess.Big;

            const remainingHeaderBytes = this.numBits === 32 ? 46 : 58;
            let buffer = Buffer.alloc(remainingHeaderBytes);
            await handle.read(buffer, 0, remainingHeaderBytes);
            reader = new BufferReader(buffer);

            const version = reader.readInt8();
            const osabi = reader.readUInt8();
            const abiversion = reader.readInt8();
            reader.skip(7);
            const type = this.readUInt16(reader);
            const machine = this.readUInt16(reader);
            const elfversion = this.readUInt32(reader);

            const entry = this.readNativeUInt(reader);
            const phoff = this.readNativeUInt(reader);
            this.shoff = this.readNativeUInt(reader);
            const flags = this.readUInt32(reader);
            const ehsize = this.readUInt16(reader);
            const phentsize = this.readUInt16(reader);
            const phnum = this.readUInt16(reader);
            this.shentsize = this.readUInt16(reader);
            this.shnum = this.readUInt16(reader);
            this.shstrndx = this.readUInt16(reader);

            const sectionSize = this.numBits === 32 ? 0x28 : 0x40;
            buffer = Buffer.alloc(sectionSize);

            let elfSections: Section[] = [];
            for (let i = 0; i < this.shnum; i++) {
                await handle.read(buffer, 0, sectionSize, Number(this.shoff) + i * sectionSize);
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
            await handle.read(stringBuffer, 0, Number(stringsection.size), Number(stringsection.offset));

            let sections: Map<string, Buffer> = new Map<string, Buffer>();
            for (let section of elfSections) {
                const sectionBuffer = Buffer.alloc(Number(section.size));
                handle.read(sectionBuffer, 0, sectionBuffer.length, Number(section.offset));
                const sectionName = readNullTerminatedString(stringBuffer, section.nameOffset);
                sections.set(sectionName, sectionBuffer);
            }

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
