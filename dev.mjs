// npm run dev: serves the site locally and prints one master link to every POS view.
const PORT = process.env.PORT || '8765';
process.argv[2] = new URL('.', import.meta.url).pathname;
process.argv[3] = PORT;
await import('../../.claude/serve.mjs');
console.log(`\nMaster link (Kasir, HR, Back office): http://localhost:${PORT}/member/_dev.html\n`);
