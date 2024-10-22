//import * as elfParser from '../elfParser';
import * as debugResolvers from '../debugResolvers';

async function main(): Promise<void> {

if (process.argv.length !== 3) {
    console.log(`Usage: ${process.argv[1]}  elfFile`);
    return;
}

const elfFilePath = process.argv[2];

console.log(`Parsing ${elfFilePath}\n`);

    const dependencies = await debugResolvers.getDependenciesOfElf(elfFilePath);
    if (dependencies) {
        const resolvedDependencies = await debugResolvers.resolveDependencies(dependencies, [""]);
        console.log(`Resolved dependencies\n${resolvedDependencies}`);
    } else {
        console.log(`Could not find dependencies in ${elfFilePath}`);
    }
}

if (require.main === module) {
    main();
}