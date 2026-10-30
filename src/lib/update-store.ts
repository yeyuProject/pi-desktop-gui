import type { UpdateState } from '../../shared/app-update';

/** Progress changes notify the update surfaces without rendering the workbench. */
export class UpdateStore {
  private value?: UpdateState;
  private listeners = new Set<() => void>();
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(value: UpdateState) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
