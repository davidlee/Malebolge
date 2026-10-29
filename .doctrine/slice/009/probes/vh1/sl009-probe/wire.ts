// Stand-in for pi-bridge/wire.ts: type annotations node must strip (EX-10).
export interface Capped {
  readonly text: string;
  readonly truncated: boolean;
}
export const capHeadTail = (text: string, max: number): Capped =>
  text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max / 2)}…${text.slice(-max / 2)}`, truncated: true };
