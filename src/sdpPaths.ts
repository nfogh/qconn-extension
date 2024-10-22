import { fdir } from 'fdir';
import * as path from 'path';
import * as outputChannel from './outputChannel';

let doneSearching: boolean = false;
let qnx70sdpPath: string | undefined = undefined;
let qnx71sdpPath: string | undefined = undefined;
let findSDPPathPromise: Promise<void>;

export function isDoneSearching() : boolean
{
    return doneSearching;
}

export async function getQNX70SDPPath() : Promise<string | undefined>
{
    await findSDPPathPromise;
    return qnx70sdpPath;
}

export async function getQNX71SDPPath() : Promise<string | undefined>
{
    await findSDPPathPromise;
    return qnx71sdpPath;
}

export async function getGDBPath() : Promise<string | undefined>
{
    await findSDPPathPromise;
    if (qnx70sdpPath) {
        // Prefer gdb from qnx 7.0, as it doesn't need QNX env variables set
        if (process.platform === 'linux') {
            return path.join(qnx70sdpPath, "host", "linux", "x86_64", "usr", "bin", "ntox86_64-gdb");
        } else if (process.platform === 'win32') {
            return path.join(qnx70sdpPath, "host", "win64", "x86_64", "usr", "bin", "ntox86_64-gdb.exe");
        }
    } else if (qnx71sdpPath) {
        if (process.platform === 'linux') {
            return path.join(qnx71sdpPath, "host", "linux", "x86_64", "usr", "bin", "ntox86_64-gdb");
        } else if (process.platform === 'win32') {
            return path.join(qnx71sdpPath, "host", "win64", "x86_64", "usr", "bin", "ntox86_64-gdb.exe");
        }
    }
    return undefined;
}

export function startFindSDPPaths(searchPaths: string[])
{
    doneSearching = false;
    findSDPPathPromise = findSDPPaths(searchPaths);
}

async function findSDPPaths(searchPaths: string[]) : Promise<void>
{
    // Search for ntox86_64-gcc. This only works for linux
    let gccExecutable: string = "ntox86_64-gcc";

    outputChannel.log(`Looking for ${gccExecutable} in {${searchPaths}}`);

    const searches = searchPaths.map(searchPath => new fdir()
        .withBasePath()
        .filter(p => p.includes(gccExecutable))
        .crawl(searchPath).withPromise());

    const searchResults = (await Promise.all(searches)).flat();

    const qnx70results = searchResults.filter(p => p.includes("ntox86_64-gcc-5.4.0"));
    const qnx71results = searchResults.filter(p => p.includes("ntox86_64-gcc-8.3.0"));

    if (qnx70results.length > 0) {
        qnx70sdpPath = path.join(path.dirname(qnx70results[0]), '..', '..', '..', '..', '..');
        outputChannel.log(`QNX7.0 is in ${qnx70sdpPath}`);
    }
    if (qnx71results.length > 0) {
        qnx71sdpPath = path.join(path.dirname(qnx71results[0]), '..', '..', '..', '..', '..');
        outputChannel.log(`QNX7.1 is in ${qnx71sdpPath}`);
    }

    if (!qnx70sdpPath && !qnx71sdpPath) {
        outputChannel.log(`Unable to find SDP in {${searchPaths}}`);
    }
    doneSearching = true;
}