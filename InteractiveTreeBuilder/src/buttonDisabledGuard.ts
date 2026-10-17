// arborenumConstrainedCompletion.ts observes disabled-state changes so its button
// can mirror the Optimal button. Avoid emitting a disabled-attribute mutation when
// a caller writes the value the button already has; otherwise the observer can
// trigger itself indefinitely after a completion disables the toolbar buttons.
const descriptor = Object.getOwnPropertyDescriptor(
  HTMLButtonElement.prototype,
  'disabled',
);

if (descriptor?.get && descriptor?.set) {
  Object.defineProperty(HTMLButtonElement.prototype, 'disabled', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(this: HTMLButtonElement, value: boolean) {
      const next = Boolean(value);
      if (descriptor.get!.call(this) === next) return;
      descriptor.set!.call(this, next);
    },
  });
}
