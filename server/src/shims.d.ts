// Ambient declarations for dependencies that ship no TypeScript types.

declare module 'dictionary-en' {
  type DictCallback = (err: Error | null, dict: { aff: Buffer; dic: Buffer }) => void;
  const load: (callback: DictCallback) => void;
  export default load;
}

declare module 'nspell' {
  interface Nspell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }
  function nspell(dict: { aff: Buffer; dic: Buffer }): Nspell;
  export default nspell;
}

// Import the inner implementation to bypass pdf-parse's import-time "debug mode" file read.
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdf(dataBuffer: Buffer): Promise<{ text: string; numpages: number }>;
  export default pdf;
}
