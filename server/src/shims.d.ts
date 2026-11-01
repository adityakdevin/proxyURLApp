// Ambient declarations for dependencies that ship no TypeScript types.

declare module 'nspell' {
  interface Nspell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }
  function nspell(dict: { aff: Buffer; dic: Buffer }): Nspell;
  export default nspell;
}
