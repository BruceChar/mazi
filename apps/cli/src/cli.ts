import { main } from './main';

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error: unknown) => {
        process.stderr.write(`cli error: ${String(error)}\n`);
        process.exitCode = 1;
    });
