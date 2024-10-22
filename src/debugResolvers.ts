import { ElfFileReader, Type } from './elfParser';
import { fdir } from 'fdir';
import * as path from 'path';

interface Dependency {
    soName: string;
    buildid?: string;
}

export async function getDependenciesOfElf(elfFilePath: string): Promise<Dependency[] | undefined> {
    const elfFileReader = new ElfFileReader();
    await elfFileReader.getHeaders(elfFilePath);

    const type = elfFileReader.type;
    if (type === Type.Core) {
        const linkMaps = await new ElfFileReader().getLinkMap(elfFilePath);
        return linkMaps.map(map => { return { soName: map.soName, buildid: map.buildid }; });
    } else if ((type === Type.Exec) || (type === Type.Dyn)) {
        const neededLibs = await new ElfFileReader().getNeededLibs(elfFilePath);
        return neededLibs?.map(lib => { return { soName: lib }; });
    }
}

export async function findFilesInPaths(searchPaths: string[], fileNames: string[]): Promise<string[]> {
    const searches = searchPaths.map(searchPath => new fdir()
        .withBasePath()
        .filter(p => fileNames.includes(path.basename(p)))
        .crawl(searchPath).withPromise());

    const searchResults = await Promise.all(searches);

    return searchResults.flat();
}

function makeBaseNameToPathsMap(paths: string[]): Map<string, string[]> {
    let candidateMap = new Map<string, string[]>();
    for (const candidatePath of paths) {
        const soName = path.basename(candidatePath);
        let mapEntry = candidateMap.get(soName);
        if (!mapEntry) {
            candidateMap.set(soName, [candidatePath]);
        } else {
            mapEntry.push(candidatePath);
        }
    }
    return candidateMap;
}

async function isElfExecutableQNX(elfPath: string): Promise<boolean> {
    try {
        const ELFOSABI_LINUX = 3;
        const elfFileReader = new ElfFileReader();
        await elfFileReader.getHeaders(elfPath);
        if (elfFileReader.osabi === ELFOSABI_LINUX) {
            return false;
        }

        const interpreter = await new ElfFileReader().getInterp(elfPath);
        return interpreter ? interpreter.includes("qnx") : true;
    } catch {
        return false;
    }
}

async function getBuildIDOf(elfPath: string): Promise<string | undefined> {
    return new ElfFileReader().getBuildID(elfPath);
}

async function hasDebugInfo(elfPath: string): Promise<boolean> {
    return new ElfFileReader().hasDebugInfo(elfPath);
}

export async function resolveDependencies(dependencies: Dependency[], searchPaths: string[]): Promise<string[]> {
    // find all files matching the dependencies name
    const allCandidatePaths = await findFilesInPaths(searchPaths, dependencies.map(dependency => dependency.soName));

    // Build map soName => candidates
    const soNameToCandidatePaths = makeBaseNameToPathsMap(allCandidatePaths);

    // Filter out candidates that are not QNX
    let qnxOnlyCandidatePaths = new Map<string, string[]>();
    for (let [soName, candidatePaths] of soNameToCandidatePaths) {
        // To filter with async: Map to promises, await all, and map back
        const qnxOrNot = await Promise.all(candidatePaths.map(async candidatePath => { return { candidatePath: candidatePath, isQNX: await isElfExecutableQNX(candidatePath) }; }));
        qnxOnlyCandidatePaths.set(soName, qnxOrNot.filter(path => path.isQNX).map(path => path.candidatePath));
    }

    // Find build IDs of all dependencies
    let dependencyBuildIDs = new Map<string, string>();
    for (const dependency of dependencies) {
        if (dependency.buildid) {
            dependencyBuildIDs.set(dependency.soName, dependency.buildid);
        }
    }

    // Now sort candidates according to the following:
    // 1. Whether they include debug info
    // 2. Whether they have a matching build-id
    // 3. Sort by which search path they were found in (first search path first)
    // so we get the ones with debug info and a matching build-id first
    let bestCandidates: string[] = [];
    for (let [soName, candidatePaths] of qnxOnlyCandidatePaths) {
        const aFirst = -1;
        const bFirst = 1;
        // To sort with async: Map to promises, await all, and map back
        const dependenciesWithBuildIDs = await Promise.all(candidatePaths.map(async candidatePath => { return { candidatePath: candidatePath, buildId: await getBuildIDOf(candidatePath), hasDebugInfo: await hasDebugInfo(candidatePath) }; }));
        const sortedCandidates = dependenciesWithBuildIDs.toSorted((a, b) => {
            if (a.hasDebugInfo === b.hasDebugInfo) {
                const dependencyBuildID = dependencyBuildIDs.get(path.basename(a.candidatePath));
                if (a.buildId && dependencyBuildID) {
                    return (a.buildId === dependencyBuildID) ? aFirst : bFirst;
                } else {
                    // None has build ID - sort by searchpath
                    const indexOfA = searchPaths.findIndex(val => a.candidatePath.startsWith(val));
                    const indexOfB = searchPaths.findIndex(val => b.candidatePath.startsWith(val));
                    return indexOfA < indexOfB ? aFirst : bFirst;
                }
            }
            return a.hasDebugInfo ? aFirst : bFirst;
        }).map(path => path.candidatePath);
        if (sortedCandidates.length > 0) {
            bestCandidates.push(sortedCandidates[0]);
        }
    }
 
    return bestCandidates;
}