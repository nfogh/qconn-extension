import * as elfParser from '../elfParser';

async function main(): Promise<void> {

if (process.argv.length !== 3) {
    console.log(`Usage: ${process.argv[1]}  elfFile`);
    return;
}

const elfFilePath = process.argv[2];

console.log(`Parsing ${elfFilePath}\n`);

const elfFileReader = new elfParser.ElfFileReader();
console.log(await elfFileReader.getNeededLibs(elfFilePath));

}

if (require.main === module) {
    main();
}