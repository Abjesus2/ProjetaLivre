// Worker como arquivo separado (build normal do site).
export const createParseWorker = () => new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
