export type Entity = number;

export class World {
  private nextId: Entity = 1;
  private stores = new Map<string, Map<Entity, unknown>>();
  private alive = new Set<Entity>();

  create(): Entity {
    const id = this.nextId++;
    this.alive.add(id);
    return id;
  }

  destroy(e: Entity) {
    this.alive.delete(e);
    for (const store of this.stores.values()) store.delete(e);
  }

  add<T>(e: Entity, name: string, component: T) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    store.set(e, component);
  }

  get<T>(e: Entity, name: string): T | undefined {
    return this.stores.get(name)?.get(e) as T | undefined;
  }

  has(e: Entity, name: string): boolean {
    return this.stores.get(name)?.has(e) ?? false;
  }

  remove(e: Entity, name: string) {
    this.stores.get(name)?.delete(e);
  }

  query(...names: string[]): Entity[] {
    const out: Entity[] = [];
    for (const e of this.alive) {
      let ok = true;
      for (const n of names) {
        if (!this.stores.get(n)?.has(e)) { ok = false; break; }
      }
      if (ok) out.push(e);
    }
    return out;
  }

  count(): number {
    return this.alive.size;
  }
}
