declare module 'jsdom' {
  export class JSDOM {
    constructor(markup?: string, options?: Record<string, unknown>)
    readonly window: Window & typeof globalThis
  }
}
