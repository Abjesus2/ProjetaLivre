// Worker embutido no próprio HTML (build de arquivo único, que abre via file://).
import ParseWorker from './parse.worker.ts?worker&inline';
export const createParseWorker = () => new ParseWorker();
