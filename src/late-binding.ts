// Dependencies bound late, in two steps, for extensions built before the session exists
// (SL-006 design § Components and boundaries). Read through a getter at use, never captured.

/** The getter and its two binding steps; reading before both throws. */
export interface LateBinding<Early extends object, Late extends object> {
  readonly deps: () => Early & Late;
  bindEarly(early: Early): void;
  bindLate(late: Late): void;
}

/** A two-step binding; `name` names the binding in a too-early read's error. */
export const lateBinding = <Early extends object, Late extends object>(
  name: string,
): LateBinding<Early, Late> => {
  let early: Early | undefined;
  let late: Late | undefined;
  return {
    deps: (): Early & Late => {
      if (early === undefined || late === undefined) {
        throw new Error(`${name} dependencies read before the daemon bound them`);
      }
      return { ...early, ...late };
    },
    bindEarly: (value): void => {
      early = value;
    },
    bindLate: (value): void => {
      late = value;
    },
  };
};
