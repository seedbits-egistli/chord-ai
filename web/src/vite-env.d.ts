/// <reference types="vite/client" />

declare module '@tombatossals/chords-db/lib/guitar.json' {
  const value: unknown;
  export default value;
}

declare module '@tombatossals/chords-db/lib/ukulele.json' {
  const value: unknown;
  export default value;
}

declare module 'abcjs' {
  const abcjs: {
    renderAbc: (
      element: string | HTMLElement,
      abc: string,
      options?: Record<string, unknown>,
    ) => unknown;
  };
  export default abcjs;
}
